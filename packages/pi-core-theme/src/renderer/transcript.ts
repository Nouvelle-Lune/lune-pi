import {
    ToolExecutionComponent,
    type ExtensionContext,
    type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    ScrollView,
    truncateToWidth,
    type Component,
    type TUI,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { config, configRevision } from "../config/config.ts";
import { NATIVE_RENDERERS, type LuneRenderers } from "./cards.ts";
import { CallList } from "../ui/call-list.ts";
import type { HoverState } from "../ui/hover.ts";
import type { ExpansionState } from "../ui/expansion.ts";
import { animationFrame, callStatus } from "./tool/activity.ts";
import { renderToolLine } from "./tool/presentation.ts";
import { toolHref, toolSummary } from "./tool/summary.ts";
import { richDiffSummary } from "./tool/diff/index.ts";
import { branch } from "../ui/style.ts";
import { stripTerminalSequencesPreservingLayout } from "../utils/ansi-text.ts";

// Expanded group children sit after three spaces and their tree branch.
const CHILD_INDENT = 4;

export interface TranscriptTui {
    readonly mode: TUI["mode"];
    readonly terminal: TUI["terminal"];
    requestRender(force?: boolean): void;
    children?: Component[];
    getMountedRoots?(): readonly Component[];
}
interface ToolInternals extends Component {
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    expanded: boolean;
    isPartial: boolean;
    executionStarted: boolean;
    result?: Parameters<NonNullable<ToolRenderers["renderResult"]>>[0] & {
        isError?: boolean;
        durationMs?: number;
    };
    toolDefinition?: ToolRenderers;
    rendererState: Record<string, unknown>;
    children: Component[];
    contentBox: Component;
    contentTextRegion: Component;
    selfRenderContainer: Component;
    callRendererComponent?: Component;
    resultRendererComponent?: Component;
    setExpanded(expanded: boolean): void;
    updateDisplay(): void;
}
const tool = (value: Component) => value as unknown as ToolInternals;
const isTool = (value: Component) => value instanceof ToolExecutionComponent;
const owned = (value: Component) =>
    isTool(value) &&
    !!tool(value).toolDefinition &&
    NATIVE_RENDERERS in tool(value).toolDefinition!;
const groupable = (value: Component) =>
    owned(value) &&
    tool(value).toolName !== "codemode" &&
    tool(value).toolName !== "multi_tool_use.parallel" &&
    !Array.isArray(tool(value).args.tool_uses);
const revision = (item: ToolInternals) =>
    (item.rendererState.luneCard as { revision?: number } | undefined)?.revision;

export function walkTranscript(
    root: TranscriptTui | Component | undefined,
    visit: (component: Component) => void,
) {
    const seen = new Set<object>();
    const walk = (value: TranscriptTui | Component) => {
        if (seen.has(value)) return;
        seen.add(value);
        if ("render" in value) visit(value);
        for (const child of ("children" in value ? value.children : undefined) ?? []) walk(child);
        if ("getMountedRoots" in value)
            for (const child of value.getMountedRoots?.() ?? []) walk(child);
    };
    if (root) walk(root);
}
function setRenderers(component: ToolInternals, renderers: ToolRenderers | undefined) {
    if (component.toolDefinition === renderers) return;
    const previous = component.toolDefinition as LuneRenderers | undefined;
    const leaving =
        previous && NATIVE_RENDERERS in previous && !(renderers && NATIVE_RENDERERS in renderers);
    if (leaving) {
        // Pi retains inactive shell variants and lastComponent, so dropping only the wrapper leaks its caches.
        if (component.selfRenderContainer instanceof Container)
            component.selfRenderContainer.clear();
        component.callRendererComponent = undefined;
        component.resultRendererComponent = undefined;
    }
    component.toolDefinition = renderers;
    const shell = renderers
        ? renderers.renderShell === "self"
            ? component.selfRenderContainer
            : component.contentBox
        : component.contentTextRegion;
    const index = component.children.findIndex(
        (child) =>
            child === component.contentBox ||
            child === component.selfRenderContainer ||
            child === component.contentTextRegion,
    );
    if (index >= 0) component.children[index] = shell;
    component.invalidate();
    if (leaving) delete component.rendererState.luneCard;
}
export function refreshToolRenderers(
    tui: TranscriptTui | undefined,
    resolve: (name: string, native: ToolRenderers | undefined) => ToolRenderers | undefined,
    enabled: boolean,
) {
    walkTranscript(tui, (component) => {
        if (!isTool(component)) return;
        const current = tool(component);
        const wrapped = current.toolDefinition as LuneRenderers | undefined;
        const native = wrapped && NATIVE_RENDERERS in wrapped ? wrapped[NATIVE_RENDERERS] : wrapped;
        setRenderers(current, enabled ? resolve(current.toolName, native) : native);
    });
}

/** Pi has no transcript-group API; this session-owned adapter restores every method it replaces. */
export function installTranscriptGroups(
    context: ExtensionContext,
    getTui: () => TranscriptTui | undefined,
    hover: HoverState,
    expansion: ExpansionState,
) {
    const groups = new Set<ToolGroup>();
    const indexed = new Map<string, ToolInternals>();
    const membership = new WeakMap<Component, ToolGroup>();
    const prototype = Container.prototype;
    const original = {
        addChild: prototype.addChild,
        removeChild: prototype.removeChild,
        clear: prototype.clear,
    };
    const previousGroups = new WeakMap<Component, ToolGroup>();
    let active = true;
    let rebuilding = false;
    const forget = (component: Component) => {
        if (component instanceof ToolGroup) {
            groups.delete(component);
            for (const child of component.children) forget(child);
        } else if (
            isTool(component) &&
            indexed.get(tool(component).toolCallId) === tool(component)
        ) {
            indexed.delete(tool(component).toolCallId);
            membership.delete(component);
        }
    };
    type Snapshot = {
        item: ToolInternals;
        args: unknown;
        result: ToolInternals["result"];
        expanded: boolean;
        partial: boolean;
        revision: number | undefined;
    };
    // These groups replace adjacent tool slots, leaving assistant prose and native navigation untouched.
    class ToolGroup extends Container {
        private expanded = false;
        private lastHostExpansion = false;
        private readonly callList = new CallList();
        private readonly childRows: {
            item: ToolInternals;
            row: number;
            height: number;
            width: number;
        }[] = [];
        private cached?: {
            width: number;
            colors: unknown;
            config: number;
            hover: boolean;
            hoverVersion: number;
            expanded: boolean;
            frame?: number;
            tools: Snapshot[];
            lines: string[];
        };
        private get hovered() {
            return hover.has(this);
        }
        addTool(component: Component) {
            original.addChild.call(this, component);
            membership.set(component, this);
            indexed.set(tool(component).toolCallId, tool(component));
            this.cached = undefined;
            if (this.expanded && !tool(component).expanded) tool(component).setExpanded(true);
        }
        setExpanded(expanded: boolean) {
            if (
                this.expanded === expanded &&
                this.children.every((child) => tool(child).expanded === expanded)
            )
                return;
            this.expanded = expanded;
            this.lastHostExpansion = expanded;
            this.cached = undefined;
            for (const child of this.children)
                if (tool(child).expanded !== expanded) tool(child).setExpanded(expanded);
        }
        toggle() {
            expansion.set(this, !this.expanded, (expanded) => this.setExpanded(expanded));
            getTui()?.requestRender();
        }
        changed() {
            this.cached = undefined;
        }
        /** A group formed around an open card starts open, or the new call would close the card. */
        inheritExpansion(items: readonly ToolInternals[]) {
            if (this.expanded || !items.some((item) => item.expanded)) return;
            this.expanded = true;
            this.lastHostExpansion = true;
            this.cached = undefined;
            for (const item of items)
                expansion.transfer(item, this, (expanded) => this.setExpanded(expanded));
        }
        override invalidate() {
            this.cached = undefined;
            super.invalidate();
        }
        override handleMouse(event: TuiMouseEvent) {
            const target = {
                component: this,
                originX: event.screenX - event.x,
                originY: event.screenY - event.y,
                width: event.width,
                height: event.height,
            };
            if (
                config.fullscreenMouse &&
                this.expanded &&
                (event.type === "click" || event.type === "move")
            ) {
                const child = this.childRows.find(
                    (entry) => event.y >= entry.row && event.y < entry.row + entry.height,
                );
                const handled = child?.item.handleMouse?.({
                    ...event,
                    x: event.x - CHILD_INDENT,
                    y: event.y - child.row,
                    width: child.width,
                    height: child.height,
                });
                if (handled?.handled) return { ...handled, handled: true as const, target };
            }
            const hint = this.callList.contains(event);
            if (config.fullscreenMouse) {
                if (event.type === "move")
                    return {
                        handled: true as const,
                        render: hint ? hover.focus(this) : hover.blur(this),
                        target,
                    };
                if (event.type === "click" && event.button === "left" && (this.expanded || hint)) {
                    hover.clear();
                    this.toggle();
                    return { handled: true as const, render: true, target };
                }
            }
            return event.type === "click" || event.type === "move"
                ? { handled: true as const, render: false, target }
                : undefined;
        }
        override render(width: number): string[] {
            const palette = context.ui.theme;
            const colors = palette.colors;
            const configVersion = configRevision();
            const hovered = this.hovered;
            const cached = this.cached;
            if (
                cached &&
                cached.width === width &&
                cached.colors === colors &&
                cached.config === configVersion &&
                cached.hover === hovered &&
                // Collapsed rows only show this group's hover; any other target would rebuild
                // every group in the transcript on each pointer move.
                (!this.expanded || cached.hoverVersion === hover.version) &&
                cached.expanded === this.expanded &&
                (cached.frame === undefined || cached.frame === animationFrame()) &&
                cached.tools.length === this.children.length &&
                cached.tools.every((snapshot, index) => {
                    const item = tool(this.children[index]!);
                    return (
                        snapshot.item === item &&
                        snapshot.args === item.args &&
                        snapshot.result === item.result &&
                        snapshot.expanded === item.expanded &&
                        snapshot.partial === item.isPartial &&
                        snapshot.revision === revision(item)
                    );
                })
            )
                return cached.lines;
            const tools = this.children.map(tool);
            const hostExpansion = tools.length > 0 && tools.every((item) => item.expanded);
            if (hostExpansion !== this.lastHostExpansion) {
                this.expanded = hostExpansion;
                this.lastHostExpansion = hostExpansion;
            }
            const statuses = tools.map((item) =>
                callStatus(!item.result || item.isPartial, !!item.result?.isError),
            );
            const pending = statuses.includes("running");
            const names = new Set(tools.map((item) => item.toolName));
            const label = names.size === 1 ? tools[0]!.toolName : "tools";
            this.callList.reset();
            this.childRows.length = 0;
            const lines = [
                this.callList.renderHeader(
                    palette,
                    width,
                    label,
                    statuses,
                    this.expanded,
                    hovered,
                    " ",
                ),
            ];
            const active = tools.findLastIndex(
                (item, index) => item.executionStarted && statuses[index] === "running",
            );
            const current =
                active >= 0 ? active : tools.findLastIndex((item) => item.executionStarted);
            const start = this.callList.previewStart(tools.length, this.expanded, pending, current);
            const shown = tools.slice(
                start,
                start + this.callList.previewCount(tools.length, this.expanded),
            );
            for (const [index, item] of shown.entries()) {
                const fork = branch(palette, index === shown.length - 1);
                if (this.expanded) {
                    const rows = item.render(Math.max(1, width - CHILD_INDENT));
                    this.childRows.push({
                        item,
                        row: lines.length,
                        height: rows.length,
                        width: Math.max(1, width - CHILD_INDENT),
                    });
                    // Pi leads each tool with a spacer row; the branch belongs on its heading.
                    const anchor = Math.max(
                        0,
                        rows.findIndex((row) => stripTerminalSequencesPreservingLayout(row).trim()),
                    );
                    lines.push(
                        ...rows.map((row, rowIndex) =>
                            truncateToWidth(
                                `   ${rowIndex === anchor ? fork : " "}${row}`,
                                width,
                                "",
                            ),
                        ),
                    );
                    continue;
                }
                // A collapsed call is one row without live output: rows that grow while a tool
                // runs and go when it settles move the bottom-pinned transcript twice.
                const diff =
                    !item.isPartial && !item.result?.isError
                        ? richDiffSummary(palette, item.toolName, item.args, item.result?.details)
                        : "";
                lines.push(
                    truncateToWidth(
                        renderToolLine(
                            palette,
                            width,
                            {
                                name: item.toolName,
                                summary: toolSummary(item.toolName, item.args, context.cwd),
                                href: toolHref(item.toolName, item.args, context.cwd),
                                status: statuses[start + index]!,
                                durationMs: item.result?.durationMs,
                                detail: diff,
                            },
                            `   ${fork} `,
                        ),
                        width,
                        "…",
                    ),
                );
            }
            lines.push(
                ...this.callList.renderOverflow(
                    palette,
                    width,
                    lines.length,
                    tools.length,
                    this.expanded,
                    hovered,
                    "   ",
                ),
            );
            this.cached = {
                width,
                colors,
                config: configVersion,
                hover: hovered,
                hoverVersion: hover.version,
                expanded: this.expanded,
                frame: pending ? animationFrame() : undefined,
                tools: tools.map((item) => ({
                    item,
                    args: item.args,
                    result: item.result,
                    expanded: item.expanded,
                    partial: item.isPartial,
                    revision: revision(item),
                })),
                lines,
            };
            return lines;
        }
    }
    const groupChildren = (parent: Container) => {
        if (
            parent instanceof ToolGroup ||
            parent instanceof ToolExecutionComponent ||
            parent instanceof ScrollView
        )
            return;
        const children: Component[] = [];
        let run: Component[] = [];
        const flush = () => {
            if (run.length < 2 && config.mode !== "compact") children.push(...run);
            else if (run.length) {
                const group = previousGroups.get(run[0]!) ?? new ToolGroup();
                previousGroups.set(run[0]!, group);
                original.clear.call(group);
                group.inheritExpansion(run.map(tool));
                for (const child of run) group.addTool(child);
                groups.add(group);
                children.push(group);
            }
            run = [];
        };
        for (const child of parent.children) {
            if (groupable(child)) {
                indexed.set(tool(child).toolCallId, tool(child));
                run.push(child);
            } else {
                flush();
                children.push(child);
            }
        }
        flush();
        parent.children = children;
    };
    const ungroup = () => {
        walkTranscript(getTui(), (component) => {
            if (component instanceof Container && !(component instanceof ToolGroup))
                component.children = component.children.flatMap((child) => {
                    if (!(child instanceof ToolGroup)) return [child];
                    for (const item of child.children) membership.delete(item);
                    return child.children;
                });
        });
        groups.clear();
        indexed.clear();
    };
    // A call opens as whatever shows it now: its own card, or the group it joined.
    const opener = (component: ToolInternals) => {
        const group = membership.get(component);
        return {
            target: group ?? component,
            apply(expanded: boolean) {
                if (group) group.setExpanded(expanded);
                else if (component.expanded !== expanded) component.setExpanded(expanded);
            },
        };
    };
    /**
     * Pi recreates every transcript component on compaction, tree navigation and some setting
     * changes, so a card or group opened with a click is found again by its calls.
     */
    const reopen = (component: ToolInternals) => {
        const owner = expansion.owner;
        const calls =
            owner instanceof ToolGroup && !groups.has(owner)
                ? owner.children.map((child) => tool(child).toolCallId)
                : owner instanceof ToolExecutionComponent &&
                    indexed.get(tool(owner).toolCallId) !== tool(owner)
                  ? [tool(owner).toolCallId]
                  : [];
        if (!calls.includes(component.toolCallId)) return;
        const { target, apply } = opener(component);
        expansion.transfer(owner!, target, apply);
        apply(true);
    };
    const installed = {
        addChild(this: Container, component: Component) {
            original.addChild.call(this, component);
            if (!active || rebuilding || this instanceof ToolGroup || !owned(component)) return;
            indexed.set(tool(component).toolCallId, tool(component));
            if (groupable(component)) {
                const previous = this.children.at(-2);
                if (previous instanceof ToolGroup) {
                    this.children.pop();
                    previous.addTool(component);
                } else if (previous && groupable(previous)) groupChildren(this);
                else if (config.mode === "compact") groupChildren(this);
            }
            reopen(tool(component));
        },
        removeChild(this: Container, component: Component) {
            const group = membership.get(component);
            if (group && this.children.includes(group)) {
                original.removeChild.call(group, component);
                forget(component);
                if (!group.children.length) {
                    groups.delete(group);
                    original.removeChild.call(this, group);
                }
                return;
            }
            forget(component);
            original.removeChild.call(this, component);
        },
        clear(this: Container) {
            for (const child of this.children) forget(child);
            original.clear.call(this);
        },
    };
    prototype.addChild = installed.addChild;
    prototype.removeChild = installed.removeChild;
    prototype.clear = installed.clear;
    return {
        isGrouped(id: string) {
            const component = indexed.get(id);
            return !!component && membership.has(component);
        },
        invalidateTool(id: string) {
            const component = indexed.get(id);
            if (component) membership.get(component)?.changed();
        },
        toggleTool(id: string, expanded: boolean) {
            const component = indexed.get(id);
            if (!component) return;
            const { target, apply } = opener(component);
            expansion.set(target, expanded, apply);
        },
        refresh() {
            rebuilding = true;
            try {
                ungroup();
                walkTranscript(getTui(), (component) => {
                    if (owned(component)) indexed.set(tool(component).toolCallId, tool(component));
                    if (component instanceof Container) groupChildren(component);
                });
            } finally {
                rebuilding = false;
            }
        },
        dispose() {
            active = false;
            ungroup();
            if (prototype.addChild === installed.addChild) prototype.addChild = original.addChild;
            if (prototype.removeChild === installed.removeChild)
                prototype.removeChild = original.removeChild;
            if (prototype.clear === installed.clear) prototype.clear = original.clear;
        },
    };
}
