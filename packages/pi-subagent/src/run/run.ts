import { statSync } from "node:fs";

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    AgentSession,
    AgentSessionEvent,
    ModelRuntime,
    Theme,
} from "@earendil-works/pi-coding-agent";

import type { ExtensionTool } from "../extension-tools.ts";
import { formatModelRef, parseModelRef } from "../models.ts";
import { markUserMessage, SUBAGENT_GUIDE } from "./guide.ts";
import { openRunFile, readRunEntries, transcriptMessages, usageFromEntries } from "./run-file.ts";
import { errorDiagnostic, type Diagnostic, type LiveSession } from "./run-session.ts";
import { SessionSink, startRunSession, type RunEventTarget } from "./session-start.ts";
import {
    TURN_ENTRY_TYPE,
    type RunReport,
    type RunSnapshot,
    type RunState,
    type RunUsage,
    type SettledState,
    type StopSource,
    type TurnRecord,
} from "./types.ts";
import { assertWorktreeUsable } from "./worktree.ts";

/** The longest last message a turn without a report hands to the main agent. */
const MAX_UNREPORTED_CHARS = 20_000;
const MAX_DIAGNOSTICS = 50;

export type RunChange = "state" | "transcript";

/** What a run needs from the session that owns it. */
export interface RunHost {
    readonly agentDir: string;
    readonly modelRuntime?: ModelRuntime;
    projectTrusted(): boolean;
    theme(): Theme;
    /** The parent's current extension tools; a resumed run loads the extensions of its own again. */
    extensionTools(): readonly ExtensionTool[];
    onChange(run: Run, change: RunChange): void;
    onTurnEnd(run: Run, record: TurnRecord): void;
}

export interface RunIdentity {
    id: string;
    file: string;
    spawnEntryId: string;
    /** The session that started the run; a different one inherited it through /fork or /clone. */
    parentSessionId: string;
    readOnly: boolean;
}

export interface RunningTool {
    toolCallId: string;
    name: string;
    args: unknown;
    partialResult?: unknown;
    startedAt: number;
}

interface ActiveTurn {
    startedAt: string;
    /** Every report of the turn, oldest first; the last one is the turn's report. */
    reports: RunReport[];
    userWrote: boolean;
    stoppedBy?: StopSource;
    error?: string;
    /** Resolves once the turn's end is recorded. */
    ended: Promise<void>;
    end: () => void;
}

export type SendOutcome = "started" | "steered" | "deferred";

/**
 * One subagent run: its snapshot, its state, and its session while it is live.
 *
 * A turn is everything between accepting a message and the session's `agent_settled`; that event is
 * the only end of a turn, so steering messages and retries stay inside the turn they joined.
 */
export class Run implements RunEventTarget {
    readonly id: string;
    readonly file: string;
    readonly spawnEntryId: string;
    readonly parentSessionId: string;
    readonly readOnly: boolean;

    snapshot: RunSnapshot | undefined;
    /** Set when the run file could not be read; such a run shows as failed and cannot continue. */
    loadError: string | undefined;
    state: RunState = "idle";
    lastTurn: TurnRecord | undefined;
    turns = 0;
    usage: RunUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
    readonly diagnostics: Diagnostic[] = [];
    /** The assistant message being streamed, until its message_end. */
    streaming: AgentMessage | undefined;
    readonly runningTools = new Map<string, RunningTool>();
    /** A retry or compaction in progress. */
    activity: string | undefined;
    /** Bumped on every change, so views can cache what they derive from the run. */
    revision = 0;

    private readonly host: RunHost;
    private live: LiveSession | undefined;
    private opening: Promise<LiveSession> | undefined;
    private submitting: Promise<void> = Promise.resolve();
    private turn: ActiveTurn | undefined;
    /** A user message that Pi deferred to the next turn, which has not begun yet. */
    private deferredUserWrote = false;
    private fileCache: { mtimeMs: number; messages: AgentMessage[] } | undefined;

    constructor(identity: RunIdentity, host: RunHost) {
        this.id = identity.id;
        this.file = identity.file;
        this.spawnEntryId = identity.spawnEntryId;
        this.parentSessionId = identity.parentSessionId;
        this.readOnly = identity.readOnly;
        this.host = host;
    }

    /** A run from an earlier start of the parent session, read from its file. */
    static restore(identity: RunIdentity, host: RunHost): Run {
        const run = new Run(identity, host);

        try {
            const state = readRunEntries(openRunFile(identity.file).getEntries(), identity.file);

            run.snapshot = state.snapshot;
            run.lastTurn = state.lastTurn;
            run.turns = state.turns;
            run.usage = state.usage;
            // A turn that never recorded its end was cut off when the parent stopped.
            run.state = state.unfinishedTurn ? "interrupted" : (state.lastTurn?.state ?? "idle");
        } catch (error) {
            run.loadError = error instanceof Error ? error.message : String(error);
            run.state = "failed";
        }

        return run;
    }

    /** A new run whose session the manager already started and checked. */
    static started(
        identity: RunIdentity,
        snapshot: RunSnapshot,
        live: LiveSession,
        sink: SessionSink,
        host: RunHost,
    ): Run {
        const run = new Run(identity, host);

        run.snapshot = snapshot;
        run.live = live;
        sink.attach(run);

        return run;
    }

    get name(): string {
        return this.snapshot?.name ?? this.id;
    }

    get isLive(): boolean {
        return this.live !== undefined;
    }

    /** `provider/id` of the model the run's requests go to; the start value while it is not live. */
    get model(): string | undefined {
        const model = this.live?.session.model;

        return model ? formatModelRef(model) : this.snapshot?.model;
    }

    /** The live session's level, which Pi limits to what the model supports; else the start value. */
    get thinkingLevel(): ThinkingLevel | undefined {
        return this.live ? this.live.session.thinkingLevel : this.snapshot?.thinking;
    }

    /** Whether the user still has to see the outcome: a failure or a blocked task. */
    get needsAttention(): boolean {
        return this.state === "failed" || this.lastTurn?.report?.status === "blocked";
    }

    get needsInput(): boolean {
        return this.state !== "running" && this.lastTurn?.report?.status === "needs_input";
    }

    /** Start time of the turn in progress. */
    get turnStartedAt(): string | undefined {
        return this.turn?.startedAt;
    }

    /** The first turn: the task goes in unchanged, as the run's first user message. */
    async startTask(task: string): Promise<void> {
        await this.send(task, "main-agent");
    }

    /**
     * Steer a running run, or start a new turn. Resolves once the session accepted the message;
     * a session that is not live is reopened from the run file first.
     */
    async send(
        text: string,
        from: "main-agent" | "user",
        options: { signal?: AbortSignal; onProgress?: (text: string) => void } = {},
    ): Promise<SendOutcome> {
        this.assertWritable();

        // Pi marks a session busy only once a prompt reaches its run, after awaiting input handlers
        // and auth; a second prompt before that would start a second run instead of steering.
        const previous = this.submitting;
        let release!: () => void;

        this.submitting = new Promise<void>((resolve) => {
            release = resolve;
        });

        try {
            await previous;

            return await this.sendNow(text, from, options);
        } finally {
            release();
        }
    }

    private async sendNow(
        text: string,
        from: "main-agent" | "user",
        options: { signal?: AbortSignal; onProgress?: (text: string) => void },
    ): Promise<SendOutcome> {
        const session = await this.ensureLive(options);
        const message = from === "user" ? markUserMessage(text) : text;
        const userWrote = from === "user";

        if (this.state === "running") {
            const result = outcome(await this.submit(session, message, userWrote));

            if (userWrote) {
                if (result === "deferred") {
                    this.deferredUserWrote = true;
                } else if (this.turn) {
                    this.turn.userWrote = true;
                }
            }

            return result;
        }

        this.beginTurn(userWrote);

        try {
            return outcome(await this.submit(session, message, userWrote));
        } catch (error) {
            // The session rejected the message before its run began, so no agent_settled follows.
            // The caller gets the error, so the main agent is not notified as well.
            if (this.turn) {
                this.turn.error = error instanceof Error ? error.message : String(error);
                this.finishTurn(false, false);
            }

            throw error;
        }
    }

    /**
     * Abort the turn in progress and wait until its end is recorded; the session, the file and the
     * worktree stay.
     */
    async stop(by: StopSource): Promise<boolean> {
        const turn = this.turn;

        if (this.state !== "running" || !this.live || !turn) {
            return false;
        }

        turn.stoppedBy = by;
        await this.live.session.abort();
        // agent_settled comes before abort() resolves, except for a run that failed while it was
        // starting; that turn ends when its prompt rejects.
        await turn.ended;

        return true;
    }

    /** Close the live session; the run can be reopened from its file. */
    async close(): Promise<void> {
        const opening = this.opening;

        if (opening) {
            await opening.catch(() => undefined);
        }

        const live = this.live;

        this.live = undefined;

        if (live) {
            await live.close();
        }
    }

    /** The run's messages, from the live session or from its file. */
    transcript(): AgentMessage[] {
        if (this.live) {
            return transcriptMessages(this.live.session.sessionManager.getEntries());
        }

        if (this.loadError) {
            return [];
        }

        const mtimeMs = statSync(this.file).mtimeMs;

        if (this.fileCache?.mtimeMs !== mtimeMs) {
            this.fileCache = {
                mtimeMs,
                messages: transcriptMessages(openRunFile(this.file).getEntries()),
            };
        }

        return this.fileCache.messages;
    }

    handleEvent(event: AgentSessionEvent): void {
        switch (event.type) {
            case "agent_start":
                // A run can also start without a message from here, such as a built-in's triggerTurn.
                this.beginTurn(false);
                return;
            case "message_start":
            case "message_update":
                if (event.message.role === "assistant") {
                    this.streaming = event.message;
                    this.changed("transcript");
                }
                return;
            case "message_end":
                this.streaming = undefined;
                this.changed("transcript");
                return;
            case "tool_execution_start":
                this.runningTools.set(event.toolCallId, {
                    toolCallId: event.toolCallId,
                    name: event.toolName,
                    args: event.args,
                    startedAt: Date.now(),
                });
                this.changed("transcript");
                return;
            case "tool_execution_update": {
                const tool = this.runningTools.get(event.toolCallId);

                if (tool) {
                    tool.partialResult = event.partialResult;
                    this.changed("transcript");
                }
                return;
            }
            case "tool_execution_end":
                this.runningTools.delete(event.toolCallId);
                this.changed("transcript");
                return;
            case "auto_retry_start":
                this.activity = `Retrying ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`;
                this.changed("state");
                return;
            case "auto_retry_end":
            case "compaction_end":
                if (event.type === "compaction_end" && event.errorMessage) {
                    this.addDiagnostic({
                        level: "error",
                        message: `Compaction failed: ${event.errorMessage}`,
                        at: Date.now(),
                    });
                }
                this.activity = undefined;
                this.changed("state");
                return;
            case "compaction_start":
                this.activity = "Compacting the context";
                this.changed("state");
                return;
            case "agent_settled":
                this.finishTurn(event.aborted);
                return;
            default:
                return;
        }
    }

    addDiagnostic(diagnostic: Diagnostic): void {
        this.diagnostics.push(diagnostic);

        if (this.diagnostics.length > MAX_DIAGNOSTICS) {
            this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
        }

        this.changed("state");
    }

    recordReport(report: RunReport): void {
        // The tool only runs inside a turn. A message that reaches the run after its report keeps
        // the turn going, and the main agent must still get the report it replaces.
        this.turn?.reports.push(report);
    }

    private assertWritable(): void {
        if (this.readOnly) {
            throw new Error(
                `Run ${this.name} (${this.id}) belongs to session ${this.parentSessionId} and came ` +
                    "here through /fork or /clone, so it is read-only. Start a new run to continue " +
                    "that work.",
            );
        }

        if (this.loadError || !this.snapshot) {
            throw new Error(`Run ${this.id} cannot continue: ${this.loadError ?? "no snapshot"}`);
        }
    }

    private async ensureLive(options: {
        signal?: AbortSignal;
        onProgress?: (text: string) => void;
    }): Promise<AgentSession> {
        if (this.live) {
            return this.live.session;
        }

        this.opening ??= this.reopen(options).finally(() => {
            this.opening = undefined;
        });

        return (await this.opening).session;
    }

    /** Recreate the session from the snapshot, in the same working directory. */
    private async reopen(options: {
        signal?: AbortSignal;
        onProgress?: (text: string) => void;
    }): Promise<LiveSession> {
        const snapshot = this.snapshot!;

        if (snapshot.worktree) {
            await assertWorktreeUsable(snapshot.worktree, snapshot.cwd);
        } else if (!isDirectory(snapshot.cwd)) {
            throw new Error(`The run's working directory is missing: ${snapshot.cwd}`);
        }

        const model = parseModelRef(snapshot.model);

        if (!model) {
            throw new Error(`The run snapshot has an invalid model: ${snapshot.model}`);
        }

        const sink = new SessionSink();

        sink.attach(this);

        const live = await startRunSession({
            cwd: snapshot.cwd,
            agentDir: this.host.agentDir,
            projectTrusted: this.host.projectTrusted(),
            modelRuntime: this.host.modelRuntime,
            appendSystemPrompt: [snapshot.definition?.body ?? "", SUBAGENT_GUIDE],
            model,
            thinkingLevel: snapshot.thinking,
            // The snapshot's list is the allowlist from now on, the default selection included.
            tools: snapshot.tools,
            check: snapshot.tools,
            extensionTools: this.host.extensionTools(),
            reason: "resume",
            theme: this.host.theme(),
            openSessionManager: () => openRunFile(this.file),
            sink,
            signal: options.signal,
            onProgress: options.onProgress,
        });

        this.live = live;
        this.usage = usageFromEntries(live.session.sessionManager.getEntries());
        this.changed("state");

        return live;
    }

    /**
     * Hand a message to the session and wait until it is accepted.
     *
     * A prompt that arrives while the session emits agent_settled is deferred by Pi and returns
     * before any preflight; it runs, and starts its own turn, once the settle finishes.
     */
    private submit(
        session: AgentSession,
        message: string,
        userWrote: boolean,
    ): Promise<"started" | "queued" | "deferred"> {
        return new Promise((resolve, reject) => {
            let answered = false;

            session
                .prompt(message, {
                    expandPromptTemplates: false,
                    source: "extension",
                    streamingBehavior: "steer",
                    preflightResult: (disposition) => {
                        if (disposition === "started") {
                            this.beginTurn(userWrote);
                        }

                        if (answered) {
                            return;
                        }

                        answered = true;

                        if (disposition === "handled") {
                            reject(
                                new Error("The run session consumed the message without a turn."),
                            );
                        } else {
                            resolve(disposition);
                        }
                    },
                })
                .then(
                    () => {
                        if (!answered) {
                            answered = true;
                            resolve("deferred");
                        }
                    },
                    (error: unknown) => {
                        if (!answered) {
                            answered = true;
                            reject(error);
                            return;
                        }

                        // The turn's own end reports its outcome; this error must still stay visible.
                        this.addDiagnostic(errorDiagnostic("The run's turn failed", error));
                    },
                );
        });
    }

    private beginTurn(userWrote: boolean): void {
        if (this.turn) {
            this.turn.userWrote ||= userWrote;
            return;
        }

        let end!: () => void;
        const ended = new Promise<void>((resolve) => {
            end = resolve;
        });

        this.turn = {
            startedAt: new Date().toISOString(),
            reports: [],
            userWrote: userWrote || this.deferredUserWrote,
            ended,
            end,
        };
        this.deferredUserWrote = false;
        this.state = "running";
        this.changed("state");
    }

    private finishTurn(aborted: boolean, notify = true): void {
        const turn: Omit<ActiveTurn, "ended" | "end"> = this.turn ?? {
            startedAt: new Date().toISOString(),
            reports: [],
            userWrote: false,
        };
        const session = this.live?.session;
        const last = session?.messages.findLast(
            (message): message is AssistantMessage => message.role === "assistant",
        );
        let state: SettledState = "idle";
        let error = turn.error;

        if (aborted) {
            state = "interrupted";
        } else if (error) {
            state = "failed";
        } else if (last?.stopReason === "error") {
            state = "failed";
            error = last.errorMessage ?? "The model request failed.";
        }

        const record: TurnRecord = {
            state,
            userWrote: turn.userWrote,
            startedAt: turn.startedAt,
            endedAt: new Date().toISOString(),
        };

        const report = turn.reports.at(-1);

        if (report) {
            record.report = report;

            if (turn.reports.length > 1) {
                record.earlierReports = turn.reports.slice(0, -1);
            }
        } else {
            record.unreportedMessage = limitText(session?.getLastAssistantText() ?? "");
        }

        if (error) {
            record.error = error;
        }

        if (turn.stoppedBy) {
            record.stoppedBy = turn.stoppedBy;
        }

        if (session) {
            try {
                session.sessionManager.appendCustomEntry(TURN_ENTRY_TYPE, record);
            } catch (appendError) {
                this.addDiagnostic(
                    errorDiagnostic("Recording the turn in the run file failed", appendError),
                );
            }

            this.usage = usageFromEntries(session.sessionManager.getEntries());
        }

        const active = this.turn;

        this.turn = undefined;
        this.lastTurn = record;
        this.state = state;
        this.turns += 1;
        this.streaming = undefined;
        this.runningTools.clear();
        this.activity = undefined;
        this.changed("state");
        active?.end();

        if (notify) {
            this.host.onTurnEnd(this, record);
        }
    }

    private changed(change: RunChange): void {
        this.revision += 1;
        this.host.onChange(this, change);
    }
}

/** A message queued into a busy session steers the turn in progress. */
function outcome(disposition: "started" | "queued" | "deferred"): SendOutcome {
    return disposition === "queued" ? "steered" : disposition;
}

function limitText(text: string): string {
    if (text.length <= MAX_UNREPORTED_CHARS) {
        return text;
    }

    return (
        `${text.slice(0, MAX_UNREPORTED_CHARS)}\n` +
        `[${text.length - MAX_UNREPORTED_CHARS} more characters in the run transcript]`
    );
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}
