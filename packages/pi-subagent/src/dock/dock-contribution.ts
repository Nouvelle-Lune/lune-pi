import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
    createDockContribution,
    type DockHandle,
    type IndependentDock,
    type LuneDockSnapshot,
} from "@lune_99/pi-lune-extensions-core/dock";

import { fitRanked, type RankedPart } from "../render/text.ts";
import type { RunManager } from "../run/run-manager.ts";
import type { Run } from "../run/run.ts";

export const SUBAGENT_CONTRIBUTION_ID = "subagents";

const WIDGET_ID = "pi-subagent";

type DockStatus =
    | "running"
    | "needs input"
    | "blocked"
    | "failed"
    | "interrupted"
    | "unreported"
    | "done"
    | "idle";

/**
 * The statuses in display order, with their ranks: a narrow cell drops the lowest ranks first, so
 * the counts that need the user stay longest.
 */
const STATUS_RANKS: ReadonlyArray<readonly [DockStatus, number]> = [
    ["running", 7],
    ["needs input", 8],
    ["blocked", 9],
    ["failed", 10],
    ["interrupted", 5],
    ["unreported", 4],
    ["done", 3],
    ["idle", 2],
];
const ELSEWHERE_RANK = 6;
const LATEST_RANK = 1;
const HINT_RANK = 0;

/**
 * The Dock item of the runs on the current branch, and of runs on other branches whose ended turn
 * waits for that branch. Its lines count the runs by status and never cut a part: a narrow cell
 * leaves out whole parts, then the title. Failed and blocked runs keep the marker red until the
 * user has seen them in the inspector; a later failure turns it red again.
 */
export class SubagentDockContribution {
    private ctx: ExtensionContext | undefined;
    private manager: RunManager | undefined;
    /** Run ID to the number of ended turns the user had seen in the inspector. */
    private readonly acknowledged = new Map<string, number>();
    private readonly standalone: StandaloneDock;
    private readonly dock: DockHandle;

    constructor(open: (ctx: ExtensionContext) => Promise<void>) {
        this.standalone = new StandaloneDock((theme) => this.row(theme));
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

    /** This branch's runs, and the runs of other branches whose ended turn waits for that branch. */
    private runs(): { here: Run[]; elsewhere: Run[] } {
        const manager = this.manager;

        if (!manager) {
            return { here: [], elsewhere: [] };
        }

        return {
            here: manager.branchRuns(),
            elsewhere: manager.otherBranchRuns().filter((run) => manager.hasDeferred(run)),
        };
    }

    private alarming(run: Run): boolean {
        return run.needsAttention && this.acknowledged.get(run.id) !== run.turns;
    }

    /** Base names the item; detail adds the counts; full adds the run that changed last. */
    private snapshot(theme: Theme): LuneDockSnapshot {
        const { here, elsewhere } = this.runs();
        const runs = [...here, ...elsewhere];
        const summary = this.summary(runs, elsewhere.length, theme);

        return {
            base: this.line(runs, theme, []),
            detail: this.line(runs, theme, summary),
            full: this.line(runs, theme, [...summary, ...this.latest(runs, theme)]),
        };
    }

    /** The standalone row: the full line and how to open the inspector; undefined hides it. */
    private row(theme: Theme): Component | undefined {
        const { here, elsewhere } = this.runs();
        const runs = [...here, ...elsewhere];

        if (runs.length === 0) {
            return undefined;
        }

        return this.line(runs, theme, [
            ...this.summary(runs, elsewhere.length, theme),
            ...this.latest(runs, theme),
            { text: theme.fg("dim", "/agents to open"), rank: HINT_RANK },
        ]);
    }

    /** `◐ Agents · 2 running · 1 done` with every part that fits, down to the marker alone. */
    private line(runs: readonly Run[], theme: Theme, parts: readonly RankedPart[]): Component {
        const [color, symbol] = this.marker(runs);
        const marker = theme.fg(color, symbol);
        const separator = theme.fg("muted", " · ");

        return {
            render: (width) => [
                fitRanked(parts, width, (texts) =>
                    [`${marker} Agents`, ...texts].join(separator),
                ) ?? marker,
            ],
            invalidate() {},
        };
    }

    /** `2 running · 1 needs input · 1 on another branch`, or `idle` without runs. */
    private summary(runs: readonly Run[], elsewhere: number, theme: Theme): RankedPart[] {
        const muted = (text: string): string => theme.fg("muted", text);

        if (runs.length === 0) {
            return [{ text: muted("idle"), rank: 0 }];
        }

        const counts = new Map<DockStatus, number>();

        for (const run of runs) {
            const status = dockStatus(run);

            counts.set(status, (counts.get(status) ?? 0) + 1);
        }

        const parts = STATUS_RANKS.filter(([status]) => counts.has(status)).map(
            ([status, rank]) => ({ text: muted(`${counts.get(status)} ${status}`), rank }),
        );

        if (elsewhere > 0) {
            parts.push({
                text: muted(
                    `${elsewhere} on ${elsewhere === 1 ? "another branch" : "other branches"}`,
                ),
                rank: ELSEWHERE_RANK,
            });
        }

        return parts;
    }

    /** `latest: reviewer done`: the run whose turn started or ended last. */
    private latest(runs: readonly Run[], theme: Theme): RankedPart[] {
        let latest: Run | undefined;
        let latestAt = -Infinity;

        for (const run of runs) {
            const at = lastActivity(run);

            if (at >= latestAt) {
                latest = run;
                latestAt = at;
            }
        }

        return latest
            ? [
                  {
                      text: theme.fg("muted", `latest: ${latest.name} ${dockStatus(latest)}`),
                      rank: LATEST_RANK,
                  },
              ]
            : [];
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

/** One status per run: the session's state, and the last report once the session is idle. */
function dockStatus(run: Run): DockStatus {
    if (run.state !== "idle") {
        return run.state;
    }

    switch (run.lastTurn?.report?.status) {
        case "needs_input":
            return "needs input";
        case "blocked":
            return "blocked";
        case "done":
            return "done";
        default:
            return run.lastTurn ? "unreported" : "idle";
    }
}

function lastActivity(run: Run): number {
    const time = Date.parse(
        run.turnStartedAt ?? run.lastTurn?.endedAt ?? run.snapshot?.createdAt ?? "",
    );

    return Number.isNaN(time) ? -Infinity : time;
}

/** The row below the editor while no shared Dock is attached. */
class StandaloneDock implements IndependentDock {
    private ctx: ExtensionContext | undefined;
    private readonly row: (theme: Theme) => Component | undefined;

    constructor(row: (theme: Theme) => Component | undefined) {
        this.row = row;
    }

    setCtx(ctx: ExtensionContext | undefined): void {
        this.ctx = ctx;
    }

    render(): void {
        if (!this.ctx?.hasUI) {
            return;
        }

        const row = this.row(this.ctx.ui.theme);

        // Pi pads string rows by one column on each side; this row keeps the same margins.
        this.ctx.ui.setWidget(
            WIDGET_ID,
            row === undefined
                ? undefined
                : () => ({
                      render: (width) =>
                          row.render(Math.max(0, width - 2)).map((line) => ` ${line}`),
                      invalidate() {},
                  }),
            { placement: "belowEditor" },
        );
    }

    clear(): void {
        if (this.ctx?.hasUI) {
            this.ctx.ui.setWidget(WIDGET_ID, undefined);
        }
    }
}
