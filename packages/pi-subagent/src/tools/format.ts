import type { Run } from "../run/run.ts";
import type { AutoRating, RunSnapshot, RunUsage, TurnRecord } from "../run/types.ts";

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
        `Model: ${snapshot.model} (${modelOrigin(snapshot)})`,
        `Thinking: ${snapshot.thinking} (${thinkingOrigin(snapshot)})`,
        `Tools: ${snapshot.tools.join(", ")} (from ${snapshot.sources.tools})`,
    ];
}

function modelOrigin(snapshot: RunSnapshot): string {
    const auto = snapshot.autoModel;

    if (!auto) {
        return `from ${snapshot.sources.model}`;
    }

    const origin = `auto from ${snapshot.sources.model}`;

    switch (auto.by) {
        case "rating": {
            const { tier, modelFrom } = auto;
            const model =
                modelFrom === tier.used
                    ? `the ${tier.used} tier's model`
                    : modelFrom === "main"
                      ? `no tier from ${tier.used} up has a model, so the main agent's model`
                      : `the ${tier.used} tier has no model, so the ${modelFrom} tier's model`;

            return `${origin}: the classifier ${auto.classifier} rated the task ${ratingText(tier)}; ${model}`;
        }
        case "no-classifier":
            return `${origin}: no classifier is selected, so the main agent's model`;
        case "nothing-to-rate":
            return `${origin}: no auto tier has a model and the thinking is set, so the main agent's model`;
        case "classifier-failed":
            return `${origin}: the main agent's model. ${auto.error}`;
        default:
            // A run that an earlier version started records its auto choice in another form.
            return origin;
    }
}

function thinkingOrigin(snapshot: RunSnapshot): string {
    const auto = snapshot.autoModel;

    return snapshot.sources.thinking === "auto" && auto?.by === "rating"
        ? `auto: the classifier rated the reasoning ${ratingText(auto.reasoning)}`
        : `from ${snapshot.sources.thinking}`;
}

/** `complex (71%)`, and the level used instead when the classifier was unsure. */
export function ratingText(rating: AutoRating<string>): string {
    const share = rating.probabilities[rating.rated];

    return (
        rating.rated +
        (share === undefined ? "" : ` (${formatPercent(share)})`) +
        (rating.used === rating.rated
            ? ""
            : `, unsure at ${formatPercent(rating.confidence)} confidence, so ${rating.used}`)
    );
}

/** One entry of a `tasks` call: the run it started, or why it did not start. */
export type StartOutcome = { run: Run } | { error: string };

export function formatStarted(run: Run): string {
    return [
        startedHeading(run),
        ...startValueLines(run),
        ...workspaceLines(run),
        "The run works in the background. A message arrives when its turn ends.",
    ].join("\n");
}

/** A `tasks` call: a summary, then one block per entry, named by its index in `tasks`. */
export function formatStartedBatch(outcomes: readonly StartOutcome[]): string {
    const started = outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : []));
    const failed = outcomes.flatMap((outcome, index) =>
        "error" in outcome ? [`tasks[${index}]`] : [],
    );
    const blocks = outcomes.map((outcome, index) =>
        "error" in outcome
            ? `tasks[${index}] failed: ${outcome.error}`
            : [
                  `tasks[${index}]: ${startedHeading(outcome.run)}`,
                  ...startValueLines(outcome.run),
                  ...workspaceLines(outcome.run),
              ].join("\n"),
    );

    if (started.length === 0) {
        return ["No run started; every entry of tasks failed.", ...blocks].join("\n\n");
    }

    const count = started.length === outcomes.length ? "" : `${started.length} of `;
    const summary =
        `Started ${count}${outcomes.length} run${outcomes.length === 1 ? "" : "s"}: ` +
        `${started.map((run) => `${run.name} (${run.id})`).join(", ")}.` +
        (failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : "");

    return [
        summary,
        ...blocks,
        started.length === 1
            ? "The run works in the background. A message arrives when its turn ends."
            : "The runs work in the background. A message arrives when each run's turn ends.",
    ].join("\n\n");
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

/** `82%`: a value from 0 to 1 as a whole percentage. */
export function formatPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function heading(run: Run): string {
    return `Run ${run.name} (${run.id}): ${run.state}${run.readOnly ? ", read-only" : ""}`;
}

function startedHeading(run: Run): string {
    return `Started run ${run.name} (${run.id}): ${run.state}.`;
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

    for (const earlier of turn.earlierReports ?? []) {
        lines.push(`Earlier report in that turn, replaced by a later one: ${earlier.status}`);

        if (preview) {
            continue;
        }

        if (earlier.reason) {
            lines.push(`Reason: ${earlier.reason}`);
        }

        if (earlier.question) {
            lines.push(`Question: ${earlier.question}`);
        }

        lines.push("Summary:", earlier.summary, "");
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
