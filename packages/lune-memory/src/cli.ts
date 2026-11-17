import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { lockHolder, readDaemonInfo } from "./api/daemon-info.ts";
import { searchArguments, type L1Request, type SearchRequest } from "./api/requests.ts";
import { ensureDaemon, spawnDaemon, waitForDaemon } from "./client/connection.ts";
import { MemoryClient } from "./client/memory-client.ts";
import { memoryHome, type MemoryConfig } from "./core/config.ts";
import { memoryPaths, UNASSIGNED, type MemoryPaths } from "./core/paths.ts";
import { HARNESSES, isHarness, isLocatorKind, LOCATOR_KINDS, type Harness } from "./core/types.ts";
import { errorMessage, packageVersion, pidAlive } from "./core/util.ts";
import type { PassSummary } from "./dreaming/index.ts";
import type { ImportSummary } from "./ingest/importer.ts";
import { formatLocation, formatSearchResult } from "./integrations/format.ts";
import {
    hookCommand,
    hookInstalled,
    installHook,
    isHookHarness,
    mcpAddCommand,
    sandboxHint,
    piInstallCommand,
    removeHook,
} from "./integrations/setup.ts";
import type { L1Result } from "./memory/l1.ts";
import type { ForgetResult, RevertResult } from "./memory/revert.ts";
import type { SearchResult } from "./memory/search.ts";
import type { MemoryLocation, MemoryService, MemoryStatus, ProviderInfo } from "./service.ts";
import type { RunRow } from "./store/rows.ts";

export interface CliIo {
    stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
    stdout: Writable;
    stderr: Writable;
    env: NodeJS.ProcessEnv;
    cwd: string;
}

class UsageError extends Error {}

const BOOLEAN_FLAGS = new Set([
    "json",
    "all",
    "force",
    "reprocess",
    "merged",
    "print",
    "install-hook",
    "remove-hook",
    "disable",
    "help",
    "version",
]);
const VALUE_FLAGS = new Set([
    "home",
    "root",
    "harness",
    "session",
    "cwd",
    "limit",
    "project",
    "name",
    "since",
    "until",
    "context",
]);

const IMPORT_TIMEOUT_MS = 10 * 60_000;
const DREAM_TIMEOUT_MS = 30 * 60_000;
const HOOK_TIMEOUT_MS = 20_000;
const STDIN_TIMEOUT_MS = 5_000;
const STOP_WAIT_MS = 10_000;

const USAGE = `lune-memory: shared memory for coding agents

Setup
  setup                              Show the harnesses and their hooks
  setup <harness> [--root dir] [--disable] [--install-hook | --remove-hook]
  settings [--print]                 Open the local settings page

Memory
  l1 [--harness h] [--session id] [--cwd dir]
  search <query...> [--project id | --all] [--harness h] [--session id]
         [--since time] [--until time] [--limit n] [--context n] [--cwd dir]
  location [--cwd dir]
  import [harness...]
  dream [--force] [--project id|_unassigned] [harness:id...]
  status
  runs [--limit n]
  sessions [--limit n] [--project id|_unassigned]
  revert <run> [--reprocess]
  forget <harness> <id> | forget <harness:id>
  regenerate

Projects
  projects [--merged]
  register <path> [--name name]
  rename <project> <name...>
  merge <source> <target>
  split <${LOCATOR_KINDS.join("|")}> <value> [--name name]

Config
  config get [key.path]
  config set <key.path> <value>
  credential list
  credential set <provider>          Reads the key from stdin
  credential remove <provider>

Daemon and integrations
  daemon [run | start | stop | status]
  mcp [--harness h] [--session id] [--cwd dir]
  hook --harness <claude|codex>      SessionStart hook

Options
  --home dir    Memory home (default LUNE_MEMORY_HOME or ~/.lune-memory)
  --json        Print JSON
  --help, --version
`;

class Args {
    readonly positional: string[] = [];
    private readonly flags = new Map<string, string | true>();

    constructor(argv: string[]) {
        for (let i = 0; i < argv.length; i++) {
            const arg = argv[i] ?? "";
            if (arg === "--") {
                this.positional.push(...argv.slice(i + 1));
                break;
            }
            if (arg === "-h") {
                this.flags.set("help", true);
                continue;
            }
            if (!arg.startsWith("--") || arg === "--") {
                this.positional.push(arg);
                continue;
            }
            const eq = arg.indexOf("=");
            const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
            if (BOOLEAN_FLAGS.has(name)) {
                if (eq > 0) throw new UsageError(`--${name} takes no value`);
                this.flags.set(name, true);
            } else if (VALUE_FLAGS.has(name)) {
                let value: string | undefined;
                if (eq > 0) value = arg.slice(eq + 1);
                else {
                    value = argv[i + 1];
                    if (value === undefined || value.startsWith("--")) {
                        throw new UsageError(`--${name} needs a value`);
                    }
                    i++;
                }
                this.flags.set(name, value);
            } else {
                throw new UsageError(`Unknown option: --${name}`);
            }
        }
    }

    has(name: string): boolean {
        return this.flags.get(name) === true;
    }

    value(name: string): string | undefined {
        const value = this.flags.get(name);
        return typeof value === "string" ? value : undefined;
    }

    int(name: string, min: number, max: number): number | undefined {
        const raw = this.value(name);
        if (raw === undefined) return undefined;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
        }
        return value;
    }

    harness(): Harness | null {
        const value = this.value("harness");
        if (value === undefined) return null;
        if (!isHarness(value)) throw new UsageError(`Unknown harness: ${value}`);
        return value;
    }
}

interface Context {
    args: Args;
    io: CliIo;
    home: string;
    paths: MemoryPaths;
    /** Home to write into generated commands. Null keeps the default. */
    commandHome: string | null;
    out: (line?: string) => void;
    err: (line?: string) => void;
}

type Handler = (ctx: Context) => Promise<number>;

function json(ctx: Context, value: unknown): void {
    ctx.out(JSON.stringify(value, null, 2));
}

async function withClient<T>(
    ctx: Context,
    fn: (client: MemoryClient) => Promise<T>,
    autoStart?: boolean,
): Promise<T> {
    const client = new MemoryClient({
        home: ctx.home,
        ...(autoStart === undefined ? {} : { autoStart }),
    });
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

/** Admin calls do not start the daemon. They use it when it runs, else the local service. */
function admin<T>(
    ctx: Context,
    method: string,
    path: string,
    body: unknown,
    local: (service: MemoryService) => T | Promise<T>,
    timeoutMs?: number,
): Promise<T> {
    return withClient(ctx, (client) => client.call(method, path, body, local, timeoutMs), false);
}

function parseSessionLabel(label: string): { harness: Harness; id: string } | null {
    const at = label.indexOf(":");
    if (at <= 0) return null;
    const harness = label.slice(0, at);
    const id = label.slice(at + 1);
    if (!isHarness(harness) || !id) return null;
    return { harness, id };
}

function need(ctx: Context, index: number, name: string): string {
    const value = ctx.args.positional[index];
    if (!value) throw new UsageError(`Missing ${name}`);
    return value;
}

async function readStdin(io: CliIo, timeoutMs?: number): Promise<string> {
    if (io.stdin.isTTY) return "";
    return await new Promise((done) => {
        const chunks: Buffer[] = [];
        const finish = () => {
            if (timer) clearTimeout(timer);
            io.stdin.off("data", onData);
            io.stdin.off("end", finish);
            io.stdin.off("error", finish);
            done(Buffer.concat(chunks).toString("utf8"));
        };
        const onData = (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        };
        const timer = timeoutMs ? setTimeout(finish, timeoutMs) : null;
        io.stdin.on("data", onData);
        io.stdin.once("end", finish);
        io.stdin.once("error", finish);
        io.stdin.resume();
    });
}

/** Read a secret from a terminal without echo. */
async function readSecret(io: CliIo, prompt: string): Promise<string> {
    const stdin = io.stdin;
    if (!stdin.isTTY || !stdin.setRawMode) return (await readStdin(io)).trim();
    io.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    return await new Promise((done, fail) => {
        let value = "";
        const stop = () => {
            stdin.setRawMode?.(false);
            stdin.pause();
            stdin.off("data", onData);
            io.stderr.write("\n");
        };
        const onData = (chunk: Buffer | string) => {
            for (const char of chunk.toString()) {
                if (char === "\r" || char === "\n") {
                    stop();
                    done(value.trim());
                    return;
                }
                if (char === "\u0003") {
                    stop();
                    fail(new Error("Cancelled"));
                    return;
                }
                if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
                else value += char;
            }
        };
        stdin.on("data", onData);
    });
}

// Setup -----------------------------------------------------------------------------------------

async function setupCommand(ctx: Context): Promise<number> {
    const { args, io } = ctx;
    const name = args.positional[0];
    const config = await admin<MemoryConfig>(ctx, "GET", "/api/config", undefined, (s) =>
        s.getConfig(),
    );
    if (!name) {
        for (const harness of HARNESSES) {
            const entry = config.harnesses[harness];
            const hook = isHookHarness(harness)
                ? hookInstalled(harness, { env: io.env })
                    ? ", hook installed"
                    : ", no hook"
                : "";
            ctx.out(`${harness}: ${entry.enabled ? "enabled" : "off"}, ${entry.root}${hook}`);
        }
        return 0;
    }
    if (!isHarness(name)) throw new UsageError(`Unknown harness: ${name}`);
    const install = args.has("install-hook");
    const remove = args.has("remove-hook");
    if (install && remove) throw new UsageError("Give --install-hook or --remove-hook, not both");
    if (!isHookHarness(name) && (install || remove)) {
        throw new UsageError("Pi needs no hook. It loads the lune-memory extension.");
    }
    const root = args.value("root");
    const entry = config.harnesses[name];
    entry.enabled = !args.has("disable");
    if (root) entry.root = resolve(io.cwd, root);
    const saved = await admin<MemoryConfig>(ctx, "PUT", "/api/config", config, (s) =>
        s.setConfig(config),
    );
    const now = saved.harnesses[name];
    ctx.out(`${name}: ${now.enabled ? "enabled" : "off"}, ${now.root}`);
    if (!existsSync(now.root)) ctx.err(`Warning: ${now.root} does not exist yet.`);

    const commandOptions = { memoryHome: ctx.commandHome, env: io.env };
    if (isHookHarness(name)) {
        if (install) {
            const result = installHook(name, {
                command: hookCommand(name, commandOptions),
                env: io.env,
            });
            ctx.out(
                `Hook ${result.hooks.changed ? "installed in" : "already in"} ${result.hooks.file}`,
            );
            if (result.hooks.backup) ctx.out(`Backup: ${result.hooks.backup}`);
            if (result.feature?.changed)
                ctx.out(`Hooks feature turned on in ${result.feature.file}`);
        } else if (remove) {
            const result = removeHook(name, { env: io.env });
            ctx.out(`Removed ${result.removed} hook(s) from ${result.file}`);
            if (result.backup) ctx.out(`Backup: ${result.backup}`);
        } else if (hookInstalled(name, { env: io.env })) {
            ctx.out("SessionStart hook: installed");
        } else {
            ctx.out(
                `SessionStart hook: missing. The hook runs: ${hookCommand(name, commandOptions)}`,
            );
            ctx.out(`Run "lune-memory setup ${name} --install-hook" to install it.`);
        }
        ctx.out(`Add the MCP server: ${mcpAddCommand(name, commandOptions)}`);
        for (const line of sandboxHint(name, ctx.paths.views)) ctx.out(line);
    } else {
        ctx.out(`Install the Pi extension: ${piInstallCommand()}`);
    }
    return 0;
}

async function settingsCommand(ctx: Context): Promise<number> {
    const info = await ensureDaemon(ctx.paths, { autoStart: true });
    if (!info) {
        ctx.err(`The daemon did not start. See ${ctx.paths.logs}/daemon.log`);
        return 1;
    }
    const url = `${info.url}/#token=${info.token}`;
    ctx.out(url);
    if (ctx.args.has("print")) return 0;
    const [command, args] =
        process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["cmd", ["/c", "start", "", url]]
              : ["xdg-open", [url]];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => ctx.err("Open the address above in a browser."));
    child.unref();
    return 0;
}

// Memory ----------------------------------------------------------------------------------------

async function hookCommandRun(ctx: Context): Promise<number> {
    try {
        const harness = ctx.args.harness();
        let input: Record<string, unknown> = {};
        const raw = (await readStdin(ctx.io, STDIN_TIMEOUT_MS)).trim();
        if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
        }
        const request: L1Request = {
            cwd: typeof input.cwd === "string" ? input.cwd : ctx.io.cwd,
            harness,
            sessionId: typeof input.session_id === "string" ? input.session_id : null,
            announceSession: true,
        };
        const result = await withClient(ctx, (client) =>
            client.call<L1Result>(
                "POST",
                "/api/l1",
                request,
                (s) => s.l1(request),
                HOOK_TIMEOUT_MS,
            ),
        );
        if (result.text) {
            ctx.out(
                JSON.stringify({
                    hookSpecificOutput: {
                        hookEventName: "SessionStart",
                        additionalContext: result.text,
                    },
                }),
            );
        }
        if (result.overBudget) {
            ctx.err(
                `lune-memory hook: the memory context is ${result.lines} lines and ${result.bytes} ` +
                    "bytes, which is over its budget. It was injected in full.",
            );
        }
    } catch (error) {
        ctx.err(`lune-memory hook: ${errorMessage(error)}`);
    }
    return 0;
}

async function l1Command(ctx: Context): Promise<number> {
    const sessionId = ctx.args.value("session") ?? null;
    const request: L1Request = {
        cwd: resolve(ctx.io.cwd, ctx.args.value("cwd") ?? "."),
        harness: ctx.args.harness(),
        sessionId,
        announceSession: sessionId !== null,
    };
    const result = await withClient(ctx, (client) =>
        client.call<L1Result>("POST", "/api/l1", request, (s) => s.l1(request)),
    );
    if (ctx.args.has("json")) json(ctx, result);
    else ctx.io.stdout.write(result.text);
    return 0;
}

async function searchCommand(ctx: Context): Promise<number> {
    const { args } = ctx;
    const query = args.positional.join(" ").trim();
    if (!query) throw new UsageError("Missing query");
    const project = args.value("project");
    const request: SearchRequest = {
        query,
        cwd: resolve(ctx.io.cwd, args.value("cwd") ?? "."),
        ...(project ? { projectId: project } : {}),
        ...(args.has("all") ? { allProjects: true } : {}),
        harness: args.harness(),
        sessionId: args.value("session") ?? null,
        since: args.value("since") ?? null,
        until: args.value("until") ?? null,
        limit: args.int("limit", 1, 50) ?? null,
        context: args.int("context", 0, 5) ?? null,
    };
    const result = await withClient(ctx, (client) =>
        client.call<SearchResult>("POST", "/api/search", request, (s) =>
            s.search(searchArguments(request)),
        ),
    );
    if (args.has("json")) json(ctx, result);
    else ctx.out(formatSearchResult(result));
    return 0;
}

async function locationCommand(ctx: Context): Promise<number> {
    const cwd = resolve(ctx.io.cwd, ctx.args.value("cwd") ?? ".");
    const result = await withClient(ctx, (client) =>
        client.call<MemoryLocation>("POST", "/api/location", { cwd }, (s) => s.location(cwd)),
    );
    if (ctx.args.has("json")) json(ctx, result);
    else ctx.out(formatLocation(result));
    return 0;
}

async function importCommand(ctx: Context): Promise<number> {
    const harnesses = ctx.args.positional.map((name) => {
        if (!isHarness(name)) throw new UsageError(`Unknown harness: ${name}`);
        return name;
    });
    const list = harnesses.length ? harnesses : undefined;
    const result = await admin<ImportSummary>(
        ctx,
        "POST",
        "/api/import",
        list ? { harnesses: list } : {},
        (s) => s.importNow(list),
        IMPORT_TIMEOUT_MS,
    );
    if (ctx.args.has("json")) {
        json(ctx, result);
        return 0;
    }
    ctx.out(
        `Scanned ${result.scanned}, imported ${result.imported}, unchanged ${result.unchanged}, ` +
            `skipped ${result.skipped}, errors ${result.errors}, purged ${result.purged}`,
    );
    for (const problem of result.problems) ctx.err(`${problem.path}: ${problem.error}`);
    return result.errors > 0 ? 1 : 0;
}

async function dreamCommand(ctx: Context): Promise<number> {
    const sessions = ctx.args.positional;
    for (const label of sessions) {
        if (!parseSessionLabel(label)) throw new UsageError(`Not a harness:id label: ${label}`);
    }
    // No --project means every project, and no label means every session. `_unassigned` means
    // the sessions outside any project.
    const project = ctx.args.value("project");
    const filters = {
        ...(project === undefined ? {} : { projectId: project === UNASSIGNED ? null : project }),
        ...(sessions.length ? { sessions } : {}),
    };
    const force = ctx.args.has("force");
    const result = await admin<PassSummary>(
        ctx,
        "POST",
        "/api/dream",
        { force, ...filters, wait: true },
        (s) => s.dream({ trigger: "manual", force, ...filters }),
        DREAM_TIMEOUT_MS,
    );
    if (ctx.args.has("json")) json(ctx, result);
    else {
        ctx.out(
            `Pass ${result.pass}: ${result.status}. Eligible ${result.eligible}, ` +
                `deferred ${result.deferred}, waiting ${result.waiting}, trivial ${result.trivial}`,
        );
        for (const project of result.projects) {
            ctx.out(
                `- ${project.projectId}: ${project.status} (run ${project.runId}) ${project.summary}`,
            );
        }
        if (result.global) ctx.out(`- global: ${result.global.status} ${result.global.summary}`);
        for (const warning of result.warnings) ctx.err(`Warning: ${warning}`);
        for (const error of result.errors) ctx.err(`Error: ${error}`);
    }
    return result.status === "failed" ? 1 : 0;
}

async function statusCommand(ctx: Context): Promise<number> {
    const status = await admin<MemoryStatus & { daemon?: unknown }>(
        ctx,
        "GET",
        "/api/status",
        undefined,
        (s) => ({ ...s.status(), daemon: null }),
    );
    if (ctx.args.has("json")) {
        json(ctx, status);
        return 0;
    }
    ctx.out(`Home: ${status.home}`);
    ctx.out(`Views: ${status.views} (generation ${status.generation ?? "none"})`);
    if (status.viewsError) ctx.out(`Views out of date: ${status.viewsError}`);
    ctx.out(`Daemon: ${status.daemon ? "running" : "not running"}`);
    for (const harness of HARNESSES) {
        const entry = status.harnesses[harness];
        ctx.out(`${harness}: ${entry.enabled ? "enabled" : "off"}, ${entry.root}`);
    }
    const dreaming = status.dreaming;
    ctx.out(
        `Dreaming: ${dreaming.enabled ? "on" : "off"}, model ${dreaming.model ?? "none"}, ` +
            `thinking ${dreaming.thinking}`,
    );
    const counts = status.counts;
    ctx.out(
        `Projects ${counts.projects}, sessions ${counts.sessions} (${counts.unprocessed} ` +
            `unprocessed), events ${counts.events}`,
    );
    const items = Object.entries(counts.items).map(([kind, n]) => `${kind} ${n}`);
    if (items.length) ctx.out(`Items: ${items.join(", ")}`);
    if (status.lastPass) {
        ctx.out(`Last pass: ${status.lastPass.status} at ${status.lastPass.finishedAt}`);
    }
    return 0;
}

async function runsCommand(ctx: Context): Promise<number> {
    const limit = ctx.args.int("limit", 1, 1000) ?? 20;
    const runs = await admin<RunRow[]>(ctx, "GET", `/api/runs?limit=${limit}`, undefined, (s) =>
        s.runs(limit),
    );
    if (ctx.args.has("json")) json(ctx, runs);
    else if (runs.length === 0) ctx.out("No runs");
    else {
        for (const run of runs) {
            const project = run.projectId ? ` ${run.projectId}` : "";
            ctx.out(
                `${run.id} ${run.kind}${project} ${run.status} ${run.startedAt} ${run.trigger}`,
            );
            if (run.error) ctx.out(`  error: ${run.error}`);
        }
    }
    return 0;
}

async function sessionsCommand(ctx: Context): Promise<number> {
    const limit = ctx.args.int("limit", 1, 1000) ?? 50;
    const project = ctx.args.value("project");
    const query = `limit=${limit}${project ? `&project=${encodeURIComponent(project)}` : ""}`;
    const projectId = project === undefined ? undefined : project === UNASSIGNED ? null : project;
    const sessions = await admin(ctx, "GET", `/api/sessions?${query}`, undefined, (s) =>
        s.sessions({ limit, ...(projectId === undefined ? {} : { projectId }) }),
    );
    if (ctx.args.has("json")) json(ctx, sessions);
    else if (sessions.length === 0) ctx.out("No sessions");
    else {
        for (const session of sessions) {
            const state = session.processed ? "processed" : "unprocessed";
            ctx.out(
                `${session.harness}:${session.id} ${session.projectId ?? "-"} ${state} ` +
                    `${session.updatedAt ?? session.changedAt}${session.title ? ` ${session.title}` : ""}`,
            );
        }
    }
    return 0;
}

async function revertCommand(ctx: Context): Promise<number> {
    const raw = need(ctx, 0, "run id");
    const runId = Number(raw);
    if (!Number.isInteger(runId) || runId < 1) throw new UsageError(`Not a run id: ${raw}`);
    const reprocess = ctx.args.has("reprocess");
    const result = await admin<RevertResult>(
        ctx,
        "POST",
        `/api/runs/${runId}/revert`,
        { reprocess },
        (s) => s.revert(runId, { reprocess }),
    );
    if (ctx.args.has("json")) json(ctx, result);
    else {
        ctx.out(
            `Reverted run ${result.runId} in run ${result.revertRun}: ${result.items} item(s), ` +
                `${result.reprocessed} session(s) to process again`,
        );
        viewsWarning(ctx, result.projectionError);
    }
    return 0;
}

async function forgetCommand(ctx: Context): Promise<number> {
    const [first, second] = ctx.args.positional;
    const parsed =
        first && second
            ? isHarness(first)
                ? { harness: first, id: second }
                : null
            : first
              ? parseSessionLabel(first)
              : null;
    if (!parsed) throw new UsageError("Give a session as <harness> <id> or <harness:id>");
    const result = await admin<ForgetResult>(
        ctx,
        "POST",
        "/api/sessions/forget",
        { harness: parsed.harness, sessionId: parsed.id },
        (s) => s.forget(parsed.harness, parsed.id),
    );
    if (ctx.args.has("json")) json(ctx, result);
    else {
        ctx.out(
            `Forgot ${result.harness}:${result.sessionId} in run ${result.runId}: ` +
                `${result.updated} item(s) updated, ${result.retired} retired`,
        );
        viewsWarning(ctx, result.projectionError);
    }
    return 0;
}

/** Warn that a committed change is not in the Markdown views yet. */
function viewsWarning(ctx: Context, error: string | undefined): void {
    if (!error) return;
    ctx.err(
        `Warning: the Markdown views do not show this change yet (${error}). ` +
            "The daemon writes them again, or run `lune-memory regenerate`.",
    );
}

async function regenerateCommand(ctx: Context): Promise<number> {
    const result = await admin(ctx, "POST", "/api/regenerate", {}, (s) => ({
        generation: s.regenerate(),
    }));
    if (ctx.args.has("json")) json(ctx, result);
    else ctx.out(`Generation ${result.generation}`);
    return 0;
}

// Projects --------------------------------------------------------------------------------------

async function projectsCommand(ctx: Context): Promise<number> {
    const merged = ctx.args.has("merged");
    const projects = await admin(
        ctx,
        "GET",
        `/api/projects${merged ? "?merged=1" : ""}`,
        undefined,
        (s) => s.projects(merged),
    );
    if (ctx.args.has("json")) json(ctx, projects);
    else if (projects.length === 0) ctx.out("No projects");
    else {
        for (const project of projects) {
            ctx.out(`${project.id} ${project.name}`);
            for (const locator of project.locators) ctx.out(`  ${locator.kind}: ${locator.value}`);
        }
    }
    return 0;
}

async function registerCommand(ctx: Context): Promise<number> {
    const path = resolve(ctx.io.cwd, need(ctx, 0, "path"));
    const name = ctx.args.value("name");
    const project = await admin(ctx, "POST", "/api/projects", { path, name }, (s) =>
        s.register(path, name),
    );
    if (ctx.args.has("json")) json(ctx, project);
    else ctx.out(`${project.id} ${project.name}`);
    return 0;
}

async function renameCommand(ctx: Context): Promise<number> {
    const id = need(ctx, 0, "project");
    const name = ctx.args.positional.slice(1).join(" ").trim();
    if (!name) throw new UsageError("Missing name");
    const project = await admin(
        ctx,
        "POST",
        `/api/projects/${encodeURIComponent(id)}/rename`,
        { name },
        (s) => s.rename(id, name),
    );
    if (ctx.args.has("json")) json(ctx, project);
    else ctx.out(`${project.id} ${project.name}`);
    return 0;
}

async function mergeCommand(ctx: Context): Promise<number> {
    const source = need(ctx, 0, "source project");
    const target = need(ctx, 1, "target project");
    const result = await admin(ctx, "POST", "/api/projects/merge", { source, target }, (s) =>
        s.merge(source, target),
    );
    if (ctx.args.has("json")) json(ctx, result);
    else ctx.out(`Merged ${result.source} into ${result.target}`);
    return 0;
}

async function splitCommand(ctx: Context): Promise<number> {
    const kind = need(ctx, 0, "locator kind");
    if (!isLocatorKind(kind)) {
        throw new UsageError(`Locator kind must be one of ${LOCATOR_KINDS.join(", ")}`);
    }
    const value = need(ctx, 1, "locator value");
    const name = ctx.args.value("name");
    const result = await admin(ctx, "POST", "/api/projects/split", { kind, value, name }, (s) =>
        s.split(kind, value, name),
    );
    if (ctx.args.has("json")) json(ctx, result);
    else {
        ctx.out(
            `Split to ${result.project.id} ${result.project.name}: ${result.moved} sessions and ${result.items} items moved`,
        );
    }
    return 0;
}

// Config ----------------------------------------------------------------------------------------

function walk(root: unknown, path: string[]): { parent: Record<string, unknown>; key: string } {
    let node = root;
    for (const part of path.slice(0, -1)) {
        if (!node || typeof node !== "object" || !(part in node)) {
            throw new UsageError(`Unknown config key: ${path.join(".")}`);
        }
        node = (node as Record<string, unknown>)[part];
    }
    const key = path.at(-1) ?? "";
    if (!node || typeof node !== "object" || !(key in node)) {
        throw new UsageError(`Unknown config key: ${path.join(".")}`);
    }
    return { parent: node as Record<string, unknown>, key };
}

async function configCommand(ctx: Context): Promise<number> {
    const [action = "get", keyPath, ...rest] = ctx.args.positional;
    const config = await admin<MemoryConfig>(ctx, "GET", "/api/config", undefined, (s) =>
        s.getConfig(),
    );
    if (action === "get") {
        if (!keyPath) {
            json(ctx, config);
            return 0;
        }
        const { parent, key } = walk(config, keyPath.split("."));
        const value = parent[key];
        if (typeof value === "string") ctx.out(value);
        else json(ctx, value);
        return 0;
    }
    if (action !== "set") throw new UsageError(`Unknown config action: ${action}`);
    if (!keyPath || rest.length === 0) throw new UsageError("Usage: config set <key.path> <value>");
    const raw = rest.join(" ");
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        value = raw;
    }
    const path = keyPath.split(".");
    const { parent, key } = walk(config, path);
    parent[key] = value;
    const saved = await admin<MemoryConfig>(ctx, "PUT", "/api/config", config, (s) =>
        s.setConfig(config),
    );
    const { parent: savedParent, key: savedKey } = walk(saved, path);
    const now = savedParent[savedKey];
    if (JSON.stringify(now) !== JSON.stringify(value)) {
        ctx.err(`Warning: the value was normalized to ${JSON.stringify(now)}`);
    }
    ctx.out(`${keyPath} = ${JSON.stringify(now)}`);
    return 0;
}

async function credentialCommand(ctx: Context): Promise<number> {
    const [action = "list", provider] = ctx.args.positional;
    if (action === "list") {
        const providers = await admin<ProviderInfo[]>(
            ctx,
            "GET",
            "/api/providers",
            undefined,
            (s) => s.providers(),
        );
        if (ctx.args.has("json")) json(ctx, providers);
        else {
            for (const entry of providers) {
                const state = entry.configured
                    ? `configured${entry.source ? ` (${entry.source})` : ""}`
                    : "no key";
                ctx.out(`${entry.id}: ${state}${entry.apiKey ? "" : ", no API key login"}`);
            }
        }
        return 0;
    }
    if (action !== "set" && action !== "remove") {
        throw new UsageError(`Unknown credential action: ${action}`);
    }
    if (!provider) throw new UsageError("Missing provider");
    const key = action === "set" ? await readSecret(ctx.io, `API key for ${provider}: `) : "";
    if (action === "set" && !key) throw new UsageError("The key is empty");
    await admin(ctx, "PUT", `/api/credentials/${encodeURIComponent(provider)}`, { key }, (s) =>
        s.setCredential(provider, key),
    );
    ctx.out(action === "set" ? `Saved the key for ${provider}` : `Removed the key for ${provider}`);
    return 0;
}

// Daemon and integrations -------------------------------------------------------------------------

async function daemonCommand(ctx: Context): Promise<number> {
    const action = ctx.args.positional[0] ?? "run";
    const { paths } = ctx;
    if (action === "run") {
        const { DaemonRunningError, startDaemon } = await import("./daemon/run.ts");
        const log = (message: string) =>
            ctx.err(`${new Date().toISOString()} [INFO] [DAEMON] ${message}`);
        let daemon;
        try {
            daemon = await startDaemon({ home: ctx.home });
        } catch (error) {
            if (error instanceof DaemonRunningError) {
                ctx.err(`The daemon runs already (process ${error.holder ?? "unknown"})`);
                return 1;
            }
            throw error;
        }
        log(`Listening on ${daemon.info.url} (process ${daemon.info.pid})`);
        await new Promise<void>((done) => {
            const stop = () => {
                process.off("SIGINT", stop);
                process.off("SIGTERM", stop);
                done();
            };
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
        });
        await daemon.stop();
        return 0;
    }
    if (action === "start") {
        let info = readDaemonInfo(paths);
        if (!info) {
            if (lockHolder(paths) === null) spawnDaemon(paths);
            info = await waitForDaemon(paths, STOP_WAIT_MS);
        }
        if (!info) {
            ctx.err(`The daemon did not start. See ${paths.logs}/daemon.log`);
            return 1;
        }
        ctx.out(`Daemon runs: process ${info.pid}, ${info.url}`);
        return 0;
    }
    if (action === "stop") {
        const pid = readDaemonInfo(paths)?.pid ?? lockHolder(paths);
        if (!pid) {
            ctx.out("The daemon does not run");
            return 0;
        }
        process.kill(pid, "SIGTERM");
        const deadline = Date.now() + STOP_WAIT_MS;
        while (pidAlive(pid) && Date.now() < deadline) {
            await new Promise((done) => setTimeout(done, 100));
        }
        if (pidAlive(pid)) {
            ctx.err(`Process ${pid} did not stop`);
            return 1;
        }
        ctx.out(`Stopped process ${pid}`);
        return 0;
    }
    if (action === "status") {
        const info = readDaemonInfo(paths);
        if (ctx.args.has("json")) json(ctx, info);
        else
            ctx.out(
                info ? `Daemon runs: process ${info.pid}, ${info.url}` : "The daemon does not run",
            );
        return info ? 0 : 1;
    }
    throw new UsageError(`Unknown daemon action: ${action}`);
}

async function mcpCommand(ctx: Context): Promise<number> {
    const { runMcpServer } = await import("./integrations/mcp.ts");
    const cwd = ctx.args.value("cwd");
    await runMcpServer({
        input: ctx.io.stdin,
        output: ctx.io.stdout,
        backend: new MemoryClient({ home: ctx.home }),
        harness: ctx.args.harness(),
        sessionId: ctx.args.value("session") ?? null,
        ...(cwd ? { cwd: resolve(ctx.io.cwd, cwd) } : {}),
        log: (message) => ctx.err(message),
    });
    return 0;
}

const COMMANDS: Record<string, Handler> = {
    setup: setupCommand,
    settings: settingsCommand,
    hook: hookCommandRun,
    l1: l1Command,
    search: searchCommand,
    location: locationCommand,
    import: importCommand,
    dream: dreamCommand,
    status: statusCommand,
    runs: runsCommand,
    sessions: sessionsCommand,
    revert: revertCommand,
    forget: forgetCommand,
    regenerate: regenerateCommand,
    projects: projectsCommand,
    register: registerCommand,
    rename: renameCommand,
    merge: mergeCommand,
    split: splitCommand,
    config: configCommand,
    credential: credentialCommand,
    daemon: daemonCommand,
    mcp: mcpCommand,
};

/**
 * Options that can come before the command name, for example `--home <dir> hook --harness pi`.
 * Only `--home` is global. It returns the global options and the command with its arguments.
 */
function splitGlobalOptions(argv: readonly string[]): { options: string[]; command: string[] } {
    const options: string[] = [];
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i] ?? "";
        if (arg.startsWith("--home=")) {
            if (arg === "--home=") throw new UsageError("--home needs a value");
            options.push(arg);
            i++;
        } else if (arg === "--home") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new UsageError("--home needs a value");
            }
            options.push(arg, value);
            i += 2;
        } else break;
    }
    return { options, command: argv.slice(i) };
}

/** Run the CLI. It returns the exit code: 0 OK, 1 runtime error, 2 usage error. */
export async function main(argv: string[], partial: Partial<CliIo> = {}): Promise<number> {
    const io: CliIo = {
        stdin: partial.stdin ?? process.stdin,
        stdout: partial.stdout ?? process.stdout,
        stderr: partial.stderr ?? process.stderr,
        env: partial.env ?? process.env,
        cwd: partial.cwd ?? process.cwd(),
    };
    const err = (line = "") => io.stderr.write(`${line}\n`);
    try {
        // Generated hook and MCP commands put `--home <dir>` before the command name.
        const { options, command } = splitGlobalOptions(argv);
        if (command.length === 0) {
            io.stderr.write(USAGE);
            return 2;
        }
        const [name, ...tail] = command;
        if (name === "help" || name === "--help" || name === "-h") {
            io.stdout.write(USAGE);
            return 0;
        }
        if (name === "version" || name === "--version") {
            io.stdout.write(`${packageVersion()}\n`);
            return 0;
        }
        const handler = COMMANDS[name ?? ""];
        if (!handler) throw new UsageError(`Unknown command: ${name}`);
        // Global options go first so that `--` still ends the options of the command.
        const args = new Args([...options, ...tail]);
        if (args.has("help")) {
            io.stdout.write(USAGE);
            return 0;
        }
        const homeFlag = args.value("home");
        const home = homeFlag ? resolve(io.cwd, homeFlag) : memoryHome(io.env);
        const ctx: Context = {
            args,
            io,
            home,
            paths: memoryPaths(home),
            commandHome: homeFlag ? home : io.env.LUNE_MEMORY_HOME ? home : null,
            out: (line = "") => io.stdout.write(`${line}\n`),
            err,
        };
        return await handler(ctx);
    } catch (error) {
        if (error instanceof UsageError) {
            err(`Error: ${error.message}`);
            err('Run "lune-memory help" for usage.');
            return 2;
        }
        err(`Error: ${errorMessage(error)}`);
        return 1;
    }
}

function isEntry(): boolean {
    try {
        const script = process.argv[1];
        return !!script && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntry()) process.exitCode = await main(process.argv.slice(2));
