import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import {
    loadConfig,
    memoryHome,
    normalizeConfig,
    saveConfig,
    type MemoryConfig,
} from "./core/config.ts";
import { MemoryOperationError } from "./core/errors.ts";
import { appendLog, formatLog, readLog, type LogDetails, type LogSnapshot } from "./core/log.ts";
import {
    globalViewPaths,
    memoryPaths,
    projectTranscriptDir,
    projectViewPaths,
    type MemoryPaths,
} from "./core/paths.ts";
import {
    HARNESSES,
    type Harness,
    type Item,
    type LocatorKind,
    type Project,
} from "./core/types.ts";
import { errorMessage } from "./core/util.ts";
import { FileCredentialStore, setApiKey } from "./dreaming/credentials.ts";
import { runDreamingPass, type DreamEvent, type PassSummary } from "./dreaming/index.ts";
import { Importer, type ImportSummary } from "./ingest/importer.ts";
import { relocateTranscripts } from "./ingest/transcripts.ts";
import { assembleL1, type L1Result } from "./memory/l1.ts";
import {
    retractNote,
    updateNote,
    writeNote,
    type NoteInput,
    type NoteResult,
} from "./memory/notes.ts";
import {
    currentGeneration,
    projectionStale,
    projectItem,
    regenerateProjection,
} from "./memory/projection.ts";
import { forgetSession, revertRun, type ForgetResult, type RevertResult } from "./memory/revert.ts";
import { transcriptSearch, type SearchOptions, type SearchResult } from "./memory/search.ts";
import { ProjectResolver } from "./projects/resolver.ts";
import { num, Store } from "./store/db.ts";
import { getProject, listProjects, listRuns, sessionFromRow, type RunRow } from "./store/rows.ts";

export type ServiceEventType = "import" | "dream" | "index" | "config" | "log";

/** Runtime event of the service. The daemon sends these over SSE. */
export interface ServiceEvent {
    type: ServiceEventType;
    at: string;
    data: Record<string, unknown>;
}

export type ServiceListener = (event: ServiceEvent) => void;

export interface ServiceOptions {
    /** Model registry. Tests give a registry with the faux provider. */
    models?: Models;
    now?: () => number;
}

export interface WriterIdentity {
    harness?: Harness | null;
    session?: string | null;
}

export interface MemoryLocation {
    home: string;
    /** Read-only Markdown views. A symlink to the current generation. */
    views: string;
    generation: string | null;
    projectId: string | null;
    projectName: string | null;
    branch: string | null;
    project: ReturnType<typeof projectViewPaths> | null;
    global: ReturnType<typeof globalViewPaths>;
    /** L4 transcripts of the project, or of sessions outside any project. */
    transcripts: string;
}

export interface SessionSummary {
    harness: Harness;
    id: string;
    title: string | null;
    projectId: string | null;
    branch: string | null;
    cwd: string | null;
    updatedAt: string | null;
    changedAt: string;
    revision: number;
    processed: boolean;
    attempts: number;
    lastError: string | null;
}

export interface ProviderInfo {
    id: string;
    name: string;
    /** The provider accepts an API key that lune-memory can store. */
    apiKey: boolean;
    configured: boolean;
    /** Where the credential comes from, for example an environment variable. */
    source: string | null;
    models: Array<{ id: string; name: string; reasoning: boolean }>;
}

export interface MemoryStatus {
    home: string;
    views: string;
    generation: string | null;
    /** Error of the last failed write of the views. Null when the views show the database. */
    viewsError: string | null;
    harnesses: Record<Harness, { enabled: boolean; root: string }>;
    dreaming: { enabled: boolean; model: string | null; thinking: string };
    counts: {
        projects: number;
        sessions: number;
        unprocessed: number;
        events: number;
        items: Record<string, number>;
    };
    lastRun: RunRow | null;
    lastPass: PassSummary | null;
}

export interface DreamRequest {
    trigger?: string;
    force?: boolean;
    projectId?: string | null;
    sessions?: string[];
    signal?: AbortSignal;
    /** Import before the pass. Default true. */
    importFirst?: boolean;
}

/**
 * One entry point to the memory backend. The daemon routes, the MCP fallback, the Pi
 * extension fallback and the CLI share it, so every path runs the same code.
 */
export class MemoryService {
    readonly paths: MemoryPaths;
    readonly store: Store;
    readonly resolver: ProjectResolver;
    private config: MemoryConfig;
    private importer: Importer;
    private registry: Models | null;
    private readonly now: () => number;
    private readonly listeners = new Set<ServiceListener>();
    private lastPass: PassSummary | null = null;
    private closed = false;

    private constructor(paths: MemoryPaths, store: Store, options: ServiceOptions) {
        this.paths = paths;
        this.store = store;
        this.now = options.now ?? Date.now;
        this.registry = options.models ?? null;
        this.config = loadConfig(paths.config);
        this.resolver = new ProjectResolver(store, { now: this.now });
        this.importer = new Importer(store, paths, this.config, this.resolver, { now: this.now });
    }

    static open(home: string = memoryHome(), options: ServiceOptions = {}): MemoryService {
        const paths = memoryPaths(home);
        const store = Store.open(paths.db);
        try {
            return new MemoryService(paths, store, options);
        } catch (error) {
            store.close();
            throw error;
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.listeners.clear();
        this.store.close();
    }

    /** Listen to runtime events. It returns the function that stops the listener. */
    on(listener: ServiceListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(type: ServiceEventType, data: Record<string, unknown>): void {
        const event: ServiceEvent = { type, at: new Date(this.now()).toISOString(), data };
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // A listener failure must not stop the service.
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Config

    getConfig(): MemoryConfig {
        return structuredClone(this.config);
    }

    /** Validate, save and apply a new config. Invalid values fall back to the defaults. */
    setConfig(raw: unknown): MemoryConfig {
        const config = normalizeConfig(raw);
        saveConfig(this.paths.config, config);
        this.config = config;
        this.importer = new Importer(this.store, this.paths, config, this.resolver, {
            now: this.now,
        });
        this.emit("config", { config: structuredClone(config) });
        return structuredClone(config);
    }

    /** Read the config file again, for example after `setup` changed it in another process. */
    reloadConfig(): MemoryConfig {
        this.config = loadConfig(this.paths.config);
        this.importer = new Importer(this.store, this.paths, this.config, this.resolver, {
            now: this.now,
        });
        return structuredClone(this.config);
    }

    // -----------------------------------------------------------------------------------------
    // L1, notes, search, location

    l1(input: {
        cwd?: string | null;
        harness?: Harness | null;
        sessionId?: string | null;
        announceSession?: boolean;
    }): L1Result {
        return assembleL1(this.store, this.paths, this.resolver, input.cwd ?? null, {
            harness: input.harness ?? null,
            sessionId: input.sessionId ?? null,
            ...(input.announceSession !== undefined
                ? { announceSession: input.announceSession }
                : {}),
        });
    }

    /**
     * Run a Note write and bring the Note into the views after the commit. A failed view write
     * does not undo the Note: the caller gets the error in `projectionError`, the error stays in
     * the database, and the next view write or the daemon repairs the views.
     */
    private withProjection(
        action: string,
        write: (onCommit: (item: Item) => void) => Item,
    ): NoteResult {
        let projectionError: string | undefined;
        const item = write((committed) => {
            try {
                projectItem(this.store, this.paths, committed, this.config, { now: this.now });
            } catch (error) {
                projectionError = errorMessage(error) || "unknown error";
            }
            this.emit("index", {
                action,
                itemId: committed.id,
                scope: committed.scope,
                projectId: committed.projectId,
                status: committed.status,
                ...(projectionError ? { projectionError } : {}),
            });
        });
        return projectionError ? { ...item, projectionError } : item;
    }

    noteWrite(input: NoteInput): NoteResult {
        return this.withProjection("note_write", (onCommit) =>
            writeNote(this.store, this.resolver, input, { now: this.now, onCommit }),
        );
    }

    noteUpdate(id: string, input: { title: string; body: string } & WriterIdentity): NoteResult {
        return this.withProjection("note_update", (onCommit) =>
            updateNote(this.store, id, input, { now: this.now, onCommit }),
        );
    }

    noteRetract(id: string, writer: WriterIdentity): NoteResult {
        return this.withProjection("note_retract", (onCommit) =>
            retractNote(this.store, id, writer, { now: this.now, onCommit }),
        );
    }

    /**
     * Search L4 transcripts. With a cwd and no project, the search stays in the project of the
     * cwd. A null project searches every project.
     */
    search(options: SearchOptions & { cwd?: string | null }): SearchResult {
        const { cwd, ...rest } = options;
        if (rest.projectId === undefined && cwd) {
            rest.projectId = this.resolver.resolve(cwd)?.projectId ?? null;
        }
        return transcriptSearch(this.store, rest);
    }

    location(cwd?: string | null): MemoryLocation {
        const resolution = cwd ? this.resolver.resolve(cwd) : null;
        const project = resolution ? getProject(this.store, resolution.projectId) : null;
        return {
            home: this.paths.home,
            views: this.paths.views,
            generation: currentGeneration(this.paths),
            projectId: project?.id ?? null,
            projectName: project?.name ?? null,
            branch: resolution?.branch ?? null,
            project: project ? projectViewPaths(this.paths, project.id) : null,
            global: globalViewPaths(this.paths),
            transcripts: projectTranscriptDir(this.paths, project?.id ?? null),
        };
    }

    // -----------------------------------------------------------------------------------------
    // Import and Dreaming

    log(message: string, details: LogDetails = {}): void {
        const context = { level: details.level ?? "info", source: details.source ?? "daemon" };
        const at = new Date(this.now()).toISOString();
        let failure: string | undefined;
        try {
            appendLog(this.paths, message, at, context);
        } catch (error) {
            failure = errorMessage(error);
            // Logging must not abort imports or escape the scheduler's timer callbacks.
            console.error(
                `${at} [ERROR] [DAEMON] Could not write daemon log: ${failure}\n${formatLog(message, at, context).trimEnd()}`,
            );
        }
        this.emit("log", { message, ...context, ...(failure ? { error: failure } : {}) });
    }

    logs(): LogSnapshot {
        return readLog(this.paths);
    }

    importNow(harnesses?: readonly Harness[]): ImportSummary {
        const summary = this.importer.importAll(harnesses ?? HARNESSES);
        for (const problem of summary.problems) {
            this.log(`Import failed for ${problem.path}: ${problem.error}`, {
                level: "error",
                source: "import",
            });
        }
        if (summary.imported > 0 || summary.errors > 0 || summary.purged > 0) {
            this.emit("import", {
                scanned: summary.scanned,
                imported: summary.imported,
                unchanged: summary.unchanged,
                skipped: summary.skipped,
                errors: summary.errors,
                purged: summary.purged,
                sessions: summary.sessions.map((session) => `${session.harness}:${session.id}`),
            });
        }
        return summary;
    }

    /** Import, then run one Dreaming pass. The pass never throws for a session failure. */
    async dream(request: DreamRequest = {}): Promise<PassSummary> {
        if (request.importFirst ?? true) {
            try {
                this.importNow();
            } catch (error) {
                this.emit("import", { error: errorMessage(error) });
            }
        }
        const summary = await runDreamingPass(this.store, this.paths, this.config, {
            trigger: request.trigger ?? "manual",
            ...(request.force ? { force: true } : {}),
            ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
            ...(request.sessions ? { sessions: request.sessions } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
            now: this.now(),
            models: this.models(),
            onEvent: (event: DreamEvent) => this.emit("dream", { ...event }),
        });
        if (summary.status !== "busy") this.lastPass = summary;
        return summary;
    }

    revert(runId: number, options: { reprocess?: boolean } = {}): RevertResult {
        const result = revertRun(this.store, this.paths, runId, {
            reprocess: options.reprocess ?? false,
            generations: this.config.generations,
            now: this.now,
        });
        this.emit("index", { action: "revert", ...result });
        return result;
    }

    forget(harness: Harness, sessionId: string): ForgetResult {
        const result = forgetSession(this.store, this.paths, harness, sessionId, {
            generations: this.config.generations,
            now: this.now,
        });
        this.emit("index", { action: "forget", ...result });
        return result;
    }

    /** Write a fresh projection generation from SQLite. */
    regenerate(): string {
        const result = regenerateProjection(this.store, this.paths, this.config, { now: this.now });
        this.emit("index", { action: "regenerate", generation: result.generation });
        return result.generation;
    }

    /**
     * Write the views again when an earlier view write failed. Null when the views show the
     * database now, else the error of this try.
     */
    repairViews(): string | null {
        if (!projectionStale(this.store)) return null;
        return this.regenerateQuietly();
    }

    // -----------------------------------------------------------------------------------------
    // Projects

    register(path: string, name?: string): Project {
        const project = this.resolver.register(path, name);
        this.afterProjectChange();
        return project;
    }

    rename(projectId: string, name: string): Project {
        this.resolver.rename(projectId, name);
        const project = getProject(this.store, projectId);
        if (!project) throw new MemoryOperationError(`Unknown project: ${projectId}`);
        this.regenerateQuietly();
        return project;
    }

    merge(source: string, target: string): { source: string; target: string } {
        const result = this.resolver.merge(source, target);
        this.afterProjectChange();
        return result;
    }

    split(
        kind: LocatorKind,
        value: string,
        name?: string,
    ): { project: Project; moved: number; items: number } {
        const result = this.resolver.split(kind, value, name);
        this.afterProjectChange();
        return result;
    }

    /** Move the transcripts of sessions that changed project, then write the views again. */
    private afterProjectChange(): void {
        relocateTranscripts(this.store, this.paths);
        this.regenerateQuietly();
    }

    /**
     * Write the views after a database change that is already done, so a failure does not fail
     * the change. The error goes out as an index event and stays in the database until a later
     * write succeeds. Null on success, else the error.
     */
    private regenerateQuietly(): string | null {
        try {
            this.regenerate();
            return null;
        } catch (error) {
            const projectionError = errorMessage(error) || "unknown error";
            this.emit("index", { action: "regenerate", projectionError });
            return projectionError;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Read models for the CLI and the settings UI

    status(): MemoryStatus {
        const count = (sql: string): number => num(this.store.get(sql) ?? { n: 0 }, "n");
        const items: Record<string, number> = {};
        for (const row of this.store.all(
            "SELECT status, COUNT(*) AS n FROM items GROUP BY status",
        )) {
            items[String(row.status)] = num(row, "n");
        }
        const harnesses = {} as Record<Harness, { enabled: boolean; root: string }>;
        for (const harness of HARNESSES) harnesses[harness] = { ...this.config.harnesses[harness] };
        return {
            home: this.paths.home,
            views: this.paths.views,
            generation: currentGeneration(this.paths),
            viewsError: projectionStale(this.store),
            harnesses,
            dreaming: {
                enabled: this.config.dreaming.enabled,
                model: this.config.dreaming.model,
                thinking: this.config.dreaming.thinking,
            },
            counts: {
                projects: count("SELECT COUNT(*) AS n FROM projects WHERE merged_into IS NULL"),
                sessions: count("SELECT COUNT(*) AS n FROM sessions"),
                unprocessed: count(
                    `SELECT COUNT(*) AS n FROM sessions
                    WHERE processed_revision IS NULL OR processed_revision < revision`,
                ),
                events: count("SELECT COUNT(*) AS n FROM events"),
                items,
            },
            lastRun: listRuns(this.store, 1)[0] ?? null,
            lastPass: this.lastPass,
        };
    }

    runs(limit = 20): RunRow[] {
        return listRuns(this.store, Math.max(1, Math.min(500, Math.trunc(limit))));
    }

    projects(
        includeMerged = false,
    ): Array<Project & { locators: Array<{ kind: LocatorKind; value: string }> }> {
        return listProjects(this.store, includeMerged).map((project) => ({
            ...project,
            locators: this.resolver.locators(project.id),
        }));
    }

    sessions(options: { limit?: number; projectId?: string | null } = {}): SessionSummary[] {
        const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 50)));
        const rows =
            options.projectId === undefined
                ? this.store.all("SELECT * FROM sessions ORDER BY changed_at DESC LIMIT ?", limit)
                : options.projectId === null
                  ? this.store.all(
                        "SELECT * FROM sessions WHERE project_id IS NULL ORDER BY changed_at DESC LIMIT ?",
                        limit,
                    )
                  : this.store.all(
                        "SELECT * FROM sessions WHERE project_id = ? ORDER BY changed_at DESC LIMIT ?",
                        options.projectId,
                        limit,
                    );
        return rows.map(sessionFromRow).map((session) => ({
            harness: session.harness,
            id: session.id,
            title: session.title,
            projectId: session.projectId,
            branch: session.branch,
            cwd: session.cwd,
            updatedAt: session.updatedAt,
            changedAt: session.changedAt,
            revision: session.revision,
            processed: session.processedRevision === session.revision,
            attempts: session.attempts,
            lastError: session.lastError,
        }));
    }

    // -----------------------------------------------------------------------------------------
    // Models and credentials

    /** Model registry of pi-ai with the credential file of lune-memory. */
    models(): Models {
        this.registry ??= builtinModels({
            credentials: new FileCredentialStore(this.paths.credentials),
        });
        return this.registry;
    }

    /** Providers that have a stored credential. Keys never leave the store. */
    async credentials(): Promise<Array<{ providerId: string; type: string }>> {
        const list = await new FileCredentialStore(this.paths.credentials).list();
        return list.map((entry) => ({ providerId: entry.providerId, type: entry.type }));
    }

    /** Store an API key for a provider. An empty key removes the stored credential. */
    async setCredential(providerId: string, key: string): Promise<void> {
        const provider = this.models().getProvider(providerId);
        if (!provider) throw new MemoryOperationError(`Unknown provider: ${providerId}`);
        if (!provider.auth.apiKey)
            throw new MemoryOperationError(`${provider.name} does not take an API key`);
        await setApiKey(new FileCredentialStore(this.paths.credentials), providerId, key);
        this.emit("config", { credential: providerId, set: key.trim().length > 0 });
    }

    /** Providers and chat models of pi-ai, with their auth state. */
    async providers(): Promise<ProviderInfo[]> {
        const models = this.models();
        const result: ProviderInfo[] = [];
        for (const provider of models.getProviders()) {
            let check: { source?: string } | undefined;
            try {
                check = await models.checkAuth(provider.id);
            } catch {
                check = undefined;
            }
            result.push({
                id: provider.id,
                name: provider.name,
                apiKey: Boolean(provider.auth.apiKey),
                configured: check !== undefined,
                source: check?.source ?? null,
                models: models.getModels(provider.id).map((model) => ({
                    id: model.id,
                    name: model.name,
                    reasoning: Boolean(model.reasoning),
                })),
            });
        }
        return result;
    }
}
