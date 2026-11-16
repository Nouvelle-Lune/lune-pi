import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SessionFileRef } from "../../src/adapters/types.ts";
import { defaultConfig, type MemoryConfig } from "../../src/core/config.ts";
import { memoryPaths, type MemoryPaths } from "../../src/core/paths.ts";
import type { Harness } from "../../src/core/types.ts";
import { Importer } from "../../src/ingest/importer.ts";
import { ProjectResolver } from "../../src/projects/resolver.ts";
import { Store } from "../../src/store/db.ts";

export function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), "lune-memory-test-"));
}

export function removeDir(path: string): void {
    rmSync(path, { recursive: true, force: true });
}

/** Serialize records as JSONL text. */
export function jsonl(records: readonly unknown[]): string {
    return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function writeText(path: string, content: string | Buffer, mtimeSeconds?: number): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds);
}

export function fileRef(harness: Harness, path: string): SessionFileRef {
    const stat = statSync(path);
    return { harness, path, size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Temporary memory home, native session roots, store and importer. */
export interface IngestEnv {
    home: string;
    /** Working directory that synthetic sessions claim. It is not a git repo. */
    cwd: string;
    roots: Record<Harness, string>;
    paths: MemoryPaths;
    config: MemoryConfig;
    store: Store;
    importer: Importer;
    /** Current fake clock of the importer in epoch milliseconds. */
    clock: { now: number };
    cleanup(): void;
}

export function createIngestEnv(
    options: { historyDays?: number; retentionDays?: number; now?: number } = {},
): IngestEnv {
    const home = makeTempDir();
    const roots: Record<Harness, string> = {
        pi: join(home, "native", "pi"),
        claude: join(home, "native", "claude"),
        codex: join(home, "native", "codex"),
    };
    const cwd = join(home, "work");
    mkdirSync(cwd, { recursive: true });
    const config = defaultConfig(home, {});
    for (const harness of Object.keys(roots) as Harness[]) {
        config.harnesses[harness] = { enabled: true, root: roots[harness] };
    }
    config.dreaming.historyDays = options.historyDays ?? 0;
    config.retentionDays = options.retentionDays ?? 0;
    const paths = memoryPaths(join(home, "memory"));
    const store = Store.open(paths.db);
    const clock = { now: options.now ?? Date.now() };
    const importer = new Importer(store, paths, config, new ProjectResolver(store), {
        now: () => clock.now,
    });
    return {
        home,
        cwd,
        roots,
        paths,
        config,
        store,
        importer,
        clock,
        cleanup() {
            store.close();
            removeDir(home);
        },
    };
}

// Synthetic transcript builders, one per harness format.

export function piHeader(id: string, cwd: string, timestamp = "2026-01-01T00:00:00.000Z") {
    return { type: "session", version: 3, id, timestamp, cwd };
}

export function piMessage(
    id: string,
    parentId: string | null,
    role: "user" | "assistant",
    content: unknown,
    timestamp = "2026-01-01T00:00:01.000Z",
) {
    return { type: "message", id, parentId, timestamp, message: { role, content } };
}

export function claudeRecord(
    sessionId: string,
    uuid: string,
    parentUuid: string | null,
    role: "user" | "assistant",
    content: unknown,
    extra: Record<string, unknown> = {},
) {
    return {
        type: role,
        uuid,
        parentUuid,
        sessionId,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role, content },
        ...extra,
    };
}

export function codexMeta(id: string, cwd: string, extra: Record<string, unknown> = {}) {
    return {
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id, cwd, ...extra },
    };
}

export function codexMessage(role: "user" | "assistant", text: string, timestamp?: string) {
    return {
        timestamp: timestamp ?? "2026-01-01T00:00:01.000Z",
        type: "response_item",
        payload: {
            type: "message",
            role,
            content: [{ type: role === "user" ? "input_text" : "output_text", text }],
        },
    };
}
