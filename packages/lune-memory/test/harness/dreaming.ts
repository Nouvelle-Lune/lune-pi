import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    type FauxProviderHandle,
    type FauxResponseStep,
    type Models,
} from "@earendil-works/pi-ai";

import { defaultConfig, type MemoryConfig } from "../../src/core/config.ts";
import { memoryPaths, type MemoryPaths } from "../../src/core/paths.ts";
import type { EventRole, Harness, Item, SessionRow } from "../../src/core/types.ts";
import { runDreamingPass, type DreamOptions, type PassSummary } from "../../src/dreaming/index.ts";
import { Store } from "../../src/store/db.ts";
import { listItems, putSession } from "../../src/store/rows.ts";

export const FAUX_PROVIDER = "faux-dream";
export const FAUX_MODEL_ID = "dream-1";
export const FAUX_REF = `${FAUX_PROVIDER}/${FAUX_MODEL_ID}`;

/** Fixed clock of a test. Sessions are placed relative to it. */
export const NOW = Date.parse("2030-01-15T12:00:00.000Z");
export const HOUR = 3_600_000;

export type Role = "analyzer" | "organizer" | "global";

export interface ModelCall {
    role: Role;
    system: string;
    user: string;
}

type Reply = string | Record<string, unknown>;
export type Handler = (user: string, callIndex: number) => Reply | Promise<Reply>;
export type Handlers = Partial<Record<Role, Handler | Reply | Reply[]>>;

export interface EventInput {
    role?: EventRole;
    text: string;
    key?: string;
    untrusted?: boolean;
    memoryDerived?: boolean;
    active?: boolean;
    /** Mark the event as already processed in its current form. */
    processed?: boolean;
}

export interface SessionInput {
    id: string;
    harness?: Harness;
    projectId?: string | null;
    branch?: string | null;
    /** Hours before `NOW` when the session last changed. Default 10. */
    idleHours?: number;
    revision?: number;
    events?: EventInput[];
    processedRevision?: number | null;
    attempts?: number;
    attemptRevision?: number | null;
    status?: "ok" | "error";
}

export interface DreamEnv {
    home: string;
    paths: MemoryPaths;
    store: Store;
    config: MemoryConfig;
    faux: FauxProviderHandle;
    models: Models;
    calls: ModelCall[];
    /** Script the faux model by the role of the call, as told by its system prompt. */
    route(handlers: Handlers): void;
    /** Run one pass with the faux registry and the fixed clock. */
    pass(options?: Partial<DreamOptions>): Promise<PassSummary>;
    addProject(id: string, name: string, root?: string | null): void;
    addSession(input: SessionInput): void;
    addBranch(projectId: string, name: string, status?: "open" | "merged" | "deleted"): void;
    /** Insert an item directly, for state that earlier passes would have produced. */
    addItem(item: Partial<Item> & Pick<Item, "id" | "kind" | "title" | "body">): void;
    calledRoles(): Role[];
}

function roleOf(system: string): Role {
    if (system.startsWith("You are the Session Analyzer")) return "analyzer";
    if (system.startsWith("You are the Organizer")) return "organizer";
    if (system.startsWith("You are the global pass")) return "global";
    throw new Error(`Unknown prompt: ${system.slice(0, 60)}`);
}

function userText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((block) => (block && typeof block === "object" && "text" in block ? block.text : ""))
        .join("");
}

/**
 * Isolated Dreaming environment: temp home, SQLite store, faux model registry and a fixed
 * clock. The environment variables that move the harness roots point into the temp home.
 */
export function createDreamEnv(
    t: TestContext,
    overrides: Partial<MemoryConfig["dreaming"]> = {},
): DreamEnv {
    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    const saved = {
        LUNE_MEMORY_HOME: process.env.LUNE_MEMORY_HOME,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CODEX_HOME: process.env.CODEX_HOME,
    };
    process.env.LUNE_MEMORY_HOME = join(home, "memory");
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
    process.env.CODEX_HOME = join(home, "codex");
    const paths = memoryPaths(join(home, "memory"));
    const store = Store.open(paths.db);
    const config = defaultConfig(home, process.env);
    config.dreaming.model = FAUX_REF;
    config.dreaming.maxRetries = 0;
    Object.assign(config.dreaming, overrides);

    const faux = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL_ID }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const calls: ModelCall[] = [];
    const counters: Record<Role, number> = { analyzer: 0, organizer: 0, global: 0 };

    t.after(() => {
        store.close();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    });

    const env: DreamEnv = {
        home,
        paths,
        store,
        config,
        faux,
        models,
        calls,
        route(handlers) {
            const step: FauxResponseStep = async (context) => {
                const system = userText(
                    context.messages.find((message) => message.role === "system")?.content,
                );
                const role = roleOf(system);
                const user = userText(
                    context.messages.find((message) => message.role === "user")?.content,
                );
                calls.push({ role, system, user });
                const index = counters[role]++;
                const entry = handlers[role];
                let reply: Reply | undefined;
                if (typeof entry === "function") reply = await entry(user, index);
                else if (Array.isArray(entry)) reply = entry[Math.min(index, entry.length - 1)];
                else reply = entry;
                if (reply === undefined) throw new Error(`No scripted reply for ${role}`);
                return fauxAssistantMessage(
                    typeof reply === "string" ? reply : JSON.stringify(reply),
                );
            };
            faux.setResponses(Array.from({ length: 40 }, () => step));
        },
        pass(options = {}) {
            return runDreamingPass(store, paths, config, {
                trigger: "test",
                now: NOW,
                models,
                ...options,
            });
        },
        addProject(id, name, root = null) {
            store.run(
                "INSERT INTO projects (id, name, root, merged_into, created_at) VALUES (?, ?, ?, NULL, ?)",
                id,
                name,
                root,
                new Date(NOW - 100 * HOUR).toISOString(),
            );
        },
        addSession(input) {
            const harness = input.harness ?? "claude";
            const revision = input.revision ?? 1;
            const changedAt = new Date(NOW - (input.idleHours ?? 10) * HOUR).toISOString();
            const row: SessionRow = {
                harness,
                id: input.id,
                sourcePath: join(home, `${input.id}.jsonl`),
                sourceSize: 1,
                sourceMtime: 1,
                fingerprint: `fp-${input.id}-${revision}`,
                revision,
                cwd: null,
                branch: input.branch ?? null,
                projectId: input.projectId ?? null,
                title: `Session ${input.id}`,
                startedAt: changedAt,
                updatedAt: changedAt,
                changedAt,
                importedAt: changedAt,
                transcriptPath: null,
                status: input.status ?? "ok",
                lastError: null,
                attempts: input.attempts ?? 0,
                attemptRevision: input.attemptRevision ?? null,
                processedRevision: input.processedRevision ?? null,
                warnings: [],
                filtered: {},
                redactions: 0,
            };
            putSession(store, row);
            (input.events ?? []).forEach((event, index) => {
                const key = event.key ?? `${input.id}-k${index + 1}`;
                const hash = `h-${key}`;
                store.run(
                    `INSERT INTO events (harness, session_id, key, seq, role, tool_name, text, time,
                        memory_derived, untrusted, active, hash, processed_hash)
                    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
                    harness,
                    input.id,
                    key,
                    index + 1,
                    event.role ?? "user",
                    event.text,
                    changedAt,
                    event.memoryDerived ? 1 : 0,
                    event.untrusted ? 1 : 0,
                    event.active === false ? 0 : 1,
                    hash,
                    event.processed ? hash : null,
                );
            });
        },
        addBranch(projectId, name, status = "open") {
            const at = new Date(NOW - 50 * HOUR).toISOString();
            store.run(
                `INSERT INTO branches (project_id, name, status, first_seen, closed_at, handled_run)
                VALUES (?, ?, ?, ?, ?, NULL)`,
                projectId,
                name,
                status,
                at,
                status === "open" ? null : at,
            );
        },
        addItem(item) {
            const at = new Date(NOW - 20 * HOUR).toISOString();
            const full: Item = {
                scope: "project",
                projectId: null,
                branch: null,
                trust: "user",
                status: "active",
                origin: "dreaming",
                general: false,
                writerHarness: null,
                writerSession: null,
                idemKey: null,
                contentHash: `ch-${item.id}`,
                createdRun: 1,
                updatedRun: 1,
                createdAt: at,
                updatedAt: at,
                sources: [],
                ...item,
            };
            store.tx(() => {
                store.run(
                    `INSERT INTO items (id, scope, project_id, kind, title, body, branch, trust,
                        status, origin, general, idem_key, content_hash, created_run, updated_run,
                        created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    full.id,
                    full.scope,
                    full.projectId,
                    full.kind,
                    full.title,
                    full.body,
                    full.branch,
                    full.trust,
                    full.status,
                    full.origin,
                    full.general ? 1 : 0,
                    full.idemKey,
                    full.contentHash,
                    full.createdRun,
                    full.updatedRun,
                    full.createdAt,
                    full.updatedAt,
                );
                full.sources.forEach((source, seq) => {
                    if (source.kind === "event") {
                        store.run(
                            `INSERT INTO item_sources (item_id, seq, ref_kind, harness, session_id, event_key)
                            VALUES (?, ?, 'event', ?, ?, ?)`,
                            full.id,
                            seq,
                            source.harness,
                            source.sessionId,
                            source.eventKey,
                        );
                    } else {
                        store.run(
                            "INSERT INTO item_sources (item_id, seq, ref_kind, ref_item) VALUES (?, ?, 'item', ?)",
                            full.id,
                            seq,
                            source.itemId,
                        );
                    }
                });
            });
        },
        calledRoles() {
            return calls.map((call) => call.role);
        },
    };
    return env;
}

/** Active and provisional items that a pass created, newest last. */
export function dreamingItems(env: DreamEnv, projectId: string | null): Item[] {
    return listItems(env.store, {
        origin: "dreaming",
        ...(projectId ? { scope: "project" as const, projectId } : { scope: "global" as const }),
    });
}

export function count(env: DreamEnv, sql: string, ...params: Array<string | number>): number {
    const row = env.store.get(sql, ...params);
    return Number(row?.n ?? 0);
}

/** One run per commit unit. Counts runs of a kind and status. */
export function runCount(env: DreamEnv, kind: string, status: string): number {
    return count(env, "SELECT COUNT(*) AS n FROM runs WHERE kind = ? AND status = ?", kind, status);
}

/** Analyzer reply that cites events and makes one candidate. */
export function analyzerReply(
    candidates: Array<Record<string, unknown>>,
    summary = "The session made a decision.",
): Record<string, unknown> {
    return { summary, candidates, noteReviews: [], conflicts: [] };
}

export function decisionCandidate(title: string, evidence: string[] = ["e1"]) {
    return {
        kind: "decision",
        title,
        body: `${title}. It was chosen for a reason that the user gave.`,
        trust: "user",
        general: false,
        evidence,
        updates: null,
    };
}

export function createOp(title: string, evidence: string[], extra: Record<string, unknown> = {}) {
    return {
        op: "create",
        kind: "decision",
        title,
        body: `${title}. It was chosen for a reason that the user gave.`,
        branch: null,
        trust: "user",
        general: false,
        evidence,
        from: [],
        links: [],
        ...extra,
    };
}

/** Session id of an Analyzer user message. */
export function sessionOf(user: string): string {
    return /^Session: (.+)$/mu.exec(user)?.[1] ?? "";
}

/** Body that is too large for the L1 budget: many short lines. */
export function oversizedBody(lines = 400): string {
    return Array.from({ length: lines }, (_, index) => `l${index}`).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Git fixtures

function git(cwd: string, ...args: string[]): string {
    return execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        {
            cwd,
            encoding: "utf8",
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_SYSTEM: "/dev/null",
            },
        },
    ).trim();
}

export interface GitFixture {
    root: string;
    run(...args: string[]): string;
    /** Create a branch from main with one commit and return to main. */
    branch(name: string): void;
}

/** A synthetic repository with a `main` branch. */
export function createGitRepo(parent: string): GitFixture {
    const root = join(parent, "repo");
    mkdirSync(root, { recursive: true });
    const run = (...args: string[]) => git(root, ...args);
    run("init", "-q", "-b", "main");
    writeFileSync(join(root, "a.txt"), "a\n");
    run("add", ".");
    run("commit", "-q", "-m", "init");
    return {
        root,
        run,
        branch(name) {
            run("checkout", "-q", "-b", name);
            writeFileSync(join(root, `${name.replaceAll("/", "-")}.txt`), "x\n");
            run("add", ".");
            run("commit", "-q", "-m", `work on ${name}`);
            run("checkout", "-q", "main");
        },
    };
}

/** True when any file of the current projection contains `needle`. */
export function viewsContain(env: DreamEnv, needle: string): boolean {
    const walk = (dir: string): boolean =>
        readdirSync(dir, { withFileTypes: true }).some((entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) return walk(path);
            return readFileSync(path, "utf8").includes(needle);
        });
    return existsSync(env.paths.views) && walk(env.paths.views);
}
