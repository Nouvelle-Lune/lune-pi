import { AssistantMessageComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    Spacer,
    truncateToWidth,
    wrapTextWithAnsi,
    type Component,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { config, configRevision } from "../config/config.ts";
import { Disclosure } from "../ui/disclosure.ts";
import type { ExpansionState } from "../ui/expansion.ts";
import type { HoverState } from "../ui/hover.ts";
import { ThinkingAnimation, thinkingFrame } from "./thinking-animation.ts";
import { framedRow } from "./cards.ts";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { SEPARATOR } from "../ui/style.ts";
import { walkTranscript, type TranscriptTui } from "./transcript.ts";
import { thinkingRun, type ThinkingRun } from "./thinking-content.ts";

interface AssistantInternals extends Component {
    lastMessage?: AssistantMessage;
    isStreaming: boolean;
    hideThinkingBlock: boolean;
    hasToolCalls: boolean;
    outputPad: number;
    markdownTheme: unknown;
    markdownTransformers: unknown;
    contentContainer: { children: Component[] };
    updateContent(message: AssistantMessage, streaming?: boolean): void;
}
const THINKING_MARK = "✻";
interface ThinkingState {
    expanded: boolean;
}

/** Thinking run assembly and plain-text preview, with Lune lifecycle and native prose. */
export function installThinking(
    context: ExtensionContext,
    getTui: () => TranscriptTui | undefined,
    hover: HoverState,
    expansion: ExpansionState,
) {
    const prototype = AssistantMessageComponent.prototype as unknown as AssistantInternals;
    const original = prototype.updateContent;
    const states = new Map<string, ThinkingState>();
    const hostVisibility = new WeakMap<AssistantInternals, boolean>();
    const durations = new Map<string, number>();
    const cards = new WeakMap<AssistantInternals, Map<number, ThinkingCard>>();
    const native = new WeakMap<
        AssistantInternals,
        { key: unknown[]; prose: Map<number, Component>; tail: Component[] }
    >();
    const versions = new WeakMap<AssistantMessage, number>();
    let version = 0;
    let active:
        | {
              timestamp: number;
              start: number;
              index: number;
              since: number;
              message: AssistantMessage;
              version: number;
          }
        | undefined;
    const assistants = new Map<number, WeakRef<AssistantInternals>>();
    let installed = true;
    const repaint = () => getTui()?.requestRender();
    const key = (timestamp: number, index: number) => `${timestamp}:${index}`;
    const equal = (previous: readonly unknown[] | undefined, next: readonly unknown[]) =>
        previous?.length === next.length && previous.every((value, index) => value === next[index]);

    class ThinkingCard implements Component {
        private text = "";
        private preview = "";
        private title?: string;
        private readonly disclosure = new Disclosure();
        private readonly animation = new ThinkingAnimation();
        private layout?: { key: unknown[]; lines: string[] };
        private rendered?: { key: unknown[]; lines: string[] };
        private bodyRevision = 0;
        private previewRevision = 0;
        readonly state: ThinkingState;
        readonly timestamp: number;
        readonly start: number;
        end: number;
        constructor(assistant: AssistantInternals, run: ThinkingRun) {
            this.timestamp = assistant.lastMessage!.timestamp;
            this.start = run.start;
            this.end = run.end;
            const id = key(this.timestamp, this.start);
            this.state = states.get(id) ?? { expanded: false };
            states.set(id, this.state);
            this.update(assistant, run);
        }
        update(assistant: AssistantInternals, run: ThinkingRun) {
            this.end = run.end;
            if (
                hostVisibility.has(assistant) &&
                hostVisibility.get(assistant) !== assistant.hideThinkingBlock
            )
                this.state.expanded = !assistant.hideThinkingBlock;
            this.title = run.title;
            if (run.text !== this.text) {
                this.text = run.text;
                this.bodyRevision++;
            }
            if (run.preview !== this.preview) {
                this.preview = run.preview;
                this.previewRevision++;
            }
        }
        invalidate() {
            this.rendered = undefined;
            this.layout = undefined;
        }
        private get running() {
            return (
                active?.timestamp === this.timestamp &&
                active.index >= this.start &&
                active.index <= this.end
            );
        }
        render(width: number) {
            const theme = context.ui.theme;
            const open = this.state.expanded;
            const hovered = hover.has(this.state);
            const inner = Math.max(1, width - 3);
            const running = this.running;
            const elapsedDone = durations.get(key(this.timestamp, this.start));
            const layoutKey = [
                width,
                open,
                hovered,
                theme.colors,
                configRevision(),
                open ? this.bodyRevision : this.previewRevision,
            ];
            const cacheKey = [
                ...layoutKey,
                this.title,
                running ? thinkingFrame() : undefined,
                elapsedDone,
            ];
            if (equal(this.rendered?.key, cacheKey)) return this.rendered!.lines;
            if (!equal(this.layout?.key, layoutKey)) {
                let source = open ? this.text : this.preview;
                if (!open) {
                    // Wrapping only a trailing window keeps incomplete Markdown from hiding streamed content.
                    const budget = Math.max(2000, inner * (config.previewLines + 2));
                    if (source.length > budget) {
                        const start = source.length - budget;
                        const newline = source.indexOf("\n", start);
                        source = source.slice(
                            newline < 0 || newline === source.length - 1 ? start : newline + 1,
                        );
                    }
                }
                const body = source
                    ? wrapTextWithAnsi(sanitizeToolResultText(source).replace(/\t/g, "   "), inner)
                    : [];
                const shown = open
                    ? body
                    : config.previewLines > 0
                      ? body.slice(-config.previewLines)
                      : [];
                const rows = shown.map((line) => {
                    const text = theme.italic(theme.fg("thinkingText", line));
                    return open
                        ? framedRow(theme, text, width)
                        : truncateToWidth(`   ${text}`, width, "");
                });
                this.layout = { key: layoutKey, lines: rows };
            }
            const elapsed = running ? Date.now() - active!.since : elapsedDone;
            const heading = running
                ? this.animation.render(theme, Date.now())
                : `${theme.fg("dim", THINKING_MARK)} ${theme.fg("thinkingText", "Thinking")}`;
            const row = [
                heading,
                this.title ? theme.fg("thinkingText", this.title) : "",
                elapsed ? theme.fg("dim", `${(elapsed / 1000).toFixed(1)}s`) : "",
            ]
                .filter(Boolean)
                .join(theme.fg("dim", SEPARATOR));
            this.disclosure.reset();
            const top = open
                ? framedRow(theme, row, width, hovered)
                : this.text.trim()
                  ? this.disclosure.render(theme, width, 0, hovered, ` ${row}`)
                  : truncateToWidth(` ${row}`, width, "");
            const lines = [top, ...this.layout!.lines];
            this.rendered = { key: cacheKey, lines };
            return lines;
        }
        handleMouse(event: TuiMouseEvent) {
            if (!config.fullscreenMouse) return undefined;
            const hint = this.disclosure.contains(event);
            if (event.type === "move")
                return {
                    handled: true,
                    render: hint ? hover.focus(this.state) : hover.blur(this.state),
                };
            if (
                event.type !== "click" ||
                event.button !== "left" ||
                (!this.state.expanded && !hint)
            )
                return undefined;
            hover.clear();
            expansion.set(this.state, !this.state.expanded, (expanded) => {
                this.state.expanded = expanded;
            });
            return { handled: true, render: true };
        }
    }

    const updateContent = function (
        this: AssistantInternals,
        message: AssistantMessage,
        streaming?: boolean,
    ) {
        if (!installed) return original.call(this, message, streaming);
        // Extension events precede Pi's component refresh; a late refresh must not rewind active reasoning.
        const receivedVersion = versions.get(message);
        if (
            streaming !== false &&
            active?.timestamp === message.timestamp &&
            receivedVersion !== undefined &&
            receivedVersion < active.version
        )
            message = active.message;
        const isStreaming = streaming ?? this.isStreaming;
        const hasToolCalls = message.content.some((block) => block.type === "toolCall");
        const nativeKey = [
            context.ui.theme.colors,
            isStreaming,
            this.hideThinkingBlock,
            this.outputPad,
            this.markdownTheme,
            this.markdownTransformers,
            message.stopReason,
            message.errorMessage,
            hasToolCalls,
            ...message.content.map((block) =>
                block.type === "text"
                    ? block.text.trim()
                    : block.type === "thinking"
                      ? !!block.thinking.trim()
                      : block.type,
            ),
        ];
        let skeleton = native.get(this);
        if (!equal(skeleton?.key, nativeKey)) {
            original.call(this, message, isStreaming);
            const nodes = this.contentContainer.children.filter(
                (component) => !(component instanceof Spacer),
            );
            const prose = new Map<number, Component>();
            let node = 0;
            for (let index = 0; index < message.content.length; index++) {
                const block = message.content[index]!;
                if (block.type === "text" && block.text.trim()) prose.set(index, nodes[node++]!);
                else if (block.type === "thinking") {
                    const run = thinkingRun(message, index);
                    if (run.text) node++;
                    index = run.end;
                }
            }
            skeleton = { key: nativeKey, prose, tail: nodes.slice(node) };
            native.set(this, skeleton);
        }
        this.isStreaming = isStreaming;
        this.lastMessage = message;
        this.hasToolCalls = hasToolCalls;
        assistants.set(message.timestamp, new WeakRef(this));
        const activeIndex = active?.timestamp === message.timestamp ? active.index : -1;
        const visible = message.content.some((block) =>
            block.type === "text"
                ? block.text.trim()
                : block.type === "thinking" && block.thinking.trim(),
        );
        const parts: Component[] =
            visible || message.content[activeIndex]?.type === "thinking" ? [new Spacer(1)] : [];
        let byStart = cards.get(this);
        if (!byStart) {
            byStart = new Map();
            cards.set(this, byStart);
        }
        for (let index = 0; index < message.content.length; index++) {
            const block = message.content[index]!;
            if (block.type === "text" && block.text.trim()) {
                parts.push(skeleton!.prose.get(index)!);
                continue;
            }
            if (block.type !== "thinking") continue;
            const run = thinkingRun(message, index, activeIndex);
            index = run.end;
            const running = activeIndex >= run.start && activeIndex <= run.end;
            if (!run.text && !running) continue;
            if (parts.length && !(parts.at(-1) instanceof Spacer)) parts.push(new Spacer(1));
            let card = byStart.get(run.start);
            if (card) card.update(this, run);
            else {
                card = new ThinkingCard(this, run);
                byStart.set(run.start, card);
            }
            parts.push(card);
            if (
                message.content
                    .slice(index + 1)
                    .some((item) =>
                        item.type === "text"
                            ? item.text.trim()
                            : item.type === "thinking" && item.thinking.trim(),
                    )
            )
                parts.push(new Spacer(1));
        }
        for (const component of skeleton!.tail) parts.push(new Spacer(1), component);
        this.contentContainer.children = parts;
        hostVisibility.set(this, this.hideThinkingBlock);
    };
    prototype.updateContent = updateContent;
    const refresh = (timestamp?: number) => {
        walkTranscript(getTui(), (component) => {
            if (!(component instanceof AssistantMessageComponent)) return;
            const assistant = component as unknown as AssistantInternals;
            if (
                assistant.lastMessage &&
                (timestamp === undefined || assistant.lastMessage.timestamp === timestamp)
            )
                assistant.updateContent(assistant.lastMessage);
        });
        repaint();
    };
    const finish = (message?: AssistantMessage) => {
        if (!active) return;
        const finished = active;
        active = undefined;
        const id = key(finished.timestamp, finished.start);
        durations.set(id, (durations.get(id) ?? 0) + Date.now() - finished.since);
        const assistant = assistants.get(finished.timestamp)?.deref();
        if (assistant)
            assistant.updateContent(
                message?.timestamp === finished.timestamp ? message : finished.message,
            );
        repaint();
    };
    return {
        get active() {
            return !!active;
        },
        start(message: AssistantMessage, index: number) {
            let start = index;
            while (start > 0 && message.content[start - 1]?.type === "thinking") start--;
            const receivedVersion = ++version;
            versions.set(message, receivedVersion);
            if (active?.timestamp !== message.timestamp || active.start !== start) {
                finish();
                active = {
                    timestamp: message.timestamp,
                    start,
                    index,
                    since: Date.now(),
                    message,
                    version: receivedVersion,
                };
            } else {
                active.index = index;
                active.message = message;
                active.version = receivedVersion;
            }
            const assistant = assistants.get(message.timestamp)?.deref();
            if (!assistant) return;
            const card = cards.get(assistant)?.get(start);
            if (!card) assistant.updateContent(message, true);
            else {
                assistant.lastMessage = message;
                card.update(assistant, thinkingRun(message, start, index));
            }
            repaint();
        },
        finish,
        refresh,
        dispose() {
            finish();
            installed = false;
            if (prototype.updateContent === updateContent) prototype.updateContent = original;
            refresh();
            states.clear();
            durations.clear();
            assistants.clear();
        },
    };
}
