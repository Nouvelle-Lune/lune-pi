import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    ExtensionContext,
    ModelRuntime,
    SessionBeforeTreeEvent,
    SessionBeforeTreeResult,
    Theme,
} from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "../definitions.ts";
import { allowedModelRefs, formatModelRef, parseModelRef } from "../models.ts";
import {
    RUN_NOTIFICATION_TYPE,
    RunNotifier,
    buildRunNotification,
    type RunNotice,
} from "../notify/notifier.ts";
import { runSessionFile, runWorktreePath } from "../paths.ts";
import { SUBAGENT_GUIDE } from "./guide.ts";
import { REPORT_TOOL_NAME } from "./report-tool.ts";
import { createRunFile } from "./run-file.ts";
import { Run, type RunChange, type RunHost, type SendOutcome } from "./run.ts";
import type { LiveSession } from "./run-session.ts";
import { SessionSink, startRunSession } from "./session-start.ts";
import {
    RUN_ENTRY_TYPE,
    type Isolation,
    type RunSnapshot,
    type SpawnEntryData,
    type StopSource,
    type TurnRecord,
    type ValueSource,
} from "./types.ts";
import { createRunWorktree, removeRunWorktree, type CreatedWorktree } from "./worktree.ts";

export interface StartParams {
    task: string;
    agent?: string;
    model?: string;
    thinking?: ThinkingLevel;
    tools?: string[];
    isolation?: Isolation;
}

export interface ProgressOptions {
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
}

export type ManagerListener = (change: RunChange, run: Run | undefined) => void;

/**
 * All runs of one parent session, on every branch, and their lifecycle.
 *
 * Created at the parent's `session_start` and shut down with it: Pi replaces the extension runtime
 * on /new, /resume, /fork and /reload, and runs never outlive the session that owns them.
 */
export class RunManager implements RunHost {
    readonly agentDir: string;
    readonly modelRuntime: ModelRuntime | undefined;
    readonly sessionId: string;

    private readonly pi: ExtensionAPI;
    private readonly ctx: ExtensionContext;
    private readonly definitions: readonly AgentDefinition[];
    private readonly runs = new Map<string, Run>();
    /** Ended turns of runs on another branch; sent when their branch is active again. */
    private readonly deferred = new Map<string, RunNotice[]>();
    private readonly notifier: RunNotifier;
    private readonly listeners = new Set<ManagerListener>();
    private readonly reservedIds = new Set<string>();
    private inlineCount = 0;
    private shuttingDown = false;

    constructor(options: {
        pi: ExtensionAPI;
        ctx: ExtensionContext;
        agentDir: string;
        definitions: readonly AgentDefinition[];
        /** Tests only: a runtime with an offline provider. Runs otherwise create their own. */
        modelRuntime?: ModelRuntime;
    }) {
        this.pi = options.pi;
        this.ctx = options.ctx;
        this.agentDir = options.agentDir;
        this.modelRuntime = options.modelRuntime;
        this.definitions = options.definitions;
        this.sessionId = options.ctx.sessionManager.getSessionId();
        this.notifier = new RunNotifier(
            options.pi,
            options.ctx.hasUI ? options.ctx.ui : undefined,
            {
                deliverable: (notice) => {
                    const run = this.runs.get(notice.runId);

                    return run !== undefined && this.isOnBranch(run);
                },
                hold: (notice) => this.defer(notice),
            },
        );
    }

    // RunHost

    projectTrusted(): boolean {
        return this.ctx.isProjectTrusted();
    }

    theme(): Theme {
        return this.ctx.ui.theme;
    }

    onChange(run: Run, change: RunChange): void {
        this.emit(change, run);
    }

    onTurnEnd(run: Run, record: TurnRecord): void {
        // The main agent asked for the stop itself; a shutdown has nobody left to tell.
        if (
            this.shuttingDown ||
            record.stoppedBy === "main-agent" ||
            record.stoppedBy === "shutdown"
        ) {
            return;
        }

        const notice: RunNotice = { runId: run.id, name: run.name, record };

        // The notifier checks the branch again when the batch goes out.
        if (this.isOnBranch(run)) {
            this.notifier.push(notice);
        } else {
            this.defer(notice);
        }
    }

    // Queries

    subscribe(listener: ManagerListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Read every run of this session tree from its file; restored runs are not live. */
    restore(): void {
        for (const entry of this.ctx.sessionManager.getEntries()) {
            if (entry.type !== "custom" || entry.customType !== RUN_ENTRY_TYPE) {
                continue;
            }

            const data = entry.data as Partial<SpawnEntryData> | undefined;

            if (
                typeof data?.runId !== "string" ||
                typeof data.sessionFile !== "string" ||
                typeof data.parentSessionId !== "string" ||
                this.runs.has(data.runId)
            ) {
                continue;
            }

            const run = Run.restore(
                {
                    id: data.runId,
                    file: data.sessionFile,
                    spawnEntryId: entry.id,
                    parentSessionId: data.parentSessionId,
                    readOnly: data.parentSessionId !== this.sessionId,
                },
                this,
            );

            this.runs.set(run.id, run);
            this.countInlineName(run);
        }
    }

    /** Runs whose `subagent_start` is on the active branch, in start order. */
    branchRuns(): Run[] {
        const ids = new Set(this.ctx.sessionManager.getBranch().map((entry) => entry.id));

        return [...this.runs.values()].filter((run) => ids.has(run.spawnEntryId));
    }

    /** Runs started on other branches; the inspector lists them so a report can be copied over. */
    otherBranchRuns(): Run[] {
        const ids = new Set(this.ctx.sessionManager.getBranch().map((entry) => entry.id));

        return [...this.runs.values()].filter((run) => !ids.has(run.spawnEntryId));
    }

    isOnBranch(run: Run): boolean {
        return this.ctx.sessionManager.getBranch().some((entry) => entry.id === run.spawnEntryId);
    }

    /** Whether an ended turn of this run waits for its branch to become active. */
    hasDeferred(run: Run): boolean {
        return this.deferred.has(run.id);
    }

    /** The run with this ID on the active branch; the tools never reach runs on other branches. */
    branchRun(runId: string): Run {
        const run = this.runs.get(runId);

        if (run && this.isOnBranch(run)) {
            return run;
        }

        const known = this.branchRuns().map((other) => `${other.id} (${other.name})`);

        throw new Error(
            `No subagent run "${runId}" on the current branch.` +
                (known.length > 0
                    ? ` Runs here: ${known.join(", ")}.`
                    : " There are no runs here."),
        );
    }

    // Operations

    async start(
        params: StartParams,
        ctx: ExtensionContext,
        options: ProgressOptions = {},
    ): Promise<Run> {
        this.assertActive();

        const definition = this.resolveDefinition(params.agent);
        const model = this.resolveModel(params, definition, ctx);
        const thinking = params.thinking ?? definition?.thinking ?? ctx.thinkingLevel;
        const thinkingSource: ValueSource =
            params.thinking !== undefined
                ? "call"
                : definition?.thinking !== undefined
                  ? "definition"
                  : ctx.thinkingLevel !== undefined
                    ? "parent"
                    : "settings";
        const taskTools = params.tools ?? definition?.tools;
        const toolsSource: ValueSource =
            params.tools !== undefined
                ? "call"
                : definition?.tools !== undefined
                  ? "definition"
                  : "settings";
        const isolation = params.isolation ?? definition?.isolation ?? "shared";
        const isolationSource: ValueSource =
            params.isolation !== undefined
                ? "call"
                : definition?.isolation !== undefined
                  ? "definition"
                  : "default";

        const runId = this.reserveRunId();
        const name = definition?.name ?? `run-${++this.inlineCount}`;
        const file = runSessionFile(this.sessionId, runId, this.agentDir);
        let worktree: CreatedWorktree | undefined;
        let fileCreated = false;
        let live: LiveSession | undefined;

        // Everything before the spawn entry is undone on failure; nothing refers to it yet.
        const undo = async (error: unknown): Promise<never> => {
            const problems: string[] = [];

            if (live) {
                await live.close();
            }

            if (fileCreated) {
                try {
                    rmSync(file, { force: true });
                } catch (removeError) {
                    problems.push(
                        `The run file ${file} could not be removed: ${message(removeError)}`,
                    );
                }
            }

            if (worktree) {
                try {
                    await removeRunWorktree(worktree.repoRoot, worktree.path);
                } catch (removeError) {
                    problems.push(
                        `The worktree ${worktree.path} could not be removed: ${message(removeError)}`,
                    );
                }
            }

            this.reservedIds.delete(runId);

            throw new Error([message(error), ...problems].join("\n"), { cause: error });
        };

        let cwd = ctx.cwd;
        let spawnEntryId: string;
        const sink = new SessionSink();

        try {
            if (isolation === "worktree") {
                options.onProgress?.("Creating the worktree");
                worktree = await createRunWorktree(
                    ctx.cwd,
                    runWorktreePath(this.sessionId, runId, this.agentDir),
                    options.signal,
                );
                cwd = worktree.cwd;
            }

            live = await startRunSession({
                cwd,
                agentDir: this.agentDir,
                projectTrusted: ctx.isProjectTrusted(),
                modelRuntime: this.modelRuntime,
                appendSystemPrompt: [definition?.body ?? "", SUBAGENT_GUIDE],
                model: model.ref,
                thinkingLevel: thinking,
                // An explicit selection is the allowlist; otherwise `+report` keeps the run's own
                // defaultTools selection and adds the protocol tool to it.
                tools: taskTools
                    ? [...new Set([...taskTools, REPORT_TOOL_NAME])]
                    : [`+${REPORT_TOOL_NAME}`],
                check: taskTools ?? "default",
                reason: "startup",
                theme: ctx.ui.theme,
                openSessionManager: () => {
                    const manager = createRunFile(file, {
                        runId,
                        cwd,
                        parentSessionFile: this.ctx.sessionManager.getSessionFile(),
                    });

                    fileCreated = true;

                    return manager;
                },
                sink,
                signal: options.signal,
                onProgress: options.onProgress,
            });

            this.assertActive();
            this.pi.appendEntry<SpawnEntryData>(RUN_ENTRY_TYPE, {
                runId,
                sessionFile: file,
                parentSessionId: this.sessionId,
            });
            spawnEntryId = this.findSpawnEntryId(runId);
        } catch (error) {
            return undo(error);
        }

        const session = live.session;
        const snapshot: RunSnapshot = {
            runId,
            name,
            ...(definition
                ? {
                      definition: {
                          name: definition.name,
                          body: definition.body,
                          file: definition.file,
                      },
                  }
                : {}),
            task: params.task,
            model: formatModelRef(session.model ?? model.ref),
            thinking: session.thinkingLevel,
            // An MCP name in an allowlist would hide the run's other MCP tools when it reopens,
            // and the default selection never names one.
            tools: taskTools
                ? [...new Set([...taskTools, REPORT_TOOL_NAME])]
                : session.getActiveToolNames().filter((tool) => !tool.startsWith("mcp__")),
            sources: {
                model: model.source,
                thinking: thinkingSource,
                tools: toolsSource,
                isolation: isolationSource,
            },
            isolation,
            cwd,
            ...(worktree
                ? {
                      worktree: {
                          repoRoot: worktree.repoRoot,
                          path: worktree.path,
                          baseCommit: worktree.baseCommit,
                      },
                  }
                : {}),
            parentSessionId: this.sessionId,
            parentSessionFile: this.ctx.sessionManager.getSessionFile(),
            spawnEntryId,
            createdAt: new Date().toISOString(),
        };

        const identity = {
            id: runId,
            file,
            spawnEntryId: snapshot.spawnEntryId,
            parentSessionId: this.sessionId,
            readOnly: false,
        };

        try {
            session.sessionManager.appendCustomEntry(RUN_ENTRY_TYPE, snapshot);
        } catch (error) {
            // The spawn entry exists already, so the run stays listed, as failed, with this error.
            await live.close();
            this.runs.set(runId, Run.restore(identity, this));
            this.reservedIds.delete(runId);
            this.emit("state", this.runs.get(runId));

            throw new Error(
                `Run ${name} (${runId}) could not record its snapshot: ${message(error)}`,
                { cause: error },
            );
        }

        const run = Run.started(identity, snapshot, live, sink, this);

        this.runs.set(runId, run);
        this.reservedIds.delete(runId);
        this.emit("state", run);

        try {
            await run.startTask(params.task);
        } catch (error) {
            throw new Error(
                `Run ${name} (${runId}) could not start its task: ${message(error)}\n` +
                    "The run is kept as failed; continue it with subagent_send once the cause is fixed.",
                { cause: error },
            );
        }

        return run;
    }

    async send(
        run: Run,
        text: string,
        from: "main-agent" | "user",
        options: ProgressOptions = {},
    ): Promise<SendOutcome> {
        this.assertActive();

        return run.send(text, from, options);
    }

    async stop(run: Run, by: StopSource): Promise<boolean> {
        this.assertActive();

        return run.stop(by);
    }

    /**
     * Copy the last turn of a run on another branch to the active branch as a custom message. It
     * does not trigger a turn: while the main agent works, Pi holds it until the turn ends.
     */
    copyReport(run: Run): void {
        if (this.isOnBranch(run)) {
            throw new Error(
                `Run ${run.name} is on this branch; its turns reach the main agent already.`,
            );
        }

        if (!run.lastTurn) {
            throw new Error(`Run ${run.name} has no ended turn to copy.`);
        }

        const { content, details } = buildRunNotification([
            { runId: run.id, name: run.name, record: run.lastTurn, copied: true },
        ]);

        this.pi.sendMessage({ customType: RUN_NOTIFICATION_TYPE, content, display: true, details });
    }

    /**
     * Leaving a branch with running runs asks once whether to stop them. Without a UI they keep
     * running. A navigation that goes ahead holds every notification until it ends.
     */
    async beforeTree(
        event: SessionBeforeTreeEvent,
        ctx: ExtensionContext,
    ): Promise<SessionBeforeTreeResult | undefined> {
        const running = this.runsLeaving(event.preparation, ctx);
        let stopping = false;

        if (running.length > 0 && ctx.hasUI) {
            const keep = "Keep them running";
            const stop = "Stop them";
            const choice = await ctx.ui.select(
                `${running.length} subagent run${running.length === 1 ? " is" : "s are"} still ` +
                    `running on the branch you are leaving: ${running.map((run) => run.name).join(", ")}.`,
                [keep, stop],
                { signal: event.signal },
            );

            if (choice === undefined) {
                return { cancel: true };
            }

            stopping = choice === stop;
        }

        this.holdNotifications(event.signal);

        if (stopping) {
            await Promise.all(running.map((run) => run.stop("branch")));
        }

        return undefined;
    }

    /** After navigation: send what waited for the branch that is now active. */
    afterTree(): void {
        for (const [runId, notices] of this.deferred) {
            const run = this.runs.get(runId);

            if (run && this.isOnBranch(run)) {
                for (const notice of notices) {
                    this.notifier.push(notice);
                }

                this.deferred.delete(runId);
            }
        }

        this.notifier.resume();
        this.emit("state", undefined);
    }

    /**
     * Called when the main agent starts a turn. A navigation that another extension cancelled, or
     * that failed, ends without `session_tree`, and its held notices must not wait forever.
     */
    resumeNotifications(): void {
        this.notifier.resume();
    }

    /**
     * Stop notifying, interrupt running runs, then shut down every live session, idle ones included,
     * so the built-ins close their connections before the sessions are disposed.
     */
    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        this.notifier.dispose();
        this.deferred.clear();

        await Promise.all(
            [...this.runs.values()].map(async (run) => {
                try {
                    await run.stop("shutdown");
                } catch (error) {
                    console.error(`Stopping subagent run ${run.id} failed: ${message(error)}`);
                }

                try {
                    await run.close();
                } catch (error) {
                    console.error(`Closing subagent run ${run.id} failed: ${message(error)}`);
                }
            }),
        );

        this.listeners.clear();
    }

    private assertActive(): void {
        if (this.shuttingDown) {
            throw new Error("The parent session is shutting down.");
        }
    }

    /** Keep an ended turn of a run on another branch until that branch is active again. */
    private defer(notice: RunNotice): void {
        this.deferred.set(notice.runId, [...(this.deferred.get(notice.runId) ?? []), notice]);
        this.emit("state", this.runs.get(notice.runId));
    }

    /**
     * Notices wait while the session tree changes: sent then, one could land on the branch being
     * left, or start a turn of the main agent during the navigation. Pi emits `session_tree` only
     * after a completed navigation, so an aborted one releases them through its signal.
     */
    private holdNotifications(signal: AbortSignal): void {
        this.notifier.pause();
        signal.addEventListener("abort", () => this.notifier.resume(), { once: true });
    }

    /** Running runs whose spawn entry is on the part of the branch that the navigation leaves. */
    private runsLeaving(
        preparation: SessionBeforeTreeEvent["preparation"],
        ctx: ExtensionContext,
    ): Run[] {
        const { oldLeafId, commonAncestorId } = preparation;

        if (!oldLeafId) {
            return [];
        }

        const path = ctx.sessionManager.getBranch(oldLeafId);
        const start = commonAncestorId
            ? path.findIndex((entry) => entry.id === commonAncestorId) + 1
            : 0;
        const leaving = new Set(path.slice(start).map((entry) => entry.id));

        return [...this.runs.values()].filter(
            (run) => run.state === "running" && leaving.has(run.spawnEntryId),
        );
    }

    private emit(change: RunChange, run: Run | undefined): void {
        for (const listener of this.listeners) {
            listener(change, run);
        }
    }

    private resolveDefinition(agent: string | undefined): AgentDefinition | undefined {
        if (agent === undefined) {
            return undefined;
        }

        const definition = this.definitions.find((candidate) => candidate.name === agent);

        if (!definition) {
            const names = this.definitions.map((candidate) => candidate.name);

            throw new Error(
                `No subagent definition named "${agent}".` +
                    (names.length > 0 ? ` Loaded: ${names.join(", ")}.` : " None are loaded."),
            );
        }

        return definition;
    }

    /**
     * Requested models must be in the parent's allowed set. The parent's own current model is used
     * as it is, since Pi lets a session's default model sit outside its scope.
     */
    private resolveModel(
        params: StartParams,
        definition: AgentDefinition | undefined,
        ctx: ExtensionContext,
    ): { ref: { provider: string; id: string }; source: ValueSource } {
        const requested = params.model ?? definition?.model;

        if (requested === undefined) {
            if (!ctx.model) {
                throw new Error("The main agent has no current model for the run to inherit.");
            }

            return { ref: { provider: ctx.model.provider, id: ctx.model.id }, source: "parent" };
        }

        const ref = parseModelRef(requested);

        if (!ref) {
            throw new Error(`Invalid model "${requested}": use provider/id.`);
        }

        const allowed = allowedModelRefs(ctx);

        if (!allowed.includes(requested)) {
            throw new Error(
                `The model ${requested} is not in the allowed set` +
                    (allowed.length > 0
                        ? `: ${allowed.join(", ")}.`
                        : "; no models are available."),
            );
        }

        return { ref, source: params.model !== undefined ? "call" : "definition" };
    }

    private reserveRunId(): string {
        for (;;) {
            const id = randomBytes(4).toString("hex");

            if (
                !this.runs.has(id) &&
                !this.reservedIds.has(id) &&
                !existsSync(runSessionFile(this.sessionId, id, this.agentDir))
            ) {
                this.reservedIds.add(id);

                return id;
            }
        }
    }

    /** Inherited runs count too, so a new inline run never shares a name with one in the list. */
    private countInlineName(run: Run): void {
        const match = /^run-(\d+)$/.exec(run.name);

        if (match) {
            this.inlineCount = Math.max(this.inlineCount, Number(match[1]));
        }
    }

    /** `pi.appendEntry()` returns nothing, so the new entry is found by its run ID. */
    private findSpawnEntryId(runId: string): string {
        const entries = this.ctx.sessionManager.getEntries();

        for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index]!;

            if (
                entry.type === "custom" &&
                entry.customType === RUN_ENTRY_TYPE &&
                (entry.data as Partial<SpawnEntryData> | undefined)?.runId === runId
            ) {
                return entry.id;
            }
        }

        throw new Error(`The spawn entry of run ${runId} is missing from the parent session.`);
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
