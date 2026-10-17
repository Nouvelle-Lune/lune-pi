import {
    createBashToolDefinition,
    createEditToolDefinition,
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createPowerShellToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";
import { HoverState, installHoverTracking } from "../ui/hover.ts";
import { installLinkHover } from "../ui/link-hover.ts";
import { createOutputBrowser } from "../ui/output-panel.ts";
import { ExpansionState } from "../ui/expansion.ts";
import {
    createToolRenderers,
    NATIVE_RENDERERS,
    type LuneRenderers,
    type ToolCardControls,
} from "./cards.ts";
import { installTranscriptGroups, refreshToolRenderers, type TranscriptTui } from "./transcript.ts";
import { installThinking } from "./thinking.ts";
import { ActivityCard, ActivityInteraction } from "./activity-card.ts";
import { publishThemeRenderer } from "../protocol.ts";
import { animationInterval, ToolActivity } from "./tool/activity.ts";
import { THINKING_FRAME_MS, thinkingFrame } from "./thinking-animation.ts";
import {
    INSTRUMENTED_WRITE_RENDERER,
    type InstrumentedWriteRenderer,
    type WriteExecutionMetadataStore,
} from "./tool/diff/write-execution.ts";

/** Register one resolver for the extension lifetime; inactive sessions simply defer to Pi. */
/** Resolves Pi tool renderers and owns session-scoped transcript hooks, mouse tracking and animation clocks. */
export function createThemeRendererHost(
    pi: ExtensionAPI,
    metadata: WriteExecutionMetadataStore,
    // Pi's default binding; the extension passes the user's binding through `keyText`.
    expandKey: () => string = () => "ctrl+o",
) {
    let context: ExtensionContext | undefined;
    let controls: ToolCardControls | undefined;
    const hover = new HoverState();
    const cache = new WeakMap<ToolRenderers, Map<string, ToolRenderers>>();
    const unknownTools = new Map<string, ToolRenderers>();
    const nativeTools = new Map(
        [
            createBashToolDefinition,
            createEditToolDefinition,
            createFindToolDefinition,
            createGrepToolDefinition,
            createLsToolDefinition,
            createPowerShellToolDefinition,
            createReadToolDefinition,
            createWriteToolDefinition,
        ].map((create) => {
            const tool = create(process.cwd());
            return [tool.name, tool] as const;
        }),
    );
    const resolve = (name: string, next: ToolRenderers | undefined): ToolRenderers | undefined => {
        if (!context || config.mode === "off" || config.excludeRenderers.includes(name))
            return next;
        const wrapped = next as LuneRenderers | undefined;
        if (wrapped && NATIVE_RENDERERS in wrapped) return wrapped;
        // Native edit also frames itself; only external self-framed interactions must bypass Lune.
        const native = nativeTools.get(name);
        const nativeCall = !!native?.renderCall && next?.renderCall === native.renderCall;
        const nativeResult =
            next?.renderResult === native?.renderResult ||
            (name === "write" &&
                (next?.renderResult as InstrumentedWriteRenderer | undefined)?.[
                    INSTRUMENTED_WRITE_RENDERER
                ]);
        if (next?.renderShell === "self" && !(nativeCall && nativeResult)) return next;
        let byName = next ? cache.get(next) : unknownTools;
        if (!byName) {
            byName = new Map();
            if (next) cache.set(next, byName);
        }
        let renderers = byName.get(name);
        if (!renderers) {
            renderers = createToolRenderers(name, next, metadata, hover, () => controls);
            byName.set(name, renderers);
        }
        return renderers;
    };
    if (typeof pi.registerToolRenderer === "function")
        pi.registerToolRenderer((name, next) => resolve(name, next()));
    return {
        mount(current: ExtensionContext) {
            context = current;
            let tui: TranscriptTui | undefined;
            let disposed = false;
            let mouseTracking = false;
            let stopHoverTracking = () => {};
            const outputBrowser = createOutputBrowser(current);
            let timer: ReturnType<typeof setInterval> | undefined;
            let timerInterval = 0;
            let lastThinkingFrame = -1;
            const executing = new Set<string>();
            const activity = new ToolActivity();
            const expansion = new ExpansionState();
            const interaction = new ActivityInteraction(hover, expansion, outputBrowser.open);
            const releaseThemeRenderer = publishThemeRenderer({
                version: 1,
                renderActivity: (activity, options, theme) =>
                    new ActivityCard(
                        activity,
                        options.expanded,
                        theme,
                        expandKey,
                        options.key && { key: options.key, interaction },
                    ),
            });
            const subscriptions: (() => void)[] = [];
            const widgetKey = "pi-core-theme-runtime";
            const repaint = () => {
                if (!disposed) tui?.requestRender();
            };
            const groups = installTranscriptGroups(current, () => tui, hover, expansion);
            const thinking = installThinking(current, () => tui, hover, expansion);
            controls = {
                activity,
                toggleTool: groups.toggleTool,
                openOutput: outputBrowser.open,
                isGrouped: groups.isGrouped,
            };
            let rendererPolicy = `${config.mode}\0${config.excludeRenderers.join("\0")}`;
            const syncMouse = () => {
                if (tui?.mode !== "fullscreen") return;
                const enabled = config.fullscreenMouse;
                if (enabled === mouseTracking) return;
                tui.terminal.write(enabled ? "\x1b[?1003h\x1b[?1006h" : "\x1b[?1003l\x1b[?1002h");
                mouseTracking = enabled;
                hover.clear();
            };
            const syncAnimation = (repaintNow = false) => {
                const interval = disposed
                    ? 0
                    : thinking.active
                      ? THINKING_FRAME_MS
                      : executing.size
                        ? animationInterval()
                        : 0;
                const changed = timerInterval !== interval;
                if (changed) {
                    if (timer) clearInterval(timer);
                    timer = undefined;
                    timerInterval = interval;
                    lastThinkingFrame = -1;
                    if (interval) {
                        timer = setInterval(() => {
                            if (!thinking.active) return repaint();
                            const frame = thinkingFrame();
                            if (lastThinkingFrame === frame) return;
                            lastThinkingFrame = frame;
                            repaint();
                        }, interval);
                        timer.unref();
                    }
                }
                if (repaintNow || changed) repaint();
            };
            const refresh = () => {
                if (disposed) return;
                refreshToolRenderers(tui, resolve, true);
                groups.refresh();
                thinking.refresh();
                repaint();
            };
            // The empty widget only acquires Pi's lazy TUI; native jump-to-latest owns navigation.
            current.ui.setWidget(widgetKey, (host) => {
                const next = host as unknown as TranscriptTui;
                if (tui !== next) {
                    stopHoverTracking();
                    tui = next;
                    const stopHover = installHoverTracking(host, hover, repaint);
                    const stopLinkHover = installLinkHover(host, repaint);
                    stopHoverTracking = () => {
                        stopLinkHover();
                        stopHover();
                    };
                }
                syncMouse();
                return {
                    render: () => [],
                    invalidate() {
                        hover.clear();
                    },
                };
            });
            if (typeof current.ui.onTerminalInput === "function")
                subscriptions.push(
                    current.ui.onTerminalInput((data) => {
                        if (/\x1b\[<35;\d+;\d+M/.test(data)) hover.beginMove(repaint);
                        return undefined;
                    }),
                );
            subscriptions.push(
                pi.on("message_update", (event) => {
                    if (event.message.role !== "assistant") return;
                    const update = event.assistantMessageEvent;
                    if (
                        update.type === "thinking_start" ||
                        update.type === "thinking_delta" ||
                        update.type === "thinking_end"
                    )
                        thinking.start(event.message, update.contentIndex);
                    else if (update.type === "text_start" || update.type === "toolcall_start")
                        thinking.finish(event.message);
                    syncAnimation();
                }),
            );
            subscriptions.push(
                pi.on("message_end", (event) => {
                    if (event.message.role !== "assistant") return;
                    thinking.finish(event.message);
                    syncAnimation();
                }),
            );
            subscriptions.push(
                pi.on("tool_execution_start", (event) => {
                    thinking.finish();
                    activity.start(event);
                    if (event.parentToolCallId) groups.invalidateTool(event.parentToolCallId);
                    executing.add(event.toolCallId);
                    syncAnimation(!!event.parentToolCallId);
                }),
            );
            subscriptions.push(
                pi.on("tool_execution_update", (event) => {
                    activity.update(event);
                    if (event.parentToolCallId) groups.invalidateTool(event.parentToolCallId);
                    syncAnimation(!!event.parentToolCallId);
                }),
            );
            subscriptions.push(
                pi.on("tool_result", (event) => {
                    if (event.toolName === "codemode") return;
                    const diffs = activity.diffRecords(event.toolCallId);
                    if (
                        !diffs.length ||
                        (event.details !== undefined &&
                            (event.details === null ||
                                typeof event.details !== "object" ||
                                Array.isArray(event.details)))
                    )
                        return;
                    return { details: { ...event.details, luneThemeNestedDiffs: diffs } };
                }),
            );
            subscriptions.push(
                pi.on("tool_execution_end", (event) => {
                    activity.end(event);
                    if (event.parentToolCallId) groups.invalidateTool(event.parentToolCallId);
                    executing.delete(event.toolCallId);
                    syncAnimation(!!event.parentToolCallId);
                }),
            );
            subscriptions.push(
                pi.on("agent_end", () => {
                    thinking.finish();
                    activity.finish();
                    executing.clear();
                    syncAnimation();
                }),
            );
            subscriptions.push(pi.on("session_tree", refresh));
            subscriptions.push(pi.on("session_compact", refresh));
            const replay = setTimeout(refresh, 0);
            replay.unref();
            return {
                update() {
                    syncMouse();
                    syncAnimation();
                    const nextPolicy = `${config.mode}\0${config.excludeRenderers.join("\0")}`;
                    if (nextPolicy !== rendererPolicy) {
                        rendererPolicy = nextPolicy;
                        refresh();
                    } else repaint();
                },
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    clearTimeout(replay);
                    if (timer) clearInterval(timer);
                    stopHoverTracking();
                    releaseThemeRenderer();
                    outputBrowser.dispose();
                    for (const unsubscribe of subscriptions.splice(0).reverse()) unsubscribe();
                    expansion.collapse();
                    thinking.dispose();
                    groups.dispose();
                    context = undefined;
                    controls = undefined;
                    activity.clear();
                    hover.clear();
                    refreshToolRenderers(tui, resolve, false);
                    if (tui?.mode === "fullscreen" && mouseTracking)
                        tui.terminal.write("\x1b[?1003l\x1b[?1002h");
                    current.ui.setWidget(widgetKey, undefined);
                    tui?.requestRender();
                },
            };
        },
    };
}
