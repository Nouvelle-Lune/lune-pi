import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lockHolder, readDaemonInfo, type DaemonInfo } from "../api/daemon-info.ts";
import { loadConfig } from "../core/config.ts";
import type { MemoryPaths } from "../core/paths.ts";

/** Default timeout of one daemon request. A Dreaming pass gives its own, longer timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Time to wait for a started daemon to write daemon.json. */
const START_WAIT_MS = 6_000;

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** The daemon does not listen. The caller can use the local service. */
export class DaemonUnavailableError extends Error {
    constructor(message = "The lune-memory daemon does not run") {
        super(message);
        this.name = "DaemonUnavailableError";
    }
}

/** The daemon answered with an error status. */
export class DaemonRequestError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "DaemonRequestError";
        this.status = status;
    }
}

function connectionRefused(error: unknown, seen = new Set<unknown>()): boolean {
    if (!error || typeof error !== "object" || seen.has(error)) return false;
    seen.add(error);
    const record = error as { code?: unknown; cause?: unknown; errors?: unknown };
    if (record.code === "ECONNREFUSED") return true;
    if (connectionRefused(record.cause, seen)) return true;
    return (
        Array.isArray(record.errors) &&
        record.errors.some((entry) => connectionRefused(entry, seen))
    );
}

/**
 * Send one request to the daemon. A refused connection gives DaemonUnavailableError. Other
 * network errors and timeouts are not changed, because the daemon can have done the work.
 */
export async function daemonRequest<T>(
    info: DaemonInfo,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`${info.url}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${info.token}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (connectionRefused(error)) throw new DaemonUnavailableError();
        throw error;
    }
    const text = await response.text();
    let data: unknown = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }
    if (!response.ok) {
        const message =
            data &&
            typeof data === "object" &&
            typeof (data as { error?: unknown }).error === "string"
                ? (data as { error: string }).error
                : `The daemon answered ${response.status}`;
        throw new DaemonRequestError(message, response.status);
    }
    return data as T;
}

/** Path of the CLI file next to this file: cli.ts from source, cli.js from dist. */
export function cliPath(): string {
    const self = fileURLToPath(import.meta.url);
    return join(self, "..", "..", self.endsWith(".ts") ? "cli.ts" : "cli.js");
}

function openDaemonLog(paths: MemoryPaths): number {
    mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
    const file = join(paths.logs, "daemon.log");
    try {
        if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
    } catch {
        // No log yet.
    }
    return openSync(file, "a", 0o600);
}

/** Start `lune-memory daemon run` as a detached process. Its output goes to logs/daemon.log. */
export function spawnDaemon(paths: MemoryPaths): number | null {
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    const log = openDaemonLog(paths);
    try {
        const child = spawn(
            process.execPath,
            [
                "--disable-warning=ExperimentalWarning",
                cliPath(),
                "daemon",
                "run",
                "--home",
                paths.home,
            ],
            {
                detached: true,
                stdio: ["ignore", log, log],
                env: { ...process.env, LUNE_MEMORY_HOME: paths.home },
                windowsHide: true,
            },
        );
        child.on("error", () => {});
        child.unref();
        return child.pid ?? null;
    } finally {
        closeSync(log);
    }
}

/** Wait until a live daemon wrote daemon.json, at most `timeoutMs`. */
export async function waitForDaemon(
    paths: MemoryPaths,
    timeoutMs: number = START_WAIT_MS,
): Promise<DaemonInfo | null> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const info = readDaemonInfo(paths);
        if (info) return info;
        if (Date.now() >= end) return null;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/**
 * Connection data of a running daemon. When none runs and auto start is on, start one and wait
 * for it. It returns null when no daemon is available.
 */
export async function ensureDaemon(
    paths: MemoryPaths,
    options: { autoStart?: boolean; timeoutMs?: number } = {},
): Promise<DaemonInfo | null> {
    const running = readDaemonInfo(paths);
    if (running) return running;
    // A process holds the lock: a daemon starts now or stops now.
    if (lockHolder(paths) !== null) return waitForDaemon(paths, options.timeoutMs);
    const autoStart = options.autoStart ?? loadConfig(paths.config).autoStart;
    if (!autoStart) return null;
    spawnDaemon(paths);
    return waitForDaemon(paths, options.timeoutMs);
}
