import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { ReportStatus, SettledState, StopSource, TurnRecord } from "../run/types.ts";

/** Custom message type of a batch of ended turns; the transcript box is registered for it. */
export const RUN_NOTIFICATION_TYPE = "lune-subagent-notification";

const SECTION_SEPARATOR = "\n\n---\n\n";

/** One ended turn as the main agent is told about it. */
export interface RunNotice {
    runId: string;
    name: string;
    record: TurnRecord;
    /** The user copied it from the inspector; the run belongs to another branch. */
    copied?: boolean;
}

export interface RunNotificationRun {
    runId: string;
    name: string;
    copied?: boolean;
    state: SettledState;
    reportStatus?: ReportStatus;
    reason?: string;
    question?: string;
    error?: string;
    userWrote: boolean;
    stoppedBy?: StopSource;
    durationMs?: number;
    /**
     * Where the report summary, or the last message of an unreported turn, sits in the content. The
     * box reads it from there rather than from a second copy in details, which are stored too.
     */
    body: { start: number; end: number };
}

export interface RunNotificationDetails {
    runs: RunNotificationRun[];
}

/** The model-facing text and the box-facing details of one batch; they share the body offsets. */
export function buildRunNotification(batch: readonly RunNotice[]): {
    content: string;
    details: RunNotificationDetails;
} {
    const sections: string[] = [];
    const runs: RunNotificationRun[] = [];
    let offset = 0;

    for (const { runId, name, record, copied } of batch) {
        const report = record.report;
        const body = report ? report.summary : (record.unreportedMessage ?? "");
        const lines = copied
            ? [
                  `The user copied the last turn of subagent run ${name} (${runId}) from another ` +
                      `branch. It ended: ${record.state}.`,
                  "The run belongs to that branch, so the subagent tools cannot reach it from here.",
              ]
            : [`Subagent run ${name} (${runId}) ended its turn: ${record.state}.`];

        if (record.stoppedBy === "user") {
            lines.push("The user stopped it from the inspector.");
        } else if (record.stoppedBy === "branch") {
            lines.push("It was stopped when the user left its branch.");
        }

        if (record.userWrote) {
            lines.push(
                "The user wrote to this run during the turn, so its report may answer the user " +
                    "rather than only your task.",
            );
        }

        if (record.error) {
            lines.push(`Error: ${record.error}`);
        }

        if (report) {
            lines.push(`Report: ${report.status}`);

            if (report.reason) {
                lines.push(`Reason: ${report.reason}`);
            }

            if (report.question) {
                lines.push(`Question: ${report.question}`);
            }

            lines.push("", "Summary:");
        } else {
            lines.push(
                "Unreported: the turn ended without a report, so it has no task status.",
                "",
                body === "" ? "The run left no message." : "The run's last message:",
            );
        }

        const section = `${lines.join("\n")}\n${body}`;

        sections.push(section);
        runs.push({
            runId,
            name,
            ...(copied ? { copied } : {}),
            state: record.state,
            reportStatus: report?.status,
            reason: report?.reason,
            question: report?.question,
            error: record.error,
            userWrote: record.userWrote,
            stoppedBy: record.stoppedBy,
            durationMs: Date.parse(record.endedAt) - Date.parse(record.startedAt),
            // The body is the section's tail.
            body: {
                start: offset + section.length - body.length,
                end: offset + section.length,
            },
        });
        offset += section.length + SECTION_SEPARATOR.length;
    }

    return { content: sections.join(SECTION_SEPARATOR), details: { runs } };
}

/** Where a notice goes when its batch is sent; the active branch can change while it waits. */
export interface NoticeRouting {
    /** Whether the notice's run is on the active branch, so the main agent can be told now. */
    deliverable(notice: RunNotice): boolean;
    /** Keep a notice for another branch until that branch is active again. */
    hold(notice: RunNotice): void;
}

/** Ended turns that arrive close together go out as one steer message. */
export class RunNotifier {
    private buffer: Array<{ item: RunNotice; retries: number }> = [];
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

    constructor(pi: ExtensionAPI, ui: ExtensionUIContext | undefined, routing: NoticeRouting) {
        this.pi = pi;
        this.ui = ui;
        this.routing = routing;
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

        const batch = this.buffer.splice(0).filter(({ item }) => {
            if (this.routing.deliverable(item)) {
                return true;
            }

            this.routing.hold(item);

            return false;
        });

        if (batch.length === 0) {
            return;
        }

        try {
            const { content, details } = buildRunNotification(batch.map(({ item }) => item));

            // Pi reports a failed delivery as an extension error; only a stale runtime throws here.
            this.pi.sendMessage(
                { customType: RUN_NOTIFICATION_TYPE, content, display: true, details },
                { triggerTurn: true, deliverAs: "steer" },
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
        }
    }

    /** Stops parent-facing notifications; queued ones are dropped with the parent session. */
    dispose(): void {
        this.disposed = true;
        this.clearTimers();
        this.buffer = [];
    }

    private clearTimers(): void {
        clearTimeout(this.delayTimer);
        clearTimeout(this.maxDelayTimer);
        this.delayTimer = undefined;
        this.maxDelayTimer = undefined;
    }

    private reportFailure(error: unknown, retrying: RunNotice[], dropped: RunNotice[]): void {
        const reason = error instanceof Error ? error.message : String(error);
        const ids = (items: RunNotice[]) => items.map((item) => item.runId).join(", ");
        const messages: string[] = [];

        if (retrying.length > 0) {
            messages.push(
                `Failed to send subagent notification(s) [${ids(retrying)}]: ${reason}. Requeued; at most ${this.maxRetries} retries per notification.`,
            );
        }

        if (dropped.length > 0) {
            messages.push(
                `Permanently failed subagent notification(s) [${ids(dropped)}]: ${reason}. Dropped; subagent_status still returns the results.`,
            );
        }

        for (const message of messages) {
            try {
                if (this.ui) {
                    this.ui.notify(message, "error");
                    continue;
                }
            } catch {
                // A retired UI cannot show it; the console still can.
            }

            console.error(message);
        }
    }
}
