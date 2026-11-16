import { readFileSync, rmSync } from "node:fs";

import type { MemoryPaths } from "../core/paths.ts";
import { pidAlive, writeFileAtomic } from "../core/util.ts";

/** Connection data of a running daemon. The file is readable only by the owner. */
export interface DaemonInfo {
    pid: number;
    port: number;
    token: string;
    url: string;
    startedAt: string;
    version: string;
}

/** Connection data of the running daemon, or null when no live daemon wrote it. */
export function readDaemonInfo(paths: MemoryPaths): DaemonInfo | null {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(paths.daemon, "utf8"));
    } catch {
        return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const info = raw as Partial<DaemonInfo>;
    if (
        typeof info.pid !== "number" ||
        typeof info.port !== "number" ||
        typeof info.token !== "string" ||
        typeof info.url !== "string" ||
        !info.token
    ) {
        return null;
    }
    if (!pidAlive(info.pid)) return null;
    return {
        pid: info.pid,
        port: info.port,
        token: info.token,
        url: info.url,
        startedAt: typeof info.startedAt === "string" ? info.startedAt : "",
        version: typeof info.version === "string" ? info.version : "0.0.0",
    };
}

/** Process id that holds daemon.lock, when that process runs. */
export function lockHolder(paths: MemoryPaths): number | null {
    try {
        const pid = Number.parseInt(readFileSync(paths.lock, "utf8"), 10);
        return pidAlive(pid) ? pid : null;
    } catch {
        return null;
    }
}

/** Write daemon.json. Only the owner can read it, because it holds the token. */
export function writeDaemonInfo(paths: MemoryPaths, info: DaemonInfo): void {
    writeFileAtomic(paths.daemon, `${JSON.stringify(info, null, 4)}\n`, 0o600);
}

/** Remove daemon.json when the daemon with `pid` wrote it. */
export function removeDaemonInfo(paths: MemoryPaths, pid: number): void {
    try {
        const info = JSON.parse(readFileSync(paths.daemon, "utf8")) as Partial<DaemonInfo>;
        if (info.pid === pid) rmSync(paths.daemon, { force: true });
    } catch {
        // The file is gone or another daemon wrote it.
    }
}
