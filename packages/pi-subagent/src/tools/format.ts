import type { Run } from "../run/run.ts";
import type { RunUsage, TurnRecord } from "../run/types.ts";

/** How much of a summary or task a run list shows; one run shows all of it. */
const PREVIEW_CHARS = 200;
const DIAGNOSTICS_SHOWN = 5;

/** The workspace lines `subagent_start` and `subagent_status` return. */
export function workspaceLines(run: Run): string[] {
    const snapshot = run.snapshot;

    if (!snapshot) {
        return [];
    }

    const lines = [`Isolation: ${snapshot.isolation}`, `Working directory: ${snapshot.cwd}`];

    if (snapshot.worktree) {
        lines.push(
            `Worktree: ${snapshot.worktree.path}`,
            `Base commit: ${snapshot.worktree.baseCommit}`,
        );
    }

    return lines;
}

/** The start values and where each came from. */
export function startValueLines(run: Run): string[] {
    const snapshot = run.snapshot;

    if (!snapshot) {
        return [];
    }

    return [
        `Agent: ${snapshot.definition ? snapshot.definition.name : "inline"}`,
        `Model: ${snapshot.model} (from ${snapshot.sources.model})`,
        `Thinking: ${snapshot.thinking} (from ${snapshot.sources.thinking})`,
        `Tools: ${snapshot.tools.join(", ")} (from ${snapshot.sources.tools})`,
    ];
}

export function formatStarted(run: Run): string {
    return [
        `Started run ${run.name} (${run.id}): ${run.state}.`,
        ...startValueLines(run),
        ...workspaceLines(run),
        "The run works in the background. A message arrives when its turn ends.",
    ].join("\n");
}

/** One run in full: everything `subagent_status` knows, the last turn's whole report included. */
export function formatRunStatus(run: Run): string {
    const lines = [heading(run)];

    if (run.loadError) {
        lines.push(`The run file could not be read: ${run.loadError}`);

        return lines.join("\n");
    }

    lines.push(...startValueLines(run), ...workspaceLines(run));
    lines.push(`Turns: ${run.turns}`, `Usage: ${formatUsage(run.usage)}`);
    lines.push(...runningLines(run));
    lines.push(...diagnosticLines(run));
    lines.push("", "Task:", run.snapshot?.task ?? "");

    if (run.lastTurn) {
        lines.push("", ...turnLines(run.lastTurn, false));
    }

    return lines.join("\n");
}

/** The runs of the current branch, one block each, with previews instead of whole reports. */
export function formatRunList(runs: readonly Run[], elsewhere: number): string {
    const blocks = runs.map((run) => {
        if (run.loadError) {
            return [heading(run), `The run file could not be read: ${run.loadError}`].join("\n");
        }

        return [
            heading(run),
            ...startValueLines(run).slice(0, 1),
            ...workspaceLines(run),
            `Turns: ${run.turns} · Usage: ${formatUsage(run.usage)}`,
            ...runningLines(run),
            ...diagnosticLines(run),
            ...(run.lastTurn ? turnLines(run.lastTurn, true) : []),
        ].join("\n");
    });
    const notes: string[] = [];

    if (runs.length === 0) {
        notes.push("No subagent runs on the current branch.");
    } else {
        notes.push("Call subagent_status with a runId for a run's whole report.");
    }

    if (elsewhere > 0) {
        notes.push(
            `${elsewhere} run${elsewhere === 1 ? " belongs" : "s belong"} to other branches and ` +
                `${elsewhere === 1 ? "is" : "are"} not listed.`,
        );
    }

    return [...blocks, notes.join(" ")].join("\n\n");
}

export function formatUsage(usage: RunUsage): string {
    return [
        `${formatTokens(usage.input)} input`,
        `${formatTokens(usage.output)} output`,
        `${formatTokens(usage.cacheRead)} cache read`,
        `${formatTokens(usage.cacheWrite)} cache write`,
        `$${usage.cost.toFixed(3)}`,
    ].join(" · ");
}

export function formatTokens(count: number): string {
    if (count < 1000) {
        return String(count);
    }

    if (count < 1_000_000) {
        return `${(count / 1000).toFixed(1)}k`;
    }

    return `${(count / 1_000_000).toFixed(1)}M`;
}

/** `4.2s` / `1m 4s` / `1h 2m`. */
export function formatDuration(ms: number): string {
    const seconds = ms / 1000;

    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);

    if (minutes < 60) {
        return `${minutes}m ${totalSeconds % 60}s`;
    }

    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function heading(run: Run): string {
    return `Run ${run.name} (${run.id}): ${run.state}${run.readOnly ? ", read-only" : ""}`;
}

function runningLines(run: Run): string[] {
    if (run.state !== "running") {
        return [];
    }

    const started = run.turnStartedAt;
    const lines = [
        started
            ? `Turn running for ${formatDuration(Date.now() - Date.parse(started))}`
            : "Turn running",
    ];

    if (run.activity) {
        lines.push(run.activity);
    }

    return lines;
}

function diagnosticLines(run: Run): string[] {
    const shown = run.diagnostics
        .filter((diagnostic) => diagnostic.level !== "info")
        .slice(-DIAGNOSTICS_SHOWN);

    if (shown.length === 0) {
        return [];
    }

    return [
        "Diagnostics:",
        ...shown.map((diagnostic) => `  ${diagnostic.level}: ${diagnostic.message}`),
    ];
}

function turnLines(turn: TurnRecord, preview: boolean): string[] {
    const duration = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
    const lines = [
        `Last turn: ${turn.state}, ended ${turn.endedAt}` +
            (Number.isFinite(duration) ? ` after ${formatDuration(duration)}` : ""),
    ];

    if (turn.stoppedBy) {
        lines.push(`Stopped by: ${turn.stoppedBy}`);
    }

    if (turn.userWrote) {
        lines.push("The user wrote to the run during that turn.");
    }

    if (turn.error) {
        lines.push(`Error: ${turn.error}`);
    }

    if (turn.report) {
        lines.push(`Report: ${turn.report.status}`);

        if (turn.report.reason) {
            lines.push(`Reason: ${turn.report.reason}`);
        }

        if (turn.report.question) {
            lines.push(`Question: ${turn.report.question}`);
        }

        lines.push(preview ? `Summary: ${clip(turn.report.summary)}` : "Summary:");

        if (!preview) {
            lines.push(turn.report.summary);
        }
    } else {
        const message = turn.unreportedMessage ?? "";

        lines.push("Unreported: the turn ended without a report, so it has no task status.");

        if (preview) {
            lines.push(`Last message: ${message === "" ? "none" : clip(message)}`);
        } else {
            lines.push(message === "" ? "The run left no message." : "Last message:", message);
        }
    }

    return lines;
}

function clip(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();

    return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line;
}
