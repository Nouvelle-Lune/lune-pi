import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { EventRole, Harness, Item, SessionRow } from "../../src/core/types.ts";
import { newId, nowIso, sha256 } from "../../src/core/util.ts";
import type { MemoryService } from "../../src/service.ts";
import { bit, type Store } from "../../src/store/db.ts";
import { finishRun, putItem, putSession, recordHistory, startRun } from "../../src/store/rows.ts";

const ENV_KEYS = ["LUNE_MEMORY_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

/** Runs git with no user or system configuration, so a test repository is self-contained. */
export function git(cwd: string, ...args: string[]): string {
    return execFileSync(
        "git",
        [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            ...args,
        ],
        {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        },
    ).trim();
}

/** A repository with one commit. Returns the real path of the work tree. */
export function createRepo(dir: string, options: { remote?: string } = {}): string {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "initial");
    if (options.remote) git(dir, "remote", "add", "origin", options.remote);
    return realpathSync(dir);
}

export interface PiMessage {
    role: "user" | "assistant";
    text: string;
}

export interface PiSessionInput {
    id: string;
    cwd: string;
    messages: PiMessage[];
    /** Folder below the Pi sessions root. Defaults to a name derived from the cwd. */
    folder?: string;
}

export interface MemoryEnv {
    /** Real path of the temp root that holds everything below. */
    root: string;
    home: string;
    piRoot: string;
    service: MemoryService;
    store: Store;
    /** Make a new empty folder below the root and return its real path. */
    folder(name: string): string;
    /** Write a Pi session file. Returns its path. */
    writePiSession(input: PiSessionInput): string;
    /** Import every enabled harness (only Pi). */
    importNow(): ReturnType<MemoryService["importNow"]>;
    cleanup(): void;
}

/**
 * A MemoryService on a temp home with Pi import enabled. The environment variables that move
 * the lune-memory, Claude Code and Codex roots point into the temp root until `cleanup`.
 */
export async function createMemoryEnv(options: { now?: () => number } = {}): Promise<MemoryEnv> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lune-memory-test-")));
    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    const home = join(root, "home");
    process.env.LUNE_MEMORY_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    process.env.CODEX_HOME = join(root, "codex");
    const piRoot = join(root, "pi-sessions");
    mkdirSync(piRoot, { recursive: true });

    // Loaded here so that unit tests can import the other helpers without the service.
    const { MemoryService: Service } = await import("../../src/service.ts");
    const service = Service.open(home, options.now ? { now: options.now } : {});
    service.setConfig({ harnesses: { pi: { enabled: true, root: piRoot } } });
    let closed = false;

    return {
        root,
        home,
        piRoot,
        service,
        store: service.store,
        folder(name) {
            const dir = join(root, name);
            mkdirSync(dir, { recursive: true });
            return realpathSync(dir);
        },
        writePiSession(input) {
            const folder = input.folder ?? input.cwd.replace(/[^A-Za-z0-9]+/gu, "-");
            const path = join(piRoot, folder, `${input.id}.jsonl`);
            mkdirSync(dirname(path), { recursive: true });
            const at = Date.now();
            const lines: unknown[] = [
                {
                    type: "session",
                    version: 3,
                    id: input.id,
                    timestamp: new Date(at).toISOString(),
                    cwd: input.cwd,
                },
            ];
            let parent: string | null = null;
            input.messages.forEach((message, index) => {
                const id = `${input.id}-e${index}`;
                lines.push({
                    type: "message",
                    id,
                    parentId: parent,
                    timestamp: new Date(at + index + 1).toISOString(),
                    message:
                        message.role === "user"
                            ? { role: "user", content: message.text }
                            : {
                                  role: "assistant",
                                  content: [{ type: "text", text: message.text }],
                              },
                });
                parent = id;
            });
            writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
            return path;
        },
        importNow() {
            return service.importNow(["pi"]);
        },
        cleanup() {
            if (closed) return;
            closed = true;
            service.close();
            for (const key of ENV_KEYS) {
                const value = saved.get(key);
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            rmSync(root, { recursive: true, force: true });
        },
    };
}

/** An item with sensible defaults. Not stored. */
export function makeItem(overrides: Partial<Item> = {}): Item {
    const at = "2026-01-01T00:00:00.000Z";
    return {
        id: newId("i"),
        scope: "project",
        projectId: null,
        kind: "decision",
        title: "Use WAL mode",
        body: "The store uses WAL mode.",
        branch: null,
        trust: "user",
        status: "active",
        origin: "dreaming",
        general: false,
        writerHarness: null,
        writerSession: null,
        idemKey: null,
        contentHash: "hash",
        createdRun: null,
        updatedRun: null,
        createdAt: at,
        updatedAt: at,
        sources: [],
        ...overrides,
    };
}

/**
 * Store a run of a Dreaming pass without a model: each change creates, replaces or (with a null
 * `after`) deletes an item and records the history that revert reads.
 */
export function commitRun(
    store: Store,
    input: {
        kind?: "project" | "global";
        projectId: string | null;
        changes: Array<{ before: Item | null; after: Item }>;
        sessions?: string[];
    },
): number {
    return store.tx(() => {
        const runId = startRun(store, {
            kind: input.kind ?? "project",
            projectId: input.projectId,
            trigger: "test",
            sessions: input.sessions ?? [],
        });
        for (const change of input.changes) {
            const after = { ...change.after, updatedRun: runId };
            putItem(store, after);
            recordHistory(store, runId, after.id, change.before, after);
        }
        finishRun(store, runId, { status: "ok" });
        return runId;
    });
}

export interface SeedEvent {
    role?: EventRole;
    text: string;
    toolName?: string | null;
    time?: string | null;
    memoryDerived?: boolean;
    untrusted?: boolean;
    active?: boolean;
}

/** Insert a session and its events straight into the store, without an adapter or a file. */
export function seedSession(
    store: Store,
    input: {
        id: string;
        harness?: Harness;
        projectId?: string | null;
        cwd?: string | null;
        branch?: string | null;
        title?: string | null;
        transcriptPath?: string | null;
        sourcePath?: string;
        events: SeedEvent[];
        processed?: boolean;
    },
): SessionRow {
    const harness = input.harness ?? "pi";
    const at = nowIso(Date.parse("2026-01-01T00:00:00.000Z"));
    const session: SessionRow = {
        harness,
        id: input.id,
        sourcePath: input.sourcePath ?? `/nonexistent/${input.id}.jsonl`,
        sourceSize: 1,
        sourceMtime: 1,
        fingerprint: sha256(input.id),
        revision: 1,
        cwd: input.cwd ?? null,
        branch: input.branch ?? null,
        projectId: input.projectId ?? null,
        title: input.title ?? null,
        startedAt: at,
        updatedAt: at,
        changedAt: at,
        importedAt: at,
        transcriptPath: input.transcriptPath ?? null,
        status: "ok",
        lastError: null,
        attempts: 0,
        attemptRevision: null,
        processedRevision: input.processed ? 1 : null,
        warnings: [],
        filtered: {},
        redactions: 0,
    };
    store.tx(() => {
        putSession(store, session);
        input.events.forEach((event, seq) => {
            store.run(
                `INSERT INTO events(harness, session_id, key, seq, role, tool_name, text, time,
                    source_line, transcript_line, memory_derived, untrusted, active, hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
                harness,
                input.id,
                `k${seq}`,
                seq,
                event.role ?? "user",
                event.toolName ?? null,
                event.text,
                event.time === undefined ? at : event.time,
                seq + 2,
                bit(event.memoryDerived ?? false),
                bit(event.untrusted ?? false),
                bit(event.active ?? true),
                sha256(event.text),
            );
        });
    });
    return session;
}
