import type {
    MessageRenderOptions,
    Theme,
    ThemeBg,
    ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import {
    activityStatus,
    luneThemeRenderer,
    type LuneActivity,
    type LuneThemeRenderer,
} from "../render/lune-theme.ts";
import { bandRow, clipToWidth, displayLines, EXPAND_KEY } from "../render/text.ts";
import { formatDuration } from "../tools/format.ts";
import type {
    ContentSlice,
    EarlierReportNote,
    RunNotificationDetails,
    RunNotificationRun,
} from "./notifier.ts";

/** Lines of a report a collapsed box shows; the rest stay behind the expand hint. */
const PREVIEW_LINES = 5;
const BODY_INDENT = "    ";

/**
 * Render a batch of ended turns as a band: a header, one row per run and the start of each report.
 * Returns undefined for a message without runs, which leaves it to Pi's own custom-message row.
 */
export function renderRunNotificationBox(
    message: { content: unknown; details?: RunNotificationDetails },
    options: MessageRenderOptions,
    theme: Theme,
): Component | undefined {
    const runs = message.details?.runs;

    if (!Array.isArray(runs) || runs.length === 0) {
        return undefined;
    }

    return new RunNotificationBox(
        runs,
        typeof message.content === "string" ? message.content : "",
        options,
        theme,
    );
}

/**
 * Lines are cached per width, because the transcript renders the box on every frame. While the Lune
 * theme is active the box draws its activity card instead; the renderer is looked up on every frame
 * because the theme can be switched while the message stays on screen.
 */
class RunNotificationBox implements Component {
    private readonly runs: readonly RunNotificationRun[];
    private readonly content: string;
    private readonly expanded: boolean;
    private readonly paddingX: number;
    private readonly theme: Theme;

    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;
    private themed: { renderer: LuneThemeRenderer; component: Component } | undefined;

    constructor(
        runs: readonly RunNotificationRun[],
        content: string,
        options: MessageRenderOptions,
        theme: Theme,
    ) {
        this.runs = runs;
        this.content = content;
        this.expanded = options.expanded;
        this.paddingX = Math.max(0, options.outputPad);
        this.theme = theme;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
        this.themed?.component.invalidate();
    }

    handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
        return this.themed?.component.handleMouse?.(event);
    }

    render(width: number): string[] {
        const renderer = luneThemeRenderer();

        if (renderer) {
            if (this.themed?.renderer !== renderer) {
                this.themed = {
                    renderer,
                    component: renderer.renderActivity(
                        this.activity(),
                        { expanded: this.expanded, key: this.runs },
                        this.theme,
                    ),
                };
            }

            return this.themed.component.render(width);
        }

        this.themed = undefined;

        if (this.cachedLines !== undefined && this.cachedWidth === width) {
            return this.cachedLines;
        }

        this.cachedWidth = width;
        this.cachedLines = this.buildLines(width);

        return this.cachedLines;
    }

    private buildLines(width: number): string[] {
        const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
        const inner = Math.max(1, width - paddingX * 2);
        const bodyWidth = Math.max(1, inner - BODY_INDENT.length);
        const token = this.bandToken();
        const color: ThemeColor =
            token === "toolErrorBg" ? "error" : token === "toolPendingBg" ? "accent" : "success";
        const rows = [
            `${this.theme.fg(color, "●")} ${this.theme.bold(this.theme.fg(color, this.headerText()))}`,
        ];

        for (const run of this.runs) {
            rows.push(this.runRow(run, inner));

            for (const note of notes(run)) {
                rows.push(...this.bodyRows(note, bodyWidth, "muted"));
            }

            if (run.error) {
                rows.push(...this.bodyRows(`Error: ${run.error}`, bodyWidth, "error"));
            }

            if (run.reason) {
                rows.push(...this.bodyRows(`Reason: ${run.reason}`, bodyWidth, "error"));
            }

            if (run.question) {
                rows.push(...this.bodyRows(`Question: ${run.question}`, bodyWidth, "accent"));
            }

            rows.push(...this.reportRows(run, bodyWidth));

            for (const earlier of run.earlierReports ?? []) {
                rows.push(...this.earlierRows(earlier, bodyWidth));
            }
        }

        return ["", ...rows, ""].map((row) => bandRow(this.theme, token, row, inner, paddingX));
    }

    private activity(): LuneActivity {
        const total = this.runs.length;

        return {
            title: total === 1 ? "subagent" : "subagents",
            summary: total === 1 ? undefined : `${total} runs`,
            entries: this.runs.map((run) => ({
                name: run.name,
                summary: run.question ?? run.reason ?? firstLine(this.body(run)),
                status: activityStatus(run.state),
                detail: [
                    run.reportStatus ?? "unreported",
                    earlierCount(run),
                    run.copied ? "copied" : undefined,
                ]
                    .filter((part) => part !== undefined)
                    .join(" · "),
                durationMs: run.durationMs,
                error: run.error,
                output: displayLines(
                    [
                        this.body(run),
                        ...(run.earlierReports ?? []).map((earlier) =>
                            [
                                earlierTitle(earlier),
                                ...earlierFields(earlier),
                                this.slice(earlier.summary),
                            ].join("\n"),
                        ),
                    ].join("\n\n"),
                ).join("\n"),
            })),
        };
    }

    private headerText(): string {
        if (this.runs.length === 1) {
            const run = this.runs[0]!;

            return run.copied
                ? `Subagent ${run.name} · copied from another branch`
                : `Subagent ${run.name} ended its turn`;
        }

        return `${this.runs.length} subagent turns ended`;
    }

    /** `<name> · <state> · <report status> · <duration>`; the name is clipped first. */
    private runRow(run: RunNotificationRun, width: number): string {
        const state = this.theme.fg(stateColor(run.state), run.state);
        const report = this.theme.fg(
            reportColor(run.reportStatus),
            run.reportStatus ?? "unreported",
        );
        const parts = [state, report];

        if (run.durationMs !== undefined && Number.isFinite(run.durationMs)) {
            parts.push(this.theme.fg("muted", formatDuration(run.durationMs)));
        }

        const separator = this.theme.fg("dim", " · ");
        const used =
            parts.reduce((total, part) => total + visibleWidth(part), 0) +
            parts.length * visibleWidth(separator);
        const name = this.theme.fg("text", clipToWidth(`${run.name} (${run.runId})`, width - used));

        return [name, ...parts].join(separator);
    }

    /** The start of the report summary, or of an unreported turn's last message. */
    private reportRows(run: RunNotificationRun, width: number): string[] {
        const lines = displayLines(this.body(run)).flatMap((line) => wrapTextWithAnsi(line, width));

        while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
            lines.pop();
        }

        const shown = this.expanded ? lines : lines.slice(0, PREVIEW_LINES);
        const hidden = lines.length - shown.length;
        const rows = shown.map((line) => BODY_INDENT + this.theme.fg("toolOutput", line));

        if (hidden > 0) {
            rows.push(
                BODY_INDENT +
                    this.theme.fg("muted", `… ${hidden} more lines · ${EXPAND_KEY} to expand`),
            );
        }

        return rows;
    }

    /** A report that a later one replaced: one row, and its text once the box is expanded. */
    private earlierRows(earlier: EarlierReportNote, width: number): string[] {
        const rows = this.bodyRows(
            this.expanded
                ? earlierTitle(earlier)
                : `${earlierTitle(earlier)} · ${EXPAND_KEY} to expand`,
            width,
            "muted",
        );

        if (!this.expanded) {
            return rows;
        }

        if (earlier.reason) {
            rows.push(...this.bodyRows(`Reason: ${earlier.reason}`, width, "error"));
        }

        if (earlier.question) {
            rows.push(...this.bodyRows(`Question: ${earlier.question}`, width, "accent"));
        }

        rows.push(...this.bodyRows(this.slice(earlier.summary), width, "toolOutput"));

        return rows;
    }

    private body(run: RunNotificationRun): string {
        return run.body ? this.slice(run.body) : "";
    }

    /** A text as the message content holds it; details carry only its offsets. */
    private slice(slice: ContentSlice): string {
        const start = Math.max(0, Math.min(slice.start, this.content.length));
        const end = Math.max(start, Math.min(slice.end, this.content.length));

        return this.content.slice(start, end);
    }

    private bodyRows(text: string, width: number, color: ThemeColor): string[] {
        return displayLines(text)
            .flatMap((line) => wrapTextWithAnsi(line, width))
            .map((line) => BODY_INDENT + this.theme.fg(color, line));
    }

    private bandToken(): ThemeBg {
        if (this.runs.some((run) => run.state === "failed" || run.reportStatus === "blocked")) {
            return "toolErrorBg";
        }

        if (this.runs.some((run) => run.reportStatus === "needs_input")) {
            return "toolPendingBg";
        }

        return "toolSuccessBg";
    }
}

function notes(run: RunNotificationRun): string[] {
    const lines: string[] = [];

    if (run.stoppedBy === "user") {
        lines.push("Stopped by the user.");
    } else if (run.stoppedBy === "branch") {
        lines.push("Stopped when the user left its branch.");
    }

    if (run.userWrote) {
        lines.push("The user wrote to this run during the turn.");
    }

    return lines;
}

function earlierCount(run: RunNotificationRun): string | undefined {
    const count = run.earlierReports?.length ?? 0;

    if (count === 0) {
        return undefined;
    }

    return `${count} earlier ${count === 1 ? "report" : "reports"}`;
}

function earlierTitle(earlier: EarlierReportNote): string {
    return `Earlier report: ${earlier.status}, replaced by a later one`;
}

function earlierFields(earlier: EarlierReportNote): string[] {
    return [
        earlier.reason ? `Reason: ${earlier.reason}` : undefined,
        earlier.question ? `Question: ${earlier.question}` : undefined,
    ].filter((field) => field !== undefined);
}

function firstLine(text: string): string | undefined {
    const line = displayLines(text).find((candidate) => candidate.trim() !== "");

    return line?.trim();
}

export function stateColor(state: string): ThemeColor {
    switch (state) {
        case "running":
            return "warning";
        case "idle":
            return "success";
        case "failed":
            return "error";
        default:
            return "muted";
    }
}

export function reportColor(status: string | undefined): ThemeColor {
    switch (status) {
        case "done":
            return "success";
        case "blocked":
            return "error";
        case "needs_input":
            return "accent";
        default:
            return "warning";
    }
}
