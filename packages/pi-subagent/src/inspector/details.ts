import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { displayLines } from "../render/text.ts";
import type { Run } from "../run/run.ts";
import { formatDuration, formatTokens, startValueLines, workspaceLines } from "../tools/format.ts";

/** The `d` view: the snapshot, start values, workspace, token usage and diagnostics of one run. */
export function detailRows(run: Run, theme: Theme, width: number): string[] {
    const rows: string[] = [];
    const section = (title: string): void => {
        if (rows.length > 0) {
            rows.push("");
        }

        rows.push(theme.bold(theme.fg("mdHeading", title)));
    };
    const line = (text: string, color: ThemeColor = "text"): void => {
        for (const part of displayLines(text)) {
            rows.push(
                ...wrapTextWithAnsi(part, Math.max(1, width)).map((row) => theme.fg(color, row)),
            );
        }
    };

    section("Run");
    line(`${run.name} (${run.id}) · ${run.state}${run.readOnly ? " · read-only" : ""}`);
    line(`File: ${run.file}`, "muted");

    if (run.readOnly) {
        line(`Inherited from session ${run.parentSessionId} through /fork or /clone.`, "muted");
    }

    if (run.loadError) {
        line(`The run file could not be read: ${run.loadError}`, "error");

        return rows;
    }

    const snapshot = run.snapshot;

    if (snapshot) {
        line(`Created: ${snapshot.createdAt}`, "muted");

        if (snapshot.definition) {
            line(`Definition: ${snapshot.definition.file}`, "muted");
        }

        section("Start values");
        startValueLines(run).forEach((text) => line(text));

        section("Workspace");
        workspaceLines(run).forEach((text) => line(text));
    }

    section("Usage");
    line(`Turns: ${run.turns}`);
    line(
        `Input ${formatTokens(run.usage.input)} · output ${formatTokens(run.usage.output)} · ` +
            `cache read ${formatTokens(run.usage.cacheRead)} · cache write ` +
            `${formatTokens(run.usage.cacheWrite)}`,
    );
    line(`Total ${formatTokens(run.usage.total)} tokens · $${run.usage.cost.toFixed(3)}`);
    line("Not included in the main session's totals.", "muted");

    const turn = run.lastTurn;

    if (turn) {
        section("Last turn");

        const duration = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);

        line(
            `${turn.state} · ${turn.report?.status ?? "unreported"}` +
                (Number.isFinite(duration) ? ` · ${formatDuration(duration)}` : ""),
        );

        if (turn.stoppedBy) {
            line(`Stopped by: ${turn.stoppedBy}`, "muted");
        }

        if (turn.error) {
            line(`Error: ${turn.error}`, "error");
        }
    }

    if (run.diagnostics.length > 0) {
        section("Diagnostics");

        for (const diagnostic of run.diagnostics) {
            line(
                `${new Date(diagnostic.at).toLocaleTimeString()} ${diagnostic.message}`,
                diagnostic.level === "error"
                    ? "error"
                    : diagnostic.level === "warning"
                      ? "warning"
                      : "muted",
            );
        }
    }

    if (snapshot) {
        section("Task");
        line(snapshot.task);

        if (snapshot.definition?.body) {
            section("Definition body");
            line(snapshot.definition.body, "muted");
        }
    }

    return rows;
}
