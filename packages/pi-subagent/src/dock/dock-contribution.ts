import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
    createDockContribution,
    type DockHandle,
    type IndependentDock,
    type LuneDockSnapshot,
} from "@lune_99/pi-lune-extensions-core/dock";

import { reportColor, stateColor } from "../notify/notification-box.ts";
import type { RunManager } from "../run/run-manager.ts";
import type { Run } from "../run/run.ts";

export const SUBAGENT_CONTRIBUTION_ID = "subagents";

const WIDGET_ID = "pi-subagent";

/**
 * The Dock item of the runs on the current branch, and of runs on other branches whose ended turn
 * waits for that branch. Failed and blocked runs stay red until the user has seen them in the
 * inspector; a later failure turns them red again.
 */
export class SubagentDockContribution {
    private ctx: ExtensionContext | undefined;
    private manager: RunManager | undefined;
    /** Run ID to the number of ended turns the user had seen in the inspector. */
    private readonly acknowledged = new Map<string, number>();
    private readonly standalone: StandaloneDock;
    private readonly dock: DockHandle;

    constructor(open: (ctx: ExtensionContext) => Promise<void>) {
        this.standalone = new StandaloneDock((theme) => this.summary(theme));
        this.dock = createDockContribution({
            id: SUBAGENT_CONTRIBUTION_ID,
            getSnapshot: (ctx) => this.snapshot(ctx.ui.theme),
            activate: (ctx) => open(ctx),
            standalone: this.standalone,
        });
    }

    attach(ctx: ExtensionContext, manager: RunManager): void {
        this.detach({ retired: true });
        this.ctx = ctx;
        this.manager = manager;
        this.dock.attach(ctx);
    }

    detach(options?: { retired?: boolean }): void {
        this.ctx = undefined;
        this.manager = undefined;
        this.acknowledged.clear();
        this.dock.detach(options);
    }

    refresh(): void {
        if (this.ctx) {
            this.dock.refresh();
        }
    }

    /** The user saw the run's outcome in the inspector. */
    acknowledge(run: Run): void {
        if (this.acknowledged.get(run.id) !== run.turns) {
            this.acknowledged.set(run.id, run.turns);
            this.refresh();
        }
    }

    private runs(): Run[] {
        const manager = this.manager;

        if (!manager) {
            return [];
        }

        return [
            ...manager.branchRuns(),
            ...manager.otherBranchRuns().filter((run) => manager.hasDeferred(run)),
        ];
    }

    private alarming(run: Run): boolean {
        return run.needsAttention && this.acknowledged.get(run.id) !== run.turns;
    }

    private snapshot(theme: Theme): LuneDockSnapshot {
        const runs = this.runs();
        const [color, marker] = this.marker(runs);
        const line = (text: string): Component => ({
            render: (width) => [truncateToWidth(`${theme.fg(color, marker)} Agents${text}`, width)],
            invalidate() {},
        });
        const counts = this.counts(runs, theme);
        const list = runs.map((run) => this.runText(run, theme, false));
        const fullList = runs.map((run) => this.runText(run, theme, true));
        const separator = theme.fg("dim", " · ");

        return {
            base: line(counts ? ` ${counts}` : ""),
            detail: line(list.length > 0 ? separator + list.join(separator) : ""),
            full: line(fullList.length > 0 ? separator + fullList.join(separator) : ""),
        };
    }

    /** The standalone row: undefined hides it while there is nothing to show. */
    private summary(theme: Theme): string | undefined {
        const runs = this.runs();

        if (runs.length === 0) {
            return undefined;
        }

        const separator = theme.fg("dim", " · ");

        return [
            theme.fg("accent", `${runs.length} ${runs.length === 1 ? "agent" : "agents"}`),
            this.counts(runs, theme),
            ...runs.map((run) => this.runText(run, theme, false)),
        ]
            .filter((part) => part !== "")
            .join(separator);
    }

    /** `2 running · 1 needs input · 1 failed`. */
    private counts(runs: readonly Run[], theme: Theme): string {
        const running = runs.filter((run) => run.state === "running").length;
        const needsInput = runs.filter((run) => run.needsInput).length;
        const alarming = runs.filter((run) => this.alarming(run)).length;
        const parts = [
            running > 0 ? theme.fg("warning", `${running} running`) : undefined,
            needsInput > 0 ? theme.fg("accent", `${needsInput} needs input`) : undefined,
            alarming > 0 ? theme.fg("error", `${alarming} need attention`) : undefined,
        ];

        return parts.filter((part) => part !== undefined).join(theme.fg("dim", " · "));
    }

    /** `reviewer running`, `explorer idle done`; full adds where the run is. */
    private runText(run: Run, theme: Theme, full: boolean): string {
        const report = run.lastTurn ? (run.lastTurn.report?.status ?? "unreported") : undefined;
        const color: ThemeColor = this.alarming(run)
            ? "error"
            : run.needsInput
              ? "accent"
              : stateColor(run.state);
        const parts = [
            theme.fg(color, run.name),
            theme.fg(stateColor(run.state), run.state),
            run.state !== "running" && report ? theme.fg(reportColor(report), report) : undefined,
            this.manager?.hasDeferred(run) ? theme.fg("muted", "on another branch") : undefined,
            full && run.snapshot?.isolation === "worktree"
                ? theme.fg("dim", "worktree")
                : undefined,
            full ? theme.fg("dim", run.id) : undefined,
        ];

        return parts.filter((part) => part !== undefined).join(" ");
    }

    private marker(runs: readonly Run[]): [ThemeColor, string] {
        if (runs.some((run) => this.alarming(run))) {
            return ["error", "✕"];
        }

        if (runs.some((run) => run.needsInput)) {
            return ["accent", "?"];
        }

        if (runs.some((run) => run.state === "running")) {
            return ["warning", "◐"];
        }

        if (runs.length > 0) {
            return ["success", "●"];
        }

        return ["dim", "○"];
    }
}

/** The row below the editor while no shared Dock is attached. */
class StandaloneDock implements IndependentDock {
    private ctx: ExtensionContext | undefined;
    private readonly summary: (theme: Theme) => string | undefined;

    constructor(summary: (theme: Theme) => string | undefined) {
        this.summary = summary;
    }

    setCtx(ctx: ExtensionContext | undefined): void {
        this.ctx = ctx;
    }

    render(): void {
        if (!this.ctx?.hasUI) {
            return;
        }

        const theme = this.ctx.ui.theme;
        const summary = this.summary(theme);

        this.ctx.ui.setWidget(
            WIDGET_ID,
            summary === undefined
                ? undefined
                : [`${summary}${theme.fg("dim", " · /agents to open")}`],
            { placement: "belowEditor" },
        );
    }

    clear(): void {
        if (this.ctx?.hasUI) {
            this.ctx.ui.setWidget(WIDGET_ID, undefined);
        }
    }
}
