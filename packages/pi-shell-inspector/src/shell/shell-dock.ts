import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fitRanked, type RankedPart } from "./dock-line.ts";
import { shellManager } from "./shell-manager.ts";
import { collapseShellCommand } from "./shell-command.ts";

const WIDGET_ID = "pi-shell-inspector";

/**
 * Ranks of the parts after the row's lead: a narrow row drops the lowest first, so failures stay
 * longest and the hint goes first. The lead itself is never left out.
 */
const FAILED_RANK = 6;
const KILLED_RANK = 5;
const RUNNING_RANK = 4;
const COMPLETED_RANK = 3;
const COMMAND_RANK = 2;
const ELAPSED_RANK = 1;
const HINT_RANK = 0;

export class ShellDock {
    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private selected = false;
    private ctx: ExtensionContext | undefined;

    constructor() {}

    private syncRefreshTimer(): void {
        const hasRunningJobs = shellManager.jobsStatusStat.runningCount > 0;

        if (hasRunningJobs && !this.refreshTimer) {
            this.refreshTimer = setInterval(() => {
                this.render();
            }, 1000);
        }

        if (!hasRunningJobs && this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    setCtx(ctx: ExtensionContext | undefined): void {
        this.ctx = ctx;
    }

    setSelected(selected: boolean): void {
        if (this.selected === selected) {
            return;
        }

        this.selected = selected;
        this.render();
    }

    isSelected(): boolean {
        return this.selected;
    }

    render(): void {
        if (!this.ctx || !this.ctx.hasUI) {
            return;
        }

        this.syncRefreshTimer();

        const jobs = shellManager.getAllJobsList();

        if (jobs.length === 0) {
            this.selected = false;
            this.ctx.ui.setWidget(WIDGET_ID, undefined);
            return;
        }

        const { lead, parts } = shellDockSummary(this.ctx);
        const separator = this.ctx.ui.theme.fg("dim", " · ");

        // Pi pads string rows by one column on each side; this row keeps the same margins.
        this.ctx.ui.setWidget(
            WIDGET_ID,
            () => ({
                render: (width) => [
                    ` ${
                        fitRanked(parts, Math.max(0, width - 2), (texts) =>
                            [lead, ...texts].join(separator),
                        ) ?? ""
                    }`,
                ],
                invalidate() {},
            }),
            {
                placement: "belowEditor",
            },
        );
    }

    clear(): void {
        // Stopping the timer is independent of the UI: a session that ends must not keep
        // rendering through its refresh interval.
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        if (!this.ctx || !this.ctx.hasUI) {
            return;
        }

        this.selected = false;
        this.ctx.ui.setWidget(WIDGET_ID, undefined);
    }
}

/** The lead names the jobs; the parts after it are left out whole while the row is too wide. */
function shellDockSummary(ctx: ExtensionContext): { lead: string; parts: RankedPart[] } {
    const status = shellManager.getAllJobsStatusStat();
    const hint = { text: ctx.ui.theme.fg("dim", "/shell to open"), rank: HINT_RANK };

    // only one running shell case
    if (
        status.runningCount === 1 &&
        status.completedCount === 0 &&
        status.failedCount === 0 &&
        status.killedCount === 0
    ) {
        const runningJob = shellManager.getRunningJobsList()[0];
        const elapsedTime = Math.floor((Date.now() - runningJob!.startedAt) / 1000);
        return {
            lead: ctx.ui.theme.fg("accent", `${status.runningCount} running shell`),
            parts: [
                { text: collapseShellCommand(runningJob!.command), rank: COMMAND_RANK },
                { text: `${elapsedTime}s`, rank: ELAPSED_RANK },
                hint,
            ],
        };
    }
    // only one completed shell case
    if (
        status.completedCount === 1 &&
        status.runningCount === 0 &&
        status.failedCount === 0 &&
        status.killedCount === 0
    ) {
        const completedJob = shellManager.getCompletedJobsList()[0];
        const elapsedTime = Math.floor(
            (completedJob!.finishedAt! - completedJob!.startedAt) / 1000,
        );
        return {
            lead:
                ctx.ui.theme.fg("success", `${status.completedCount} shell completed`) +
                ` in ${elapsedTime}s`,
            parts: [hint],
        };
    }

    const parts: RankedPart[] = [];
    const jobCount = shellManager.getAllJobsList().length;

    if (status.runningCount > 0) {
        parts.push({
            text: ctx.ui.theme.fg("accent", `${status.runningCount} running`),
            rank: RUNNING_RANK,
        });
    }
    if (status.completedCount > 0) {
        parts.push({
            text: ctx.ui.theme.fg("success", `${status.completedCount} completed`),
            rank: COMPLETED_RANK,
        });
    }
    if (status.failedCount > 0) {
        parts.push({
            text: ctx.ui.theme.fg("error", `${status.failedCount} failed`),
            rank: FAILED_RANK,
        });
    }
    if (status.killedCount > 0) {
        parts.push({
            text: ctx.ui.theme.fg("error", `${status.killedCount} killed`),
            rank: KILLED_RANK,
        });
    }
    parts.push(hint);

    return { lead: `${jobCount} ${jobCount === 1 ? "shell" : "shells"}`, parts };
}

export const shellDock = new ShellDock();
