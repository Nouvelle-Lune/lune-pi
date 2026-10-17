import { highlightCode, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { config, configRevision, getToolDisplayConfig } from "../config/config.ts";
import { Disclosure } from "../ui/disclosure.ts";
import { CallList } from "../ui/call-list.ts";
import type { HoverState } from "../ui/hover.ts";
import type { OutputContent } from "../ui/output-panel.ts";
import { fullOutputPath, fullResultText, resultText, outputPreview } from "./tool/output.ts";
import {
    diffHiddenRow,
    fullToolOutput,
    renderRichToolResult,
    richDiffSummary,
    type WriteExecutionMetadataStore,
} from "./tool/diff/index.ts";
import { toolHref, toolSummary, singleLine } from "./tool/summary.ts";
import { renderToolLine } from "./tool/presentation.ts";
import {
    animationFrame,
    callStatus,
    nestedCalls,
    nestedHref,
    nestedSummary,
    type CallStatus,
    type NestedCall,
    type ToolActivity,
} from "./tool/activity.ts";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { branch, SEPARATOR, SHOW_MORE, sectionLabel } from "../ui/style.ts";

export const NATIVE_RENDERERS = Symbol.for("pi.lune.core.theme.native-renderers");
export type LuneRenderers = ToolRenderers & { [NATIVE_RENDERERS]: ToolRenderers | undefined };
type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type NativeContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type RenderContext = Omit<NativeContext, "state" | "args"> & {
    state: Record<string, unknown>;
    args: Record<string, unknown>;
    durationMs?: number;
};
export interface ToolCardControls {
    activity: ToolActivity;
    toggleTool(id: string, expanded: boolean): void;
    openOutput(title: string, content: OutputContent): void;
    isGrouped(id: string): boolean;
}
type CardState = {
    startedAt?: number;
    finishedAt?: number;
    result?: ToolResult;
    source?: string;
    output?: string;
    outputLines?: number;
    revision: number;
};
function state(context: RenderContext): CardState {
    const current = (context.state.luneCard ??= { revision: 0 }) as CardState;
    if (context.executionStarted && current.startedAt === undefined) current.startedAt = Date.now();
    if (!context.isPartial && current.startedAt !== undefined && current.finishedAt === undefined)
        current.finishedAt = Date.now();
    return current;
}
function durationMs(context: RenderContext): number | undefined {
    const current = state(context);
    return (
        context.durationMs ??
        (current.startedAt === undefined
            ? undefined
            : (current.finishedAt ?? Date.now()) - current.startedAt)
    );
}
export function framedRow(theme: Theme, content: string, width: number, hovered = false): string {
    if (width < 4) return truncateToWidth(content, width, "");
    const inner = width - 3;
    const body = truncateToWidth(content, inner, "…");
    const line = `${theme.fg(hovered ? "accent" : "borderMuted", "│")} ${body}${" ".repeat(Math.max(0, inner - visibleWidth(body)))} `;
    const background = hovered ? "selectedBg" : config.expandedCardBackground;
    // Truncation resets SGR; nested diff colors also release their own background.
    const painted = line.replace(
        /\x1b\[(?:0|49)?m/g,
        (reset) => reset + theme.getBgAnsi(background),
    );
    return theme.bg(background, painted);
}
// Nested previews start under the call name, past the tree branch and status mark.
const NESTED_INDENT = "    ";
export const HIDDEN_OUTPUT = "… more output · click to view full output";
const HIDDEN_DIFF = "… more diff · click to view full output";
const sameKeys = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left?.length === right.length && left.every((value, index) => value === right[index]);
const MAX_CARD_TEXT_CHARACTERS = 64_000;
// Wrapping hidden megabytes before applying a line limit blocks the interactive thread.
const previewCharacters = (width: number, lines: number) =>
    Math.min(MAX_CARD_TEXT_CHARACTERS, Math.max(1024, Math.max(1, width) * lines * 4));
function diffInputs(args: Record<string, unknown>, details: unknown): unknown[] {
    const payload =
        details && typeof details === "object"
            ? (details as {
                  diff?: string;
                  luneThemeWrite?: {
                      previousContent?: string;
                      fileExistedBeforeWrite?: boolean;
                      diffUnavailableReason?: string;
                  };
              })
            : undefined;
    return [
        args.path,
        args.file_path,
        args.content,
        payload?.diff,
        payload?.luneThemeWrite?.previousContent,
        payload?.luneThemeWrite?.fileExistedBeforeWrite,
        payload?.luneThemeWrite?.diffUnavailableReason,
    ];
}

/** Arguments read as an aligned key/value list; structured values stay compact JSON. */
function argumentRows(
    theme: Theme,
    args: Record<string, unknown>,
    width: number,
    budget: number,
): string[] {
    const entries = Object.entries(args).filter(([, value]) => value !== undefined);
    if (!entries.length) return [];
    const keyWidth = Math.min(12, Math.max(...entries.map(([name]) => visibleWidth(name))));
    const valueWidth = Math.max(1, width - keyWidth - 2);
    const rows: string[] = [];
    for (const [name, value] of entries) {
        const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
        const wrapped = wrapTextWithAnsi(sanitizeToolResultText(raw, budget), valueWidth);
        const label = truncateToWidth(name, keyWidth, "…");
        wrapped.forEach((line, index) =>
            rows.push(
                `${index ? " ".repeat(keyWidth) : theme.fg("dim", label + " ".repeat(keyWidth - visibleWidth(label)))}  ${theme.fg("muted", line)}`,
            ),
        );
    }
    return rows;
}

/** Native tool headings, argument previews and result bodies share state across Pi's separate call/result slots. */
class ToolCard implements Component {
    private readonly slot: "call" | "result";
    private readonly name: string;
    private readonly metadata: WriteExecutionMetadataStore;
    private readonly hover: HoverState;
    private readonly controls: () => ToolCardControls | undefined;
    private theme: Theme;
    private context: RenderContext;
    private result?: ToolResult;
    private readonly disclosure = new Disclosure();
    private readonly callList = new CallList();
    private readonly hiddenActions = new Map<string, { title: string; content: OutputContent }>();
    private readonly hiddenRows = new Map<number, { title: string; content: OutputContent }>();
    private get composite() {
        return (
            this.name === "codemode" ||
            Array.isArray(this.context.args.tool_uses) ||
            this.calls().length > 0
        );
    }
    private body: Component | undefined;
    private bodyKey: unknown[] | undefined;
    private rendered: { key: unknown[]; lines: string[] } | undefined;
    private callsCache: { key: unknown[]; calls: NestedCall[] } | undefined;
    private readonly nestedDiffs = new Map<string, { key: unknown[]; body?: Component }>();
    private inputCache: { key: unknown[]; lines: string[] } | undefined;
    private get hovered() {
        return this.hover.has(this);
    }

    constructor(
        slot: "call" | "result",
        name: string,
        metadata: WriteExecutionMetadataStore,
        hover: HoverState,
        controls: () => ToolCardControls | undefined,
        theme: Theme,
        context: RenderContext,
    ) {
        this.slot = slot;
        this.name = name;
        this.metadata = metadata;
        this.hover = hover;
        this.controls = controls;
        this.theme = theme;
        this.context = context;
    }
    update(theme: Theme, context: RenderContext, result?: ToolResult) {
        this.theme = theme;
        this.context = context;
        this.result = result;
        this.rendered = undefined;
        this.callsCache = undefined;
        this.inputCache = undefined;
        const current = state(context);
        current.revision++;
        if (!result) return;
        current.result = result;
        const text = resultText(result);
        if (current.source === text) return;
        current.source = text;
        const output =
            this.name === "codemode"
                ? text.replace(
                      /^Script (?:completed|failed)\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n/,
                      "",
                  )
                : text;
        current.output = sanitizeToolResultText(output);
        current.outputLines = current.output.trim()
            ? current.output.trimEnd().split("\n").length
            : 0;
    }
    invalidate() {
        this.rendered = undefined;
        this.inputCache = undefined;
        this.body?.invalidate();
        for (const diff of this.nestedDiffs.values()) diff.body?.invalidate();
        state(this.context).revision++;
    }
    private calls() {
        const context = this.context;
        const activity = this.controls()?.activity;
        const details = state(context).result?.details;
        const key = [
            context.args,
            details,
            activity?.version(context.toolCallId),
            context.isPartial,
            context.isError,
        ];
        if (sameKeys(this.callsCache?.key, key)) return this.callsCache!.calls;
        const calls = nestedCalls(
            context.args,
            details,
            activity?.children(context.toolCallId) ?? [],
            context.isPartial,
            context.isError,
        );
        this.callsCache = { key, calls };
        return calls;
    }
    /** The parent call tree owns nested status rows; codemode intentionally keeps file changes as summaries. */
    private callRows(width: number, open: boolean, offset = 0): string[] {
        const calls = this.calls();
        const live = this.controls()?.activity.children(this.context.toolCallId) ?? [];
        const current = live.findLast((call) => call.status === "running") ?? live.at(-1);
        const focus = Array.isArray(this.context.args.tool_uses)
            ? current
                ? calls.findIndex((call) => call.id === current.id)
                : -1
            : calls.length - 1;
        const start = this.callList.previewStart(calls.length, open, this.context.isPartial, focus);
        const shown = calls.slice(start, start + this.callList.previewCount(calls.length, open));
        const lines: string[] = [];
        for (const [index, call] of shown.entries()) {
            lines.push(
                truncateToWidth(
                    renderToolLine(
                        this.theme,
                        width,
                        {
                            name: call.name,
                            summary: nestedSummary(call, this.context.cwd),
                            href: nestedHref(call, this.context.cwd),
                            status: call.status,
                            durationMs: call.durationMs,
                            detail: this.callDetail(call, open),
                        },
                        `${branch(this.theme, index === shown.length - 1)} `,
                    ),
                    width,
                    "…",
                ),
            );
            const name = call.rendererName ?? call.name;
            if (open && call.result && name !== "edit" && name !== "write") {
                const preview = outputPreview(
                    resultText(call.result),
                    Math.max(1, width - NESTED_INDENT.length),
                    config.previewLines,
                    call.status === "running",
                    this.context.cwd,
                );
                lines.push(
                    ...preview.lines.map(
                        (row) =>
                            `${NESTED_INDENT}${this.theme.fg(call.status === "failed" ? "error" : "toolOutput", row)}`,
                    ),
                );
                if (preview.hidden || fullOutputPath(call.result))
                    lines.push(
                        NESTED_INDENT +
                            this.hiddenLine(
                                `output:${call.id ?? start + index}`,
                                Math.max(1, width - NESTED_INDENT.length),
                                offset + lines.length,
                                HIDDEN_OUTPUT,
                                () => fullResultText(call.result!),
                            ),
                    );
            }
            // Codemode is a call ledger; file diffs belong to standalone file-tool cards.
            if (
                this.name === "codemode" ||
                !open ||
                !call.result ||
                !call.args ||
                typeof call.args !== "object"
            )
                continue;
            const id = call.id ?? `${start + index}:${call.name}`;
            const key = [
                call.args,
                call.result.content,
                call.result.details,
                ...diffInputs(call.args as Record<string, unknown>, call.result.details),
                call.status,
                open,
                this.theme.colors,
                configRevision(),
            ];
            let diff = this.nestedDiffs.get(id);
            if (!sameKeys(diff?.key, key)) {
                const body = renderRichToolResult(
                    call.rendererName ?? call.name,
                    call.result,
                    {
                        expanded: open,
                        isPartial: call.status === "running",
                        isError: call.status === "failed" || call.status === "cancelled",
                    },
                    this.theme,
                    {
                        ...this.context,
                        toolCallId: id,
                        args: call.args as Record<string, unknown>,
                        expanded: open,
                        isError: call.status === "failed",
                    },
                    this.metadata,
                    getToolDisplayConfig,
                );
                diff = { key, body };
                this.nestedDiffs.set(id, diff);
            }
            if (diff?.body) {
                const body = [...diff.body.render(Math.max(1, width - NESTED_INDENT.length))];
                const hidden = diffHiddenRow(diff.body, body);
                if (hidden >= 0)
                    body[hidden] = this.hiddenLine(
                        `diff:${id}`,
                        Math.max(1, width - NESTED_INDENT.length),
                        offset + lines.length + hidden,
                        HIDDEN_DIFF,
                        () =>
                            fullToolOutput(
                                call.rendererName ?? call.name,
                                call.args as Record<string, unknown>,
                                call.result!,
                                this.metadata,
                                id,
                            ),
                    );
                lines.push(
                    ...body.map((row) => truncateToWidth(`${NESTED_INDENT}${row}`, width, "")),
                );
            }
        }
        return lines;
    }
    private input(width: number): string[] {
        const key = [width, this.context.args, this.theme.colors, configRevision()];
        if (sameKeys(this.inputCache?.key, key)) return this.inputCache!.lines;
        const script =
            this.name === "codemode" && typeof this.context.args.code === "string"
                ? this.context.args.code
                : undefined;
        const inner = Math.max(1, width - 3);
        const budget = previewCharacters(width, config.expandedInputMaxLines);
        const lines =
            script === undefined
                ? argumentRows(this.theme, this.context.args, inner, budget)
                : wrapTextWithAnsi(
                      highlightCode(sanitizeToolResultText(script, budget), "javascript").join(
                          "\n",
                      ),
                      inner,
                  );
        if (!lines.length) {
            this.inputCache = { key, lines: [] };
            return [];
        }
        const rows = [
            sectionLabel(this.theme, script === undefined ? "input" : "script"),
            ...lines.slice(0, config.expandedInputMaxLines),
        ];
        if (
            lines.length > config.expandedInputMaxLines ||
            (script !== undefined && script.length > budget)
        )
            rows.push(this.theme.fg("dim", "… more input"));
        this.inputCache = { key, lines: rows.map((line) => framedRow(this.theme, line, width)) };
        return this.inputCache.lines;
    }
    render(width: number): string[] {
        const theme = this.theme;
        const context = this.context;
        const current = state(context);
        const open = context.expanded;
        const grouped = this.controls()?.isGrouped(context.toolCallId) ?? false;
        const key = [
            width,
            theme.colors,
            configRevision(),
            open,
            grouped,
            this.hovered,
            [...this.hiddenActions.values()].find((target) => this.hover.has(target)),
            current.revision,
            !!current.result,
            this.controls()?.activity.version(context.toolCallId),
            context.isPartial ? animationFrame() : undefined,
        ];
        if (sameKeys(this.rendered?.key, key)) return this.rendered!.lines;
        this.disclosure.reset();
        this.callList.reset();
        this.hiddenRows.clear();
        const lines = this.renderLines(width, open, grouped);
        this.rendered = { key, lines };
        return lines;
    }
    /** Groups own disclosure; standalone slots render their input, compact output or expanded rich diff. */
    private renderLines(width: number, open: boolean, grouped: boolean): string[] {
        const theme = this.theme;
        const context = this.context;
        if (this.slot === "call") {
            const status = callStatus(context.isPartial, context.isError);
            const lines = [this.heading(width, open, grouped, status)];
            // Collapsed codemode has no script preview: its first nested call would replace the
            // streamed code, so the card would flash code and then jump to a call tree.
            if (open) lines.push(...this.input(width));
            if (!state(context).result) {
                lines.push(
                    ...this.callRows(Math.max(1, width - 3), open, lines.length).map((row) =>
                        open
                            ? framedRow(theme, row, width)
                            : truncateToWidth(`   ${row}`, width, ""),
                    ),
                );
                if (!grouped) this.addControls(lines, width, open);
            }
            return lines;
        }
        if (!this.result) return [];
        const calls = this.callRows(Math.max(1, width - 3), open);
        const bodyKey = [
            context.args,
            this.result.content,
            this.result.details,
            ...diffInputs(context.args, this.result.details),
            open,
            context.isPartial,
            context.isError,
            theme.colors,
            configRevision(),
        ];
        if (!sameKeys(this.bodyKey, bodyKey)) {
            this.body = renderRichToolResult(
                this.name,
                this.result,
                { expanded: open, isPartial: context.isPartial },
                theme,
                context,
                this.metadata,
                getToolDisplayConfig,
            );
            this.bodyKey = bodyKey;
        }
        const rich = this.body;
        const current = state(context);
        const output = current.output ?? "";
        if (!open) {
            const rows = calls.map((row) => truncateToWidth(`   ${row}`, width, ""));
            if (rich)
                rows.push(
                    ...rich
                        .render(Math.max(1, width - 3))
                        .map((row) => truncateToWidth(`   ${row}`, width, "")),
                );
            else if (context.isPartial && output.trim()) {
                const preview = outputPreview(
                    output,
                    Math.max(1, width - 3),
                    config.previewLines,
                    true,
                    context.cwd,
                );
                rows.push(
                    ...preview.lines.map((row) =>
                        truncateToWidth(`   ${theme.fg("toolOutput", row)}`, width, ""),
                    ),
                );
            }
            if (!rich && !this.composite && context.isError && output.trim())
                rows.push(
                    truncateToWidth(
                        `   ${theme.fg("error", singleLine(output.slice(0, 512)))}`,
                        width,
                        "…",
                    ),
                );
            if (!grouped) this.addControls(rows, width, false);
            return rows;
        }
        const lines = [...calls];
        if (rich || output.trim()) lines.push("", sectionLabel(theme, rich ? "diff" : "output"));
        if (rich) {
            // The diff owns its cached array; attach the browsing action to a copy.
            const body = [...rich.render(Math.max(1, width - 3))];
            const hidden = diffHiddenRow(rich, body);
            if (hidden >= 0)
                body[hidden] = this.hiddenLine(
                    "diff",
                    Math.max(1, width - 3),
                    lines.length + hidden,
                    HIDDEN_DIFF,
                    () =>
                        fullToolOutput(
                            this.name,
                            context.args,
                            this.result!,
                            this.metadata,
                            context.toolCallId,
                        ),
                );
            lines.push(...body);
        } else {
            const preview = outputPreview(
                output,
                Math.max(1, width - 3),
                config.expandedOutputMaxLines,
                context.isPartial,
                context.cwd,
            );
            lines.push(
                ...preview.lines.map((row) =>
                    theme.fg(context.isError ? "error" : "toolOutput", row),
                ),
            );
            if (preview.hidden || fullOutputPath(this.result!))
                lines.push(
                    this.hiddenLine(
                        "output",
                        Math.max(1, width - 3),
                        lines.length,
                        HIDDEN_OUTPUT,
                        () => fullResultText(this.result!),
                    ),
                );
        }
        const rows = lines.map((line) => framedRow(theme, line, width));
        if (!grouped) this.addControls(rows, width, true);
        return rows;
    }
    private hiddenLine(
        key: string,
        width: number,
        row: number,
        text: string,
        content: OutputContent,
    ): string {
        let target = this.hiddenActions.get(key);
        if (!target) {
            target = { title: `${this.name} · full output`, content };
            this.hiddenActions.set(key, target);
        }
        target.content = content;
        this.hiddenRows.set(row, target);
        return this.theme.fg(
            this.hover.has(target) ? "accent" : "dim",
            truncateToWidth(text, width),
        );
    }
    /** Standalone hints live on the heading; only call lists add a trailing overflow row. */
    private addControls(lines: string[], width: number, open: boolean) {
        if (open || !this.composite) return;
        lines.push(
            ...this.callList.renderOverflow(
                this.theme,
                width,
                lines.length,
                this.calls().length,
                open,
                this.hovered,
                "   ",
            ),
        );
    }
    private heading(width: number, open: boolean, grouped: boolean, status: CallStatus): string {
        const theme = this.theme;
        const context = this.context;
        const inner = Math.max(1, width - 3);
        if (this.composite) {
            // Only nested calls count; the parent's own status still sets the heading mark.
            const statuses = this.calls().map((call) => call.status);
            return open
                ? framedRow(
                      theme,
                      this.callList.renderHeader(
                          theme,
                          inner,
                          this.name,
                          statuses,
                          true,
                          false,
                          "",
                          status,
                      ),
                      width,
                  )
                : this.callList.renderHeader(
                      theme,
                      width,
                      this.name,
                      statuses,
                      false,
                      this.hovered,
                      " ",
                      status,
                  );
        }
        const hint = open || grouped ? "" : SHOW_MORE;
        const reserve = hint ? visibleWidth(SEPARATOR) + visibleWidth(hint) : 0;
        const line = renderToolLine(theme, (open ? inner : width - 1) - reserve, {
            name: this.name,
            summary: toolSummary(this.name, context.args, context.cwd),
            href: toolHref(this.name, context.args, context.cwd),
            status,
            durationMs: durationMs(context),
            detail: this.detail(status),
        });
        if (open) return framedRow(theme, line, width);
        if (!hint) return truncateToWidth(` ${line}`, width, "");
        return this.disclosure.render(theme, width, 0, this.hovered, ` ${line}`);
    }
    private callDetail(call: NestedCall, open: boolean): string | undefined {
        if (open && call.error) return singleLine(call.error);
        if (call.status !== "done" || !call.result || !call.args || typeof call.args !== "object")
            return undefined;
        return (
            richDiffSummary(
                this.theme,
                call.rendererName ?? call.name,
                call.args as Record<string, unknown>,
                call.result.details,
            ) || undefined
        );
    }
    /** Settled results summarize on the heading so collapsed cards stay one row. */
    private detail(status: CallStatus): string | undefined {
        const current = state(this.context);
        if (status !== "done" || !current.result) return undefined;
        const diff = richDiffSummary(
            this.theme,
            this.name,
            this.context.args,
            current.result.details,
        );
        if (diff) return diff;
        const count = current.outputLines ?? 0;
        return count ? `${count} ${count === 1 ? "line" : "lines"}` : undefined;
    }
    handleMouse(event: TuiMouseEvent) {
        const hidden = this.hiddenRows.get(event.y);
        const hint = this.composite
            ? this.callList.contains(event)
            : this.disclosure.contains(event);
        if (event.type === "move") {
            if (!config.fullscreenMouse) return undefined;
            let changed: boolean;
            if (hidden) changed = this.hover.focus(hidden);
            else if (hint) changed = this.hover.focus(this);
            else {
                changed = this.hover.blur(this);
                for (const target of this.hiddenActions.values())
                    changed = this.hover.blur(target) || changed;
            }
            return { handled: true, render: changed };
        }
        if (event.type !== "click" || event.button !== "left") return undefined;
        if (!config.fullscreenMouse) return { handled: true, render: false };
        if (hidden) {
            this.hover.clear();
            this.controls()?.openOutput(hidden.title, hidden.content);
            return { handled: true, render: true };
        }
        // Consume inactive clicks so Pi's enclosing MouseRegion cannot expand a collapsed card.
        if (this.context.expanded || hint) {
            this.hover.clear();
            this.controls()?.toggleTool(this.context.toolCallId, !this.context.expanded);
            return { handled: true, render: true };
        }
        return { handled: true, render: false };
    }
}

export function createToolRenderers(
    name: string,
    native: ToolRenderers | undefined,
    metadata: WriteExecutionMetadataStore,
    hover: HoverState,
    controls: () => ToolCardControls | undefined,
): LuneRenderers {
    const contextFor = (context: NativeContext): RenderContext =>
        ({
            ...context,
            args:
                context.args && typeof context.args === "object"
                    ? (context.args as Record<string, unknown>)
                    : {},
        }) as RenderContext;
    return {
        [NATIVE_RENDERERS]: native,
        renderShell: "self",
        renderCall(_args, theme, nativeContext) {
            const context = contextFor(nativeContext);
            const card =
                context.lastComponent instanceof ToolCard
                    ? context.lastComponent
                    : new ToolCard("call", name, metadata, hover, controls, theme, context);
            card.update(theme, context);
            return card;
        },
        renderResult(result, _options, theme, nativeContext) {
            const context = contextFor(nativeContext);
            const card =
                context.lastComponent instanceof ToolCard
                    ? context.lastComponent
                    : new ToolCard("result", name, metadata, hover, controls, theme, context);
            card.update(theme, context, result);
            return card;
        },
    };
}
