import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
    createDockContribution,
    type DockHandle,
    type LuneDockSnapshot,
} from "@lune_99/pi-lune-extensions-core/dock";
import { fitRanked, type RankedPart } from "./dock-line.ts";
import { ShellDock } from "./shell-dock.ts";
import { collapseShellCommand } from "./shell-command.ts";
import { openShellInspector } from "./shell-inspector.ts";
import type { ShellManager, ShellManagerEvent } from "./shell-manager.ts";

export const SHELL_CONTRIBUTION_ID = "shell-inspector";

/**
 * Ranks of the line's parts: a narrow cell drops the lowest first, so failures stay longest and
 * the runtime goes before the command it belongs to.
 */
const FAILED_RANK = 5;
const RUNNING_RANK = 4;
const COMPLETED_RANK = 3;
const LATEST_RANK = 2;
const ELAPSED_RANK = 1;

/**
 * The Dock item of the background shells. Its lines count the jobs by status and never cut a
 * part: a narrow cell leaves out whole parts, then the title.
 */
export class ShellDockContribution {
    private generation = 0;
    private readonly acknowledged = new Set<string>();
    private ctx: ExtensionContext | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private readonly manager: ShellManager;
    private readonly dock: DockHandle;

    constructor(manager: ShellManager) {
        this.manager = manager;
        this.dock = createDockContribution({
            id: SHELL_CONTRIBUTION_ID,
            getSnapshot: (ctx) => this.getSnapshot(ctx),
            activate: (ctx) => this.open(ctx),
            standalone: new ShellDock(manager),
        });
    }

    attach(ctx: ExtensionContext): void {
        this.detach({ retired: true });
        this.ctx = ctx;
        this.dock.attach(ctx);
        this.syncTimer();
    }

    detach(options?: { retired?: boolean }): void {
        this.generation++;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.ctx = undefined;
        this.dock.detach(options);
        this.acknowledged.clear();
    }

    onManagerEvent(event: ShellManagerEvent): void {
        if (event.type === "jobs-cleared") this.acknowledged.clear();
        if (event.type === "job-cleared") this.acknowledged.delete(event.id);
        // Output chunks affect the independent command/runtime row, not the shared summary.
        this.dock.refresh({ summaryChanged: event.type !== "output-updated" });
        this.syncTimer();
    }

    render(): void {
        this.dock.refresh();
    }

    private syncTimer(): void {
        if (this.ctx?.mode === "tui" && this.manager.getRunningJobsList().length > 0) {
            this.timer ??= setInterval(() => this.render(), 1000);
        } else if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** Base names the item; detail adds the counts; full adds the latest job and its runtime. */
    getSnapshot(ctx = this.ctx!): LuneDockSnapshot {
        const theme = ctx.ui.theme;
        const jobs = this.manager.getAllJobsList();
        const failed = jobs.filter((job) => job.status === "failed" || job.status === "killed");
        const running = jobs.filter((job) => job.status === "running");
        const completed = jobs.filter((job) => job.status === "completed");
        let color: ThemeColor;
        let marker: string;
        if (failed.some((job) => !this.acknowledged.has(job.id))) {
            color = "error";
            marker = "✕";
        } else if (running.length > 0) {
            color = "warning";
            marker = "◐";
        } else if (completed.length > 0) {
            color = "success";
            marker = "●";
        } else if (jobs.length > 0) {
            color = "error";
            marker = "✕";
        } else {
            color = "dim";
            marker = "○";
        }
        const muted = (text: string): string => theme.fg("muted", text);
        const summary: RankedPart[] = [
            running.length > 0
                ? { text: muted(`${running.length} running`), rank: RUNNING_RANK }
                : undefined,
            completed.length > 0
                ? { text: muted(`${completed.length} completed`), rank: COMPLETED_RANK }
                : undefined,
            failed.length > 0
                ? { text: muted(`${failed.length} failed/killed`), rank: FAILED_RANK }
                : undefined,
        ].filter((part) => part !== undefined);
        const latest = jobs[jobs.length - 1];
        const details: RankedPart[] = latest
            ? [
                  {
                      text: muted(`latest: ${collapseShellCommand(latest.command)}`),
                      rank: LATEST_RANK,
                  },
                  {
                      text: muted(
                          `${Math.floor(((latest.finishedAt ?? Date.now()) - latest.startedAt) / 1000)}s`,
                      ),
                      rank: ELAPSED_RANK,
                  },
              ]
            : [];
        const symbol = theme.fg(color, marker);
        // `● Shell · 2 running · 1 completed` with every part that fits, down to the marker alone.
        const component = (parts: readonly RankedPart[]): Component => ({
            render: (width) => [
                fitRanked(parts, width, (texts) =>
                    [`${symbol} Shell`, ...texts].join(muted(" · ")),
                ) ?? (visibleWidth(symbol) <= width ? symbol : ""),
            ],
            invalidate() {},
        });
        return {
            base: component([]),
            detail: component(summary),
            full: component([...summary, ...details]),
        };
    }

    async open(ctx: ExtensionContext): Promise<void> {
        const generation = this.generation;
        // A failure arriving after the panel opened has not necessarily been seen. Only
        // the opening snapshot is acknowledged, and only after a successful interaction.
        const seen = this.manager
            .getAllJobsList()
            .filter((job) => job.status === "failed" || job.status === "killed")
            .map((job) => job.id);
        await openShellInspector(ctx, this.manager);
        if (generation !== this.generation) return;
        for (const id of seen) this.acknowledged.add(id);
        this.render();
    }
}
