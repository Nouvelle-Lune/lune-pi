import type {
    ExtensionAPI,
    ExtensionUIContext,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type {
    ReportStatus,
    RunReport,
    SettledState,
    StopSource,
    TurnRecord,
} from "../run/types.ts";

/** Custom message type of a batch of ended turns; the transcript box is registered for it. */
export const RUN_NOTIFICATION_TYPE = "lune-subagent-notification";

const SECTION_SEPARATOR = "\n\n---\n\n";

/** One ended turn as the main agent is told about it. */
export interface RunNotice {
    runId: string;
    name: string;
    /** The user-facing title; the model-facing text names the run by its ID only. */
    title?: string;
    record: TurnRecord;
    /** The user copied it from the inspector; the run belongs to another branch. */
    copied?: boolean;
}

/**
 * Where a text sits in the content. The box reads report texts from there rather than from a second
 * copy in details, which are stored too.
 */
export interface ContentSlice {
    start: number;
    end: number;
}

/** A report that a later report of the same turn replaced. */
export interface EarlierReportNote {
    status: ReportStatus;
    reason?: string;
    question?: string;
    summary: ContentSlice;
}

export interface RunNotificationRun {
    runId: string;
    name: string;
    copied?: boolean;
    /** The end of the turn; with the run ID it names the turn. Older messages do not have it. */
    endedAt?: string;
    state: SettledState;
    reportStatus?: ReportStatus;
    reason?: string;
    question?: string;
    error?: string;
    userWrote: boolean;
    stoppedBy?: StopSource;
    durationMs?: number;
    /** The turn's earlier reports, oldest first. */
    earlierReports?: EarlierReportNote[];
    /** The report summary, or the last message of an unreported turn. */
    body: ContentSlice;
}

export interface RunNotificationDetails {
    runs: RunNotificationRun[];
}

/** The model-facing text and the box-facing details of one batch; they share the offsets. */
export function buildRunNotification(batch: readonly RunNotice[]): {
    content: string;
    details: RunNotificationDetails;
} {
    let content = "";
    const runs: RunNotificationRun[] = [];

    for (const { runId, name, title, record, copied } of batch) {
        if (content !== "") {
            content += SECTION_SEPARATOR;
        }

        const section = new SectionWriter(content.length);
        const report = record.report;
        const earlierReports: EarlierReportNote[] = [];

        if (copied) {
            section.line(
                `The user copied the last turn of subagent run ${runId} from another branch. ` +
                    `It ended: ${record.state}.`,
            );
            section.line(
                "The run belongs to that branch, so the subagent tools cannot reach it from here.",
            );
        } else {
            section.line(`Subagent run ${runId} ended its turn: ${record.state}.`);
        }

        if (title !== undefined) {
            section.line(`Title: ${title}`);
        }

        if (record.stoppedBy === "user") {
            section.line("The user stopped it from the inspector.");
        } else if (record.stoppedBy === "branch") {
            section.line("It was stopped when the user left its branch.");
        }

        if (record.userWrote) {
            section.line(
                "The user wrote to this run during the turn, so its report may answer the user " +
                    "rather than only your task.",
            );
        }

        if (record.error) {
            section.line(`Error: ${record.error}`);
        }

        for (const earlier of record.earlierReports ?? []) {
            section.line(
                `Earlier report in this turn: ${earlier.status}. The run kept working, so a later ` +
                    "report replaces it.",
            );
            reportFields(section, earlier);
            section.line("Summary:");
            earlierReports.push({
                status: earlier.status,
                ...(earlier.reason ? { reason: earlier.reason } : {}),
                ...(earlier.question ? { question: earlier.question } : {}),
                summary: section.text(earlier.summary),
            });
            section.line("");
        }

        let body: ContentSlice;

        if (report) {
            section.line(`Report: ${report.status}`);
            reportFields(section, report);
            section.line("");
            section.line("Summary:");
            body = section.text(report.summary);
        } else {
            const message = record.unreportedMessage ?? "";

            section.line("Unreported: the turn ended without a report, so it has no task status.");
            section.line("");
            section.line(message === "" ? "The run left no message." : "The run's last message:");
            body = section.text(message);
        }

        content += section.content;
        runs.push({
            runId,
            name: title ?? name,
            ...(copied ? { copied } : {}),
            endedAt: record.endedAt,
            state: record.state,
            reportStatus: report?.status,
            reason: report?.reason,
            question: report?.question,
            error: record.error,
            userWrote: record.userWrote,
            stoppedBy: record.stoppedBy,
            durationMs: Date.parse(record.endedAt) - Date.parse(record.startedAt),
            ...(earlierReports.length > 0 ? { earlierReports } : {}),
            body,
        });
    }

    return { content, details: { runs } };
}

function reportFields(section: SectionWriter, report: RunReport): void {
    if (report.reason) {
        section.line(`Reason: ${report.reason}`);
    }

    if (report.question) {
        section.line(`Question: ${report.question}`);
    }
}

/** Joins a section's lines with newlines and knows where each text lands in the whole content. */
class SectionWriter {
    content = "";
    private readonly offset: number;

    constructor(offset: number) {
        this.offset = offset;
    }

    line(line: string): void {
        this.text(line);
    }

    text(text: string): ContentSlice {
        if (this.content !== "") {
            this.content += "\n";
        }

        const start = this.offset + this.content.length;

        this.content += text;

        return { start, end: start + text.length };
    }
}

/** `runId@endedAt`: one turn of one run. */
export function turnKey(runId: string, endedAt: string): string {
    return `${runId}@${endedAt}`;
}

/** The turns whose notices the session holds. A copied report was never sent as a notice. */
export function deliveredTurns(entries: readonly SessionEntry[]): Set<string> {
    const keys = new Set<string>();

    for (const entry of entries) {
        if (entry.type !== "custom_message" || entry.customType !== RUN_NOTIFICATION_TYPE) {
            continue;
        }

        const runs = (entry.details as Partial<RunNotificationDetails> | undefined)?.runs;

        if (!Array.isArray(runs)) {
            continue;
        }

        for (const run of runs) {
            if (!run.copied && typeof run.endedAt === "string") {
                keys.add(turnKey(run.runId, run.endedAt));
            }
        }
    }

    return keys;
}

/** Where a notice goes when its batch is sent; the active branch can change while it waits. */
export interface NoticeRouting {
    /** Whether the notice's run is on the active branch, so the main agent can be told now. */
    deliverable(notice: RunNotice): boolean;
    /** Keep a notice for another branch until that branch is active again. */
    hold(notice: RunNotice): void;
}

/** What the notifier reads from the parent session to confirm that its notices arrived. */
export interface ParentSession {
    /** A run of the main agent is active, so a notice waits in Pi's steering queue. */
    busy(): boolean;
    /** The active run is being aborted; a notice sent now waits in the queue for the next run. */
    aborting(): boolean;
    /** Pi's interactive mode clears its queues before every abort, which deletes queued notices. */
    abortClearsQueues(): boolean;
    /** `turnKey()` values of the notices that the session holds. */
    deliveredTurns(): ReadonlySet<string>;
}

interface Pending {
    item: RunNotice;
    retries: number;
    /** Goes with the main agent's next run instead of starting one. */
    quiet?: boolean;
}

interface Sent extends Pending {
    /** How many runs of the main agent had settled when the notice was sent. */
    settles: number;
    /** It waits in the steering queue of the active run, which an interactive abort clears. */
    clearable: boolean;
}

/**
 * Ended turns that arrive close together go out as one steer message. A sent notice counts as
 * delivered only once the parent session holds it; until then it stays in the outbox.
 */
export class RunNotifier {
    private buffer: Pending[] = [];
    private outbox: Sent[] = [];
    private settles = 0;
    private delayTimer: ReturnType<typeof setTimeout> | undefined;
    private maxDelayTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;
    /** Set while the session tree changes, when no branch is settled for a notice. */
    private paused = false;

    private readonly delayMs = 300;
    private readonly maxDelayMs = 1000;
    private readonly maxBatch = 10;
    private readonly maxRetries = 2;

    private readonly pi: ExtensionAPI;
    private readonly ui: ExtensionUIContext | undefined;
    private readonly routing: NoticeRouting;
    private readonly parent: ParentSession;

    constructor(
        pi: ExtensionAPI,
        ui: ExtensionUIContext | undefined,
        routing: NoticeRouting,
        parent: ParentSession,
    ) {
        this.pi = pi;
        this.ui = ui;
        this.routing = routing;
        this.parent = parent;
    }

    push(item: RunNotice): void {
        if (this.disposed) {
            return;
        }

        this.buffer.push({ item, retries: 0 });

        if (this.paused) {
            return;
        }

        if (this.buffer.length >= this.maxBatch) {
            this.flush();
            return;
        }

        this.schedule();
    }

    /** Waits for a quiet moment, but never longer than the maximum delay after the oldest arrival. */
    private schedule(): void {
        this.maxDelayTimer ??= setTimeout(() => {
            this.maxDelayTimer = undefined;
            this.flush();
        }, this.maxDelayMs);

        clearTimeout(this.delayTimer);
        this.delayTimer = setTimeout(() => {
            this.delayTimer = undefined;
            this.flush();
        }, this.delayMs);
    }

    /** Keep every notice until `resume()`; sent now, one could reach the branch being left. */
    pause(): void {
        this.paused = true;
        this.clearTimers();
    }

    resume(): void {
        if (!this.paused) {
            return;
        }

        this.paused = false;

        if (this.buffer.length > 0) {
            this.schedule();
        }
    }

    flush(): void {
        if (this.paused || this.buffer.length === 0) {
            return;
        }

        this.clearTimers();

        const ready = this.route(this.buffer.splice(0));

        this.send(ready.filter(({ quiet }) => !quiet));
        this.send(ready.filter(({ quiet }) => quiet));
    }

    /**
     * Called when a run of the main agent settles; Pi has then saved every message that the run
     * took. A notice sent before the previous settle had a whole run to arrive, because a run takes
     * queued steers and the messages held during a settle when it starts, so a missing one was lost.
     * A notice that waited in the queue of a run the user aborted was deleted with that queue.
     */
    settled(aborted: boolean): void {
        if (this.disposed) {
            return;
        }

        const settle = this.settles;

        this.settles += 1;

        if (this.outbox.length === 0) {
            return;
        }

        const delivered = this.parent.deliveredTurns();
        const cleared = aborted && this.parent.abortClearsQueues();
        const lost: Pending[] = [];

        this.outbox = this.outbox.filter((entry) => {
            if (delivered.has(turnKey(entry.item.runId, entry.item.record.endedAt))) {
                return false;
            }

            if (entry.settles < settle || (cleared && entry.clearable)) {
                lost.push({ item: entry.item, retries: entry.retries });
                return false;
            }

            return true;
        });

        if (lost.length > 0) {
            this.resend(lost, aborted);
        }
    }

    /** Stops parent-facing notifications; queued ones are dropped with the parent session. */
    dispose(): void {
        this.disposed = true;
        this.clearTimers();
        this.buffer = [];
        this.outbox = [];
    }

    /** The notices whose run is on the active branch; the others wait for their branch. */
    private route(entries: Pending[]): Pending[] {
        return entries.filter(({ item }) => {
            if (this.routing.deliverable(item)) {
                return true;
            }

            this.routing.hold(item);

            return false;
        });
    }

    private send(batch: Pending[]): void {
        if (batch.length === 0) {
            return;
        }

        const quiet = batch[0]!.quiet === true;

        try {
            const { content, details } = buildRunNotification(batch.map(({ item }) => item));

            // A normal return is not a delivery: Pi can still drop a queued message, which
            // settled() finds. Pi reports a failed start as an extension error; only a stale
            // runtime throws here.
            this.pi.sendMessage(
                { customType: RUN_NOTIFICATION_TYPE, content, display: true, details },
                quiet ? { deliverAs: "nextTurn" } : { triggerTurn: true, deliverAs: "steer" },
            );
        } catch (error) {
            const retrying = batch.filter(({ retries }) => retries < this.maxRetries);
            const dropped = batch.filter((entry) => !retrying.includes(entry));

            for (const entry of retrying) {
                entry.retries += 1;
            }

            // Requeued notifications go out on the next schedule, never in a tight retry loop.
            this.buffer = retrying.concat(this.buffer);
            this.reportFailure(
                error,
                retrying.map(({ item }) => item),
                dropped.map(({ item }) => item),
            );

            if (this.buffer.length > 0) {
                this.schedule();
            }

            return;
        }

        const clearable = !quiet && this.parent.busy() && !this.parent.aborting();

        for (const entry of batch) {
            this.outbox.push({ ...entry, settles: this.settles, clearable });
        }

        if (quiet) {
            this.notify(
                `An interruption removed the queued report of subagent run(s) [${ids(batch)}]. ` +
                    "The main agent receives it with your next message.",
                "info",
            );
        }
    }

    /**
     * Send lost notices again. After an abort they go with the next run: starting one would undo
     * the user's abort.
     */
    private resend(lost: Pending[], aborted: boolean): void {
        const retrying = lost.filter(({ retries }) => retries < this.maxRetries);
        const dropped = lost.filter((entry) => !retrying.includes(entry));

        if (dropped.length > 0) {
            this.notify(
                `Subagent notification(s) [${ids(dropped)}] did not reach the main agent after ` +
                    `${this.maxRetries} retries. subagent_status still returns the results.`,
                "error",
            );
        }

        if (retrying.length === 0) {
            return;
        }

        for (const entry of retrying) {
            entry.retries += 1;
            entry.quiet = aborted;
        }

        if (this.paused) {
            this.buffer = retrying.concat(this.buffer);
        } else if (aborted) {
            // Sent at once, so other waiting notices keep their own schedule.
            this.send(this.route(retrying));
        } else {
            this.buffer = retrying.concat(this.buffer);
            this.schedule();
        }
    }

    private clearTimers(): void {
        clearTimeout(this.delayTimer);
        clearTimeout(this.maxDelayTimer);
        this.delayTimer = undefined;
        this.maxDelayTimer = undefined;
    }

    private reportFailure(error: unknown, retrying: RunNotice[], dropped: RunNotice[]): void {
        const reason = error instanceof Error ? error.message : String(error);

        if (retrying.length > 0) {
            this.notify(
                `Failed to send subagent notification(s) [${noticeIds(retrying)}]: ${reason}. Requeued; at most ${this.maxRetries} retries per notification.`,
                "error",
            );
        }

        if (dropped.length > 0) {
            this.notify(
                `Permanently failed subagent notification(s) [${noticeIds(dropped)}]: ${reason}. Dropped; subagent_status still returns the results.`,
                "error",
            );
        }
    }

    private notify(message: string, type: "info" | "error"): void {
        try {
            if (this.ui) {
                this.ui.notify(message, type);
                return;
            }
        } catch {
            // A retired UI cannot show it; the console still can.
        }

        console.error(message);
    }
}

function ids(entries: readonly Pending[]): string {
    return noticeIds(entries.map(({ item }) => item));
}

function noticeIds(items: readonly RunNotice[]): string {
    return items.map((item) => item.runId).join(", ");
}
