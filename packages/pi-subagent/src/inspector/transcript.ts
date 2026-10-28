import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { reportColor } from "../notify/notification-box.ts";
import type { LuneActivityStatus } from "../render/lune-theme.ts";
import { displayLine, displayLines } from "../render/text.ts";
import { isUserMessage, stripUserMarker } from "../run/guide.ts";
import { REPORT_TOOL_NAME } from "../run/report-tool.ts";
import type { Run, RunningTool } from "../run/run.ts";
import { AUTO_TIERS, type AutoModelChoice, type AutoRisk, type RunSnapshot } from "../run/types.ts";
import { formatDuration, formatPercent, ratingText } from "../tools/format.ts";
import { pad } from "./layout.ts";
import { headRows, LineWrapCache, tailRows } from "./wrap.ts";

/** Rows of a failed call's error, a running call's output or a streamed thought; it is a log, not a pager. */
const EXCERPT_ROWS = 3;
const INDENT = "    ";
const COLUMN_GAP = "  ";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

/**
 * The rows of a run's settled messages, the ones that can no longer change.
 *
 * A run's session only appends, so a later transcript that still holds `last` at `count - 1` only
 * adds messages, and the rows grow by theirs.
 */
interface SettledRows {
    runId: string;
    width: number;
    count: number;
    last: AgentMessage | undefined;
    rows: string[];
    /** Results of every message read so far; a result never comes before its call. */
    results: Map<string, ToolResult>;
    read: number;
}

/**
 * Draws a run's messages for the inspector's right pane with the parent's theme.
 *
 * It renders on its own: Pi's tool renderers read a module-global theme that an extension cannot
 * rely on. Settled messages are drawn once per width; only the live tail (the streamed message, the
 * last assistant message while its tools run, and a retry notice) is drawn again on each frame.
 */
export class TranscriptRenderer {
    private readonly theme: Theme;
    private readonly wraps = new LineWrapCache();
    private blocks = new WeakMap<object, { width: number; rows: string[] }>();
    private settled: SettledRows | undefined;

    constructor(theme: Theme) {
        this.theme = theme;
    }

    render(run: Run, width: number): readonly string[] {
        const messages = run.transcript();
        const settled = this.settledRows(run, messages, width);
        const streamed =
            run.streaming && !messages.includes(run.streaming) ? run.streaming : undefined;
        const lastAssistant =
            streamed ?? messages.findLast((message) => message.role === "assistant");
        const tail: string[] = [];
        const add = (rows: readonly string[]): void => {
            if (rows.length === 0) {
                return;
            }

            if (settled.rows.length + tail.length > 0) {
                tail.push("");
            }

            append(tail, rows);
        };
        const context = (message: AgentMessage): BlockContext => ({
            run,
            width,
            results: settled.results,
            pending: run.state === "running" && message === lastAssistant,
            live: message === run.streaming,
        });

        for (let index = settled.count; index < messages.length; index++) {
            add(this.buildBlock(messages[index]!, context(messages[index]!)));
        }

        if (streamed) {
            add(this.buildBlock(streamed, context(streamed)));
        }

        if (run.activity) {
            add(this.wrap(run.activity, width, "warning"));
        }

        return tail.length === 0 ? settled.rows : [...settled.rows, ...tail];
    }

    /** Forget every drawn row, for example after the theme changed. */
    clear(): void {
        this.blocks = new WeakMap();
        this.settled = undefined;
        this.wraps.clear();
    }

    private settledRows(run: Run, messages: readonly AgentMessage[], width: number): SettledRows {
        let settled = this.settled;

        if (
            !settled ||
            settled.runId !== run.id ||
            settled.width !== width ||
            settled.read > messages.length ||
            (settled.count > 0 && messages[settled.count - 1] !== settled.last)
        ) {
            settled = {
                runId: run.id,
                width,
                count: 0,
                last: undefined,
                // The snapshot never changes, so the auto choice is drawn with the settled rows.
                rows: this.autoRows(run, width),
                results: new Map(),
                read: 0,
            };
            this.settled = settled;
        }

        for (; settled.read < messages.length; settled.read++) {
            const message = messages[settled.read]!;

            if (message.role === "toolResult") {
                settled.results.set(message.toolCallId, message);
            }
        }

        const count = settledCount(run, messages, settled.results);

        for (; settled.count < count; settled.count++) {
            const message = messages[settled.count]!;
            const rows = this.block(message, {
                run,
                width,
                results: settled.results,
                pending: false,
                live: false,
            });

            if (rows.length > 0) {
                if (settled.rows.length > 0) {
                    settled.rows.push("");
                }

                append(settled.rows, rows);
            }

            settled.last = message;
        }

        return settled;
    }

    /**
     * How `model: auto` resolved the run, above its first message: the classifier's share for
     * each task tier, highest first, the tier and model the run got, and the thinking rating.
     * The model row keeps only the short mark.
     */
    private autoRows(run: Run, width: number): string[] {
        const snapshot = run.snapshot;
        const auto = snapshot?.autoModel;

        switch (auto?.by) {
            case undefined:
                return [];
            case "no-classifier":
                return this.wrap(
                    "No auto classifier is selected, so the run uses the main agent's model.",
                    width,
                    "muted",
                );
            case "nothing-to-rate":
                return this.wrap(
                    "No auto tier has a model and the thinking is set, so no classifier ran and " +
                        "the run uses the main agent's model.",
                    width,
                    "muted",
                );
            case "classifier-failed":
                return this.wrap(
                    `${auto.error} The run uses the main agent's model` +
                        (snapshot!.sources.thinking === "parent" ? " and thinking." : "."),
                    width,
                    "warning",
                );
            case "rating":
                return this.ratingRows(auto, snapshot!, width);
            default:
                // A run that an earlier version started records its auto choice in another form.
                return [];
        }
    }

    /** Aligned tier rows, or one wrapped entry per tier when the columns do not fit. */
    private ratingRows(
        auto: Extract<AutoModelChoice, { by: "rating" }>,
        snapshot: RunSnapshot,
        width: number,
    ): string[] {
        const { tier, thinking, risk } = auto;
        const model =
            snapshot.model +
            (auto.modelFrom === tier.used
                ? ""
                : auto.modelFrom === "main"
                  ? " (main agent's model)"
                  : ` (${auto.modelFrom} tier)`);
        // The sort is stable, so equal or missing shares keep the tier order.
        const ranked = AUTO_TIERS.map((level) => ({
            level,
            share: tier.probabilities[level],
        })).sort((a, b) => (b.share ?? -1) - (a.share ?? -1));
        const shares = ranked.some(({ share }) => share !== undefined);
        const levelWidth = Math.max(...AUTO_TIERS.map((level) => level.length));
        const entries = ranked.map(({ level, share }) => ({
            level,
            percent: share === undefined ? "" : formatPercent(share),
            chosen: level === tier.used,
            rated: level === tier.rated && tier.rated !== tier.used,
        }));
        const aligned = entries.map(({ level, percent, chosen, rated }) => {
            const columns =
                pad(level, levelWidth) + (shares ? COLUMN_GAP + percent.padStart(4) : "");
            const mark = chosen
                ? COLUMN_GAP +
                  this.theme.fg("accent", "chosen") +
                  this.theme.fg("text", ` → ${model}`)
                : rated
                  ? COLUMN_GAP + this.theme.fg("muted", "rated")
                  : "";

            // The columns are padded only for a mark after them, so no row ends in spaces.
            return (
                INDENT +
                this.theme.fg(chosen ? "text" : "muted", mark ? columns : columns.trimEnd()) +
                mark
            );
        });
        const rows = aligned.every((row) => visibleWidth(row) <= width)
            ? aligned
            : entries.flatMap(({ level, percent, chosen, rated }) =>
                  this.indented(
                      [level, percent, chosen ? `chosen → ${model}` : rated ? "rated" : ""]
                          .filter(Boolean)
                          .join(" · "),
                      width,
                      chosen ? "text" : "muted",
                  ),
              );
        const unsure =
            tier.used === tier.rated
                ? ""
                : ` It was unsure (${formatPercent(tier.confidence)} confidence), so the run ` +
                  `uses the ${tier.used} tier.`;

        return [
            ...this.wrap(
                `${auto.classifier} rated the task ${tier.rated}.${unsure}`,
                width,
                "muted",
            ),
            ...rows,
            // A run that an earlier version started has no thinking or risk rating here.
            ...(risk ? this.wrap(riskLine(risk), width, risk.high ? "warning" : "muted") : []),
            ...(thinking ? this.wrap(`Thinking: ${ratingText(thinking)}`, width, "muted") : []),
        ];
    }

    /** A settled message's rows, kept per message so switching back to a run redraws nothing. */
    private block(message: AgentMessage, context: BlockContext): string[] {
        const cached = this.blocks.get(message);

        if (cached?.width === context.width) {
            return cached.rows;
        }

        const rows = this.buildBlock(message, context);

        this.blocks.set(message, { width: context.width, rows });

        return rows;
    }

    private buildBlock(message: AgentMessage, context: BlockContext): string[] {
        const { width } = context;

        switch (message.role) {
            case "user": {
                const text =
                    typeof message.content === "string"
                        ? message.content
                        : message.content
                              .map((part) => (part.type === "text" ? part.text : "[image]"))
                              .join("\n");
                const fromUser = isUserMessage(text);

                return [
                    this.theme.bold(
                        this.theme.fg(
                            fromUser ? "accent" : "mdHeading",
                            fromUser ? "› User" : "› Main agent",
                        ),
                    ),
                    ...this.wrap(stripUserMarker(text), width, "userMessageText"),
                ];
            }
            case "assistant":
                return this.assistantRows(message, context);
            case "toolResult":
                // Drawn with the call that asked for it.
                return [];
            case "compactionSummary":
                return [this.theme.fg("muted", "Context compacted")];
            case "branchSummary":
                return [this.theme.fg("muted", "Branch summary")];
            case "bashExecution":
                return [
                    ...wrapTextWithAnsi(
                        this.theme.fg("toolTitle", `$ ${clip(message.command)}`),
                        width,
                    ),
                    ...this.excerpt(message.output, width, "toolOutput", "head"),
                ];
            case "custom":
                return message.display
                    ? this.wrap(
                          typeof message.content === "string"
                              ? message.content
                              : message.content
                                    .map((part) => (part.type === "text" ? part.text : ""))
                                    .join("\n"),
                          width,
                          "customMessageText",
                      )
                    : [];
            default:
                return [];
        }
    }

    private assistantRows(message: AssistantMessage, context: BlockContext): string[] {
        const rows: string[] = [];
        let group: ToolCall[] = [];
        const flushGroup = (): void => {
            if (group.length > 0) {
                append(rows, this.toolGroup(group, context));
                group = [];
            }
        };

        for (const [index, part] of message.content.entries()) {
            if (part.type === "toolCall") {
                group.push(part);
                continue;
            }

            flushGroup();

            if (part.type === "thinking") {
                append(
                    rows,
                    this.thinkingRows(
                        part.redacted ? undefined : part.thinking,
                        context.width,
                        context.live && index === message.content.length - 1,
                    ),
                );
            } else if (part.text.trim() !== "") {
                append(rows, this.wrap(part.text, context.width, "text"));
            }
        }

        flushGroup();

        if (message.stopReason === "error") {
            append(
                rows,
                this.wrap(
                    `Error: ${message.errorMessage ?? "The model request failed."}`,
                    context.width,
                    "error",
                ),
            );
        } else if (message.stopReason === "aborted") {
            rows.push(this.theme.fg("muted", "Stopped"));
        }

        return rows;
    }

    /** One `Thinking · 12 lines` row; a thought still streaming also shows its newest rows. */
    private thinkingRows(
        thinking: string | undefined,
        width: number,
        streaming: boolean,
    ): string[] {
        const label = (text: string): string =>
            this.theme.italic(this.theme.fg("thinkingText", text));

        if (thinking === undefined) {
            return [label("Thinking redacted")];
        }

        const text = thinking.replace(/\s+$/, "");

        if (text === "") {
            return streaming ? [label("Thinking")] : [];
        }

        const lines = displayLines(text);
        const rows = [label(`Thinking · ${lines.length} ${lines.length === 1 ? "line" : "lines"}`)];

        if (streaming) {
            const shown = tailRows(lines, Math.max(1, width - INDENT.length), EXCERPT_ROWS).rows;

            append(
                rows,
                shown.map((row) => INDENT + label(row)),
            );
        }

        return rows;
    }

    private toolGroup(calls: readonly ToolCall[], context: BlockContext): string[] {
        const rows: string[] = [];

        for (const call of calls) {
            if (call.name !== REPORT_TOOL_NAME) {
                append(rows, this.toolRows(call, context));
            }
        }

        for (const call of calls) {
            if (call.name === REPORT_TOOL_NAME) {
                append(rows, this.reportRows(call, context));
            }
        }

        return rows;
    }

    /**
     * `● read src/a.ts · 0.2s`. A finished call shows no output; a failed call shows the start of
     * its error and a running call the end of its output.
     */
    private toolRows(call: ToolCall, context: BlockContext): string[] {
        const result = context.results.get(call.id);
        const running = context.run.runningTools.get(call.id);
        const status = callStatus(result, running, context.pending);
        const [color, icon] = STATUS_STYLE[status];
        const diff = diffOf(result);
        const meta = [
            diff ? this.diffStat(diff) : undefined,
            status === "cancelled" ? this.theme.fg("dim", "not finished") : undefined,
            result?.durationMs !== undefined
                ? this.theme.fg("dim", formatDuration(result.durationMs))
                : running
                  ? this.theme.fg("dim", formatDuration(Date.now() - running.startedAt))
                  : undefined,
        ].filter((part) => part !== undefined);
        const separator = this.theme.fg("dim", " · ");
        const head =
            `${this.theme.fg(color, icon)} ${this.theme.bold(this.theme.fg("toolTitle", call.name))} ` +
            this.theme.fg("muted", toolSummary(call)) +
            (meta.length > 0 ? separator + meta.join(separator) : "");
        const rows = wrapTextWithAnsi(head, context.width);

        if (call.argumentsError) {
            append(rows, this.excerpt(call.argumentsError, context.width, "error", "head"));
        }

        if (result?.isError) {
            append(rows, this.excerpt(resultText(result), context.width, "error", "head"));
        } else if (!result && running?.partialResult !== undefined) {
            append(
                rows,
                this.excerpt(
                    partialText(running.partialResult),
                    context.width,
                    "toolOutput",
                    "tail",
                ),
            );
        }

        return rows;
    }

    /**
     * `Report done`. The arguments stream before the call runs, and the main agent gets the report
     * only when the turn ends, so until the call has a result its status is muted and marked.
     */
    private reportRows(call: ToolCall, context: BlockContext): string[] {
        const args = call.arguments as Record<string, unknown>;
        const status = typeof args.status === "string" ? displayLine(args.status) : "report";
        const result = context.results.get(call.id);
        const progress = callStatus(result, context.run.runningTools.get(call.id), context.pending);
        const draft = progress === "running" || progress === "cancelled";
        const mark =
            progress === "running"
                ? this.theme.fg("warning", "writing")
                : progress === "cancelled"
                  ? this.theme.fg("muted", "not sent")
                  : undefined;
        const rows = [
            `${this.theme.bold(this.theme.fg("toolTitle", "Report"))} ` +
                this.theme.fg(draft ? "muted" : reportColor(status), status) +
                (mark ? this.theme.fg("dim", " · ") + mark : ""),
        ];

        if (result?.isError) {
            append(rows, this.excerpt(resultText(result), context.width, "error", "head"));
        }

        if (typeof args.reason === "string" && args.reason.trim() !== "") {
            append(rows, this.indented(`Reason: ${args.reason}`, context.width, "error"));
        }

        if (typeof args.question === "string" && args.question.trim() !== "") {
            append(rows, this.indented(`Question: ${args.question}`, context.width, "accent"));
        }

        if (typeof args.summary === "string") {
            append(rows, this.indented(args.summary, context.width, draft ? "muted" : "text"));
        }

        return rows;
    }

    /** `+12 −3`: the lines a diff adds and removes. */
    private diffStat(diff: string): string {
        let added = 0;
        let removed = 0;

        for (const line of diff.split("\n")) {
            if (line.startsWith("+")) {
                added += 1;
            } else if (line.startsWith("-")) {
                removed += 1;
            }
        }

        return `${this.theme.fg("toolDiffAdded", `+${added}`)} ${this.theme.fg("toolDiffRemoved", `−${removed}`)}`;
    }

    private wrap(text: string, width: number, color: ThemeColor): string[] {
        const rows: string[] = [];

        for (const line of displayLines(text.replace(/\s+$/, ""))) {
            for (const row of this.wraps.rows(line, Math.max(1, width))) {
                rows.push(this.theme.fg(color, row));
            }
        }

        return rows;
    }

    private indented(text: string, width: number, color: ThemeColor): string[] {
        return this.wrap(text, width - INDENT.length, color).map((row) => INDENT + row);
    }

    /** The first or the last few rows of a text, with a note of how many lines are left out. */
    private excerpt(
        text: string,
        width: number,
        color: ThemeColor,
        from: "head" | "tail",
    ): string[] {
        const trimmed = text.replace(/\s+$/, "");

        if (trimmed === "") {
            return [];
        }

        const lines = displayLines(trimmed);
        const inner = Math.max(1, width - INDENT.length);
        const { rows, hidden } =
            from === "head"
                ? headRows(lines, inner, EXCERPT_ROWS)
                : tailRows(lines, inner, EXCERPT_ROWS);
        const shown = rows.map((row) => INDENT + this.theme.fg(color, row));

        if (hidden === 0) {
            return shown;
        }

        const note =
            INDENT +
            this.theme.fg(
                "muted",
                `… ${hidden} ${from === "tail" ? "earlier" : "more"} ${hidden === 1 ? "line" : "lines"}`,
            );

        return from === "tail" ? [note, ...shown] : [...shown, note];
    }
}

interface BlockContext {
    run: Run;
    width: number;
    results: ReadonlyMap<string, ToolResult>;
    /** The run is still working on this message's tool calls. */
    pending: boolean;
    /** The message is still streaming. */
    live: boolean;
}

const STATUS_STYLE: Record<LuneActivityStatus, [ThemeColor, string]> = {
    running: ["warning", "◐"],
    done: ["success", "●"],
    failed: ["error", "✕"],
    cancelled: ["muted", "○"],
};

/**
 * How many messages from the start can no longer change. Only the last assistant message can: its
 * calls still wait for results, which also covers the streamed message once it is saved.
 */
function settledCount(
    run: Run,
    messages: readonly AgentMessage[],
    results: ReadonlyMap<string, ToolResult>,
): number {
    const streamed = run.streaming ? messages.indexOf(run.streaming) : -1;

    if (streamed !== -1) {
        return streamed;
    }

    const last = messages.findLastIndex((message) => message.role === "assistant");
    const message = messages[last];

    if (
        message?.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall" && !results.has(part.id))
    ) {
        return last;
    }

    return messages.length;
}

function callStatus(
    result: ToolResult | undefined,
    running: RunningTool | undefined,
    pending: boolean,
): LuneActivityStatus {
    if (result) {
        return result.isError ? "failed" : "done";
    }

    return running || pending ? "running" : "cancelled";
}

/** Appends without spreading, which overflows the call stack for a very long text. */
function append(target: string[], rows: readonly string[]): void {
    for (const row of rows) {
        target.push(row);
    }
}

/** The words that identify a call: its command, path or pattern, else its arguments as JSON. */
export function toolSummary(call: ToolCall): string {
    const args = call.arguments as Record<string, unknown>;

    for (const key of [
        "command",
        "path",
        "file_path",
        "pattern",
        "query",
        "url",
        "runId",
        "task",
    ]) {
        const value = args[key];

        if (typeof value === "string" && value.trim() !== "") {
            return clip(value);
        }
    }

    return clip(JSON.stringify(args) ?? "");
}

function clip(text: string): string {
    const line = displayLine(text);

    return visibleWidth(line) > 80 ? `${line.slice(0, 79)}…` : line;
}

function resultText(result: ToolResult): string {
    return result.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

function partialText(partial: unknown): string {
    const content = (partial as { content?: unknown } | undefined)?.content;

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .map((part: { type?: unknown; text?: unknown }) =>
            part.type === "text" && typeof part.text === "string" ? part.text : "",
        )
        .join("\n");
}

function diffOf(result: ToolResult | undefined): string | undefined {
    const diff = (result?.details as { diff?: unknown } | undefined)?.diff;

    return typeof diff === "string" && diff.trim() !== "" ? diff : undefined;
}

/** The high-risk answer, with the threshold it was judged at and the floor it set. */
function riskLine(risk: AutoRisk): string {
    const shares = `${formatPercent(risk.probability)}, threshold ${formatPercent(risk.threshold)}`;

    return risk.high
        ? `High risk (${shares})` +
              (risk.floor ? `, so the model comes from at least the ${risk.floor} tier.` : ".")
        : `Not high risk (${shares}).`;
}
