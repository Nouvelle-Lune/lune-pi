import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import { reportColor } from "../notify/notification-box.ts";
import {
    luneThemeRenderer,
    type LuneActivity,
    type LuneActivityStatus,
    type LuneThemeRenderer,
} from "../render/lune-theme.ts";
import { displayLines } from "../render/text.ts";
import { isUserMessage, stripUserMarker } from "../run/guide.ts";
import { REPORT_TOOL_NAME } from "../run/report-tool.ts";
import type { Run, RunningTool } from "../run/run.ts";
import { formatDuration } from "../tools/format.ts";

/** Output lines a tool call shows; the inspector is a log, not a pager. */
const TOOL_OUTPUT_LINES = 8;
const DIFF_LINES = 40;
const INDENT = "    ";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

export interface TranscriptCard {
    /** Transcript rows the card occupies, end exclusive. */
    start: number;
    end: number;
    component: Component;
}

export interface Transcript {
    rows: string[];
    cards: TranscriptCard[];
}

/** Static rows, or an activity card that renders itself, since a click can change its height. */
type Piece = { rows: string[] } | { card: Component };

interface CachedBlock {
    width: number;
    renderer: LuneThemeRenderer | undefined;
    signature: string;
    pieces: Piece[];
}

interface CachedCard {
    /** Stable for the tool group, so the theme remembers what a click opened. */
    key: object;
    renderer: LuneThemeRenderer;
    signature: string;
    component: Component;
}

/**
 * Draws a run's messages for the inspector's right pane with the parent's theme.
 *
 * It renders on its own: Pi's tool renderers read a module-global theme that an extension cannot
 * rely on. While Core Theme is active, tool calls are drawn as its activity cards; assistant text,
 * reports and diffs stay on this path either way.
 */
export class TranscriptRenderer {
    private readonly theme: Theme;
    private blocks = new WeakMap<object, CachedBlock>();
    private readonly cards = new Map<string, CachedCard>();

    constructor(theme: Theme) {
        this.theme = theme;
    }

    render(run: Run, width: number): Transcript {
        const renderer = luneThemeRenderer();
        const messages = [...run.transcript()];

        if (run.streaming && !messages.includes(run.streaming)) {
            messages.push(run.streaming);
        }

        const results = new Map<string, ToolResult>();

        for (const message of messages) {
            if (message.role === "toolResult") {
                results.set(message.toolCallId, message);
            }
        }

        const lastAssistant = messages.findLast((message) => message.role === "assistant");
        const rows: string[] = [];
        const cards: TranscriptCard[] = [];

        for (const message of messages) {
            const pieces = this.block(message, {
                run,
                width,
                renderer,
                results,
                pending: run.state === "running" && message === lastAssistant,
            });

            if (pieces.length === 0) {
                continue;
            }

            if (rows.length > 0) {
                rows.push("");
            }

            for (const piece of pieces) {
                if ("rows" in piece) {
                    rows.push(...piece.rows);
                } else {
                    const lines = piece.card.render(width);

                    cards.push({
                        start: rows.length,
                        end: rows.length + lines.length,
                        component: piece.card,
                    });
                    rows.push(...lines);
                }
            }
        }

        if (run.activity) {
            rows.push("", this.theme.fg("warning", run.activity));
        }

        return { rows, cards };
    }

    /** Forget every cached block, for example after the theme changed. */
    clear(): void {
        this.blocks = new WeakMap();
        this.cards.clear();
    }

    private block(message: AgentMessage, context: BlockContext): Piece[] {
        // The streamed message changes in place, so it is never cached.
        const cacheable = message !== context.run.streaming;
        const signature = cacheable ? blockSignature(message, context) : "";
        const cached = cacheable ? this.blocks.get(message) : undefined;

        if (
            cached &&
            cached.width === context.width &&
            cached.renderer === context.renderer &&
            cached.signature === signature
        ) {
            return cached.pieces;
        }

        const pieces = this.buildBlock(message, context);

        if (cacheable) {
            this.blocks.set(message, {
                width: context.width,
                renderer: context.renderer,
                signature,
                pieces,
            });
        }

        return pieces;
    }

    private buildBlock(message: AgentMessage, context: BlockContext): Piece[] {
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
                    {
                        rows: [
                            this.theme.bold(
                                this.theme.fg(
                                    fromUser ? "accent" : "mdHeading",
                                    fromUser ? "› User" : "› Main agent",
                                ),
                            ),
                            ...this.wrap(stripUserMarker(text), width, "userMessageText"),
                        ],
                    },
                ];
            }
            case "assistant":
                return this.assistantBlock(message, context);
            case "toolResult":
                // Drawn with the call that asked for it.
                return [];
            case "compactionSummary":
                return [{ rows: [this.theme.fg("muted", "Context compacted")] }];
            case "branchSummary":
                return [{ rows: [this.theme.fg("muted", "Branch summary")] }];
            case "bashExecution":
                return [
                    {
                        rows: [
                            this.theme.fg("toolTitle", `$ ${message.command}`),
                            ...this.limited(message.output, width, "toolOutput", TOOL_OUTPUT_LINES),
                        ],
                    },
                ];
            case "custom":
                return message.display
                    ? [
                          {
                              rows: this.wrap(
                                  typeof message.content === "string"
                                      ? message.content
                                      : message.content
                                            .map((part) => (part.type === "text" ? part.text : ""))
                                            .join("\n"),
                                  width,
                                  "customMessageText",
                              ),
                          },
                      ]
                    : [];
            default:
                return [];
        }
    }

    private assistantBlock(message: AssistantMessage, context: BlockContext): Piece[] {
        const pieces: Piece[] = [];
        let rows: string[] = [];
        let group: ToolCall[] = [];
        const flushRows = (): void => {
            if (rows.length > 0) {
                pieces.push({ rows });
                rows = [];
            }
        };
        const flushGroup = (): void => {
            if (group.length > 0) {
                flushRows();
                pieces.push(...this.toolGroup(group, context));
                group = [];
            }
        };

        for (const part of message.content) {
            if (part.type === "toolCall") {
                group.push(part);
                continue;
            }

            flushGroup();

            if (part.type === "thinking") {
                rows.push(
                    ...(part.redacted
                        ? [this.theme.fg("thinkingText", "Thinking redacted")]
                        : this.wrap(part.thinking, context.width, "thinkingText").map((line) =>
                              this.theme.italic(line),
                          )),
                );
            } else if (part.text.trim() !== "") {
                rows.push(...this.wrap(part.text, context.width, "text"));
            }
        }

        flushGroup();

        if (message.stopReason === "error") {
            rows.push(
                ...this.wrap(
                    `Error: ${message.errorMessage ?? "The model request failed."}`,
                    context.width,
                    "error",
                ),
            );
        } else if (message.stopReason === "aborted") {
            rows.push(this.theme.fg("muted", "Stopped"));
        }

        flushRows();

        return pieces;
    }

    private toolGroup(calls: readonly ToolCall[], context: BlockContext): Piece[] {
        const pieces: Piece[] = [];
        const tools = calls.filter((call) => call.name !== REPORT_TOOL_NAME);

        if (tools.length > 0 && context.renderer) {
            pieces.push({ card: this.card(tools, context, context.renderer) });

            // The card protocol has no diffs, so they keep this path under the card.
            for (const call of tools) {
                const diff = diffOf(context.results.get(call.id));

                if (diff) {
                    pieces.push({
                        rows: [
                            this.theme.fg("muted", `${call.name} ${toolSummary(call)}`),
                            ...this.diffRows(diff, context.width),
                        ],
                    });
                }
            }
        } else {
            for (const call of tools) {
                pieces.push({ rows: this.toolRows(call, context) });
            }
        }

        for (const call of calls) {
            if (call.name === REPORT_TOOL_NAME) {
                pieces.push({ rows: this.reportRows(call, context) });
            }
        }

        return pieces;
    }

    private toolRows(call: ToolCall, context: BlockContext): string[] {
        const result = context.results.get(call.id);
        const running = context.run.runningTools.get(call.id);
        const status = callStatus(result, running, context.pending);
        const [color, icon] = STATUS_STYLE[status];
        const suffix = [
            status === "cancelled" ? "not finished" : undefined,
            result?.durationMs !== undefined ? formatDuration(result.durationMs) : undefined,
        ]
            .filter((part) => part !== undefined)
            .join(" · ");
        const head =
            `${this.theme.fg(color, icon)} ${this.theme.bold(this.theme.fg("toolTitle", call.name))} ` +
            this.theme.fg("muted", toolSummary(call)) +
            (suffix ? this.theme.fg("dim", ` · ${suffix}`) : "");
        const rows = wrapTextWithAnsi(head, context.width);

        if (call.argumentsError) {
            rows.push(
                ...this.indented(call.argumentsError, context.width, "error", TOOL_OUTPUT_LINES),
            );
        }

        const diff = diffOf(result);

        if (diff) {
            rows.push(...this.diffRows(diff, context.width));
        } else if (result) {
            rows.push(
                ...this.indented(
                    resultText(result),
                    context.width,
                    result.isError ? "error" : "toolOutput",
                    TOOL_OUTPUT_LINES,
                ),
            );
        } else if (running?.partialResult !== undefined) {
            rows.push(
                ...this.indented(
                    partialText(running.partialResult),
                    context.width,
                    "toolOutput",
                    TOOL_OUTPUT_LINES,
                    true,
                ),
            );
        }

        return rows;
    }

    private reportRows(call: ToolCall, context: BlockContext): string[] {
        const args = call.arguments as Record<string, unknown>;
        const status = typeof args.status === "string" ? args.status : "report";
        const result = context.results.get(call.id);
        const rows = [
            `${this.theme.bold(this.theme.fg("toolTitle", "Report"))} ` +
                this.theme.fg(reportColor(status), status),
        ];

        if (result?.isError) {
            rows.push(
                ...this.indented(resultText(result), context.width, "error", TOOL_OUTPUT_LINES),
            );
        }

        if (typeof args.reason === "string" && args.reason.trim() !== "") {
            rows.push(...this.indented(`Reason: ${args.reason}`, context.width, "error"));
        }

        if (typeof args.question === "string" && args.question.trim() !== "") {
            rows.push(...this.indented(`Question: ${args.question}`, context.width, "accent"));
        }

        if (typeof args.summary === "string") {
            rows.push(...this.indented(args.summary, context.width, "text"));
        }

        return rows;
    }

    /** One card per tool group; the component is kept while its renderer and data stay the same. */
    private card(
        calls: readonly ToolCall[],
        context: BlockContext,
        renderer: LuneThemeRenderer,
    ): Component {
        const id = calls[0]!.id;
        const activity = this.activity(calls, context);
        const signature = JSON.stringify(activity);
        const cached = this.cards.get(id);

        if (cached && cached.renderer === renderer && cached.signature === signature) {
            return cached.component;
        }

        const key = cached?.key ?? {};
        const component = renderer.renderActivity(activity, { expanded: false, key }, this.theme);

        this.cards.set(id, { key, renderer, signature, component });

        return component;
    }

    private activity(calls: readonly ToolCall[], context: BlockContext): LuneActivity {
        return {
            title: "tools",
            summary: calls.length > 1 ? `${calls.length} calls` : undefined,
            entries: calls.map((call) => {
                const result = context.results.get(call.id);
                const running = context.run.runningTools.get(call.id);
                const status = callStatus(result, running, context.pending);
                const output = result
                    ? resultText(result)
                    : running?.partialResult !== undefined
                      ? partialText(running.partialResult)
                      : "";

                return {
                    name: call.name,
                    summary: toolSummary(call),
                    status,
                    durationMs: result?.durationMs,
                    error: result?.isError ? firstLine(output) : call.argumentsError,
                    output: displayLines(output).join("\n"),
                };
            }),
        };
    }

    private diffRows(diff: string, width: number): string[] {
        const lines = displayLines(diff);
        const shown = lines.slice(0, DIFF_LINES);
        const rows = shown.flatMap((line) => {
            const color: ThemeColor = line.startsWith("+")
                ? "toolDiffAdded"
                : line.startsWith("-")
                  ? "toolDiffRemoved"
                  : "toolDiffContext";

            return wrapTextWithAnsi(line, Math.max(1, width - INDENT.length)).map(
                (part) => INDENT + this.theme.fg(color, part),
            );
        });

        if (lines.length > shown.length) {
            rows.push(
                INDENT + this.theme.fg("muted", `… ${lines.length - shown.length} more diff lines`),
            );
        }

        return rows;
    }

    private wrap(text: string, width: number, color: ThemeColor): string[] {
        return displayLines(text.replace(/\s+$/, ""))
            .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)))
            .map((line) => this.theme.fg(color, line));
    }

    /** Indented lines, the first `limit` of them, or the last ones for output still streaming. */
    private indented(
        text: string,
        width: number,
        color: ThemeColor,
        limit = Number.POSITIVE_INFINITY,
        tail = false,
    ): string[] {
        const lines = displayLines(text.replace(/\s+$/, "")).flatMap((line) =>
            wrapTextWithAnsi(line, Math.max(1, width - INDENT.length)),
        );

        if (lines.length === 1 && lines[0] === "") {
            return [];
        }

        const shown = tail ? lines.slice(-limit) : lines.slice(0, limit);
        const rows = shown.map((line) => INDENT + this.theme.fg(color, line));
        const hidden = lines.length - shown.length;

        if (hidden > 0) {
            const note =
                INDENT + this.theme.fg("muted", `… ${hidden} ${tail ? "earlier" : "more"} lines`);

            return tail ? [note, ...rows] : [...rows, note];
        }

        return rows;
    }

    private limited(text: string, width: number, color: ThemeColor, limit: number): string[] {
        return this.indented(text, width, color, limit);
    }
}

interface BlockContext {
    run: Run;
    width: number;
    renderer: LuneThemeRenderer | undefined;
    results: ReadonlyMap<string, ToolResult>;
    /** The run is still working on this message's tool calls. */
    pending: boolean;
}

const STATUS_STYLE: Record<LuneActivityStatus, [ThemeColor, string]> = {
    running: ["warning", "◐"],
    done: ["success", "●"],
    failed: ["error", "✕"],
    cancelled: ["muted", "○"],
};

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

/** What decides a cached block: its tool results, running tools and whether the run still works on it. */
function blockSignature(message: AgentMessage, context: BlockContext): string {
    if (message.role !== "assistant") {
        return "";
    }

    return [
        context.pending ? "pending" : "settled",
        ...message.content.map((part) => {
            if (part.type !== "toolCall") {
                return "";
            }

            const result = context.results.get(part.id);
            const running = context.run.runningTools.get(part.id);

            if (result) {
                return `r${result.timestamp}`;
            }

            return running ? `p${partialText(running.partialResult).length}` : "-";
        }),
    ].join("|");
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
    const line = text.replace(/\s+/g, " ").trim();

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

function firstLine(text: string): string | undefined {
    return displayLines(text).find((line) => line.trim() !== "");
}
