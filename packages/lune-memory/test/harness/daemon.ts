import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { FastifyInstance } from "fastify";

import { createApp, type AppOptions } from "../../src/daemon/server.ts";
import { MemoryService } from "../../src/service.ts";

export const TEST_TOKEN = "test-token-not-real";

const ENV_KEYS = ["LUNE_MEMORY_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

export interface TestEnv {
    /** Root of the temp tree. */
    root: string;
    home: string;
    /** Make a new empty folder inside the temp tree. */
    folder(name: string): string;
    cleanup(): void;
}

/** A temp tree with the home variables of the harnesses pointed into it. Call cleanup() after. */
export function createTestEnv(): TestEnv {
    // Real path, because project registration compares against the resolved folder.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lune-memory-test-")));
    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    process.env.LUNE_MEMORY_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    process.env.CODEX_HOME = join(root, "codex");
    return {
        root,
        home,
        folder(name: string): string {
            const path = join(root, name);
            mkdirSync(path, { recursive: true });
            return path;
        },
        cleanup(): void {
            for (const [key, value] of saved) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            rmSync(root, { recursive: true, force: true });
        },
    };
}

/** Parsed JSON of a response. Tests assert on its shape, so it stays loose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ApiResponse {
    status: number;
    headers: Record<string, unknown>;
    body: Json;
    text: string;
}

export interface TestDaemon {
    env: TestEnv;
    service: MemoryService;
    app: FastifyInstance;
    uiDir: URL;
    /** Authorized JSON request. Extra headers can override the defaults. */
    api(
        method: "GET" | "POST" | "PUT",
        url: string,
        body?: unknown,
        headers?: Record<string, string>,
    ): Promise<ApiResponse>;
    close(): Promise<void>;
}

/** Real MemoryService on a temp home behind the real Fastify app. No port is opened. */
export async function openTestDaemon(options: Partial<AppOptions> = {}): Promise<TestDaemon> {
    const env = createTestEnv();
    const uiPath = env.folder("ui");
    writeFileSync(join(uiPath, "index.html"), "<!doctype html><title>stub</title>");
    writeFileSync(join(uiPath, "app.js"), "console.log('stub');");
    writeFileSync(join(uiPath, "app.css"), "body{}");
    const uiDir = pathToFileURL(`${uiPath}/`);
    const service = MemoryService.open(env.home);
    const app = createApp(service, {
        token: TEST_TOKEN,
        version: "0.0.0-test",
        uiDir,
        ...options,
    });
    await app.ready();
    return {
        env,
        service,
        app,
        uiDir,
        async api(method, url, body, headers = {}) {
            const response = await app.inject({
                method,
                url,
                headers: {
                    host: "127.0.0.1",
                    authorization: `Bearer ${TEST_TOKEN}`,
                    ...(body !== undefined ? { "content-type": "application/json" } : {}),
                    ...headers,
                },
                ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
            });
            let parsed: Json = null;
            try {
                parsed = JSON.parse(response.body);
            } catch {
                // Not JSON (for example the UI files).
            }
            return {
                status: response.statusCode,
                headers: response.headers,
                body: parsed,
                text: response.body,
            };
        },
        async close(): Promise<void> {
            try {
                await app.close();
            } finally {
                service.close();
                env.cleanup();
            }
        },
    };
}
