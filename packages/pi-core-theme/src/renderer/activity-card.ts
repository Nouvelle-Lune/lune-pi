import { readFile } from "node:fs/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    truncateToWidth,
    wrapTextWithAnsi,
    type Component,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { config, configRevision } from "../config/config.ts";
import type { LuneActivity, LuneActivityEntry } from "../protocol.ts";
import { Disclosure } from "../ui/disclosure.ts";
import type { ExpansionState } from "../ui/expansion.ts";
import type { HoverState } from "../ui/hover.ts";
import type { OutputContent } from "../ui/output-panel.ts";
import { branch, meta, statusMark } from "../ui/style.ts";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { framedRow, HIDDEN_OUTPUT } from "./cards.ts";
import { animationFrame, overallStatus } from "./tool/activity.ts";
import { attentionCounts, renderToolLine } from "./tool/presentation.ts";

// Bodies start under the entry name, past the tree branch and status mark.
const BODY_INDENT = "    ";
// Collapsed rows hang under the heading, past the tree gutter.
const ROW_INDENT = "   ";

interface ActivityState {
    /** Pi's global expand toggle when the state was last synced. */
    host: boolean;
    expanded: boolean;
    /** Hover targets of the full-output rows, by entry, so hovering one never lights another. */
    outputs: Map<number, object>;
}

/**
 * Pi rebuilds a custom message's component on every invalidation, so what a click opened is kept
 * against the message's own key instead of in the card.
 */
export class ActivityInteraction {
    readonly hover: HoverState;
    readonly expansion: ExpansionState;
    readonly openOutput: (title: string, content: OutputContent) => void;
    private readonly states = new WeakMap<object, ActivityState>();

    constructor(
        hover: HoverState,
        expansion: ExpansionState,
        openOutput: (title: string, content: OutputContent) => void,
    ) {
        this.hover = hover;
        this.expansion = expansion;
        this.openOutput = openOutput;
    }
    state(key: object, host: boolean): ActivityState {
        let state = this.states.get(key);
        if (!state) {
            state = { host, expanded: host, outputs: new Map() };
            this.states.set(key, state);
        } else if (state.host !== host) {
            // Pi's own toggle takes over, so opening another card must not undo it.
            this.expansion.release(state);
            state.host = host;
            state.expanded = host;
        }
        return state;
    }
}

/** A call tree for surfaces that are not tool rows; it reads exactly like a composite tool card. */
export class ActivityCard implements Component {
    private readonly activity: LuneActivity;
    private readonly theme: Theme;
    private readonly expandKey: () => string;
    private readonly state: ActivityState;
    private readonly interaction: ActivityInteraction | undefined;
    private readonly header = new Disclosure();
    private readonly hints: Disclosure[] = [];
    private readonly outputRows = new Map<
        number,
        { target: object; title: string; content: OutputContent }
    >();
    private rendered: { key: unknown[]; lines: string[] } | undefined;

    /** Without a surface key the card has no click targets and follows Pi's expand toggle alone. */
    constructor(
        activity: LuneActivity,
        expanded: boolean,
        theme: Theme,
        expandKey: () => string,
        surface?: { key: object; interaction: ActivityInteraction },
    ) {
        this.activity = activity;
        this.theme = theme;
        this.expandKey = expandKey;
        this.interaction = surface?.interaction;
        this.state = surface
            ? surface.interaction.state(surface.key, expanded)
            : { host: expanded, expanded, outputs: new Map() };
    }
    private get hovered() {
        return this.interaction?.hover.has(this.state) ?? false;
    }
    private get hoveredOutput() {
        const hover = this.interaction?.hover;
        return hover && [...this.state.outputs.values()].find((target) => hover.has(target));
    }
    invalidate() {
        this.rendered = undefined;
    }
    render(width: number): string[] {
        const running = this.activity.entries.some((entry) => entry.status === "running");
        const key = [
            width,
            this.theme.colors,
            configRevision(),
            running && animationFrame(),
            this.state.expanded,
            this.hovered,
            this.hoveredOutput,
        ];
        const previous = this.rendered?.key;
        if (previous?.every((value, index) => value === key[index])) return this.rendered!.lines;
        const lines = this.lines(width);
        this.rendered = { key, lines };
        return lines;
    }
    handleMouse(event: TuiMouseEvent) {
        const interaction = this.interaction;
        if (!interaction || !config.fullscreenMouse) return undefined;
        const { hover } = interaction;
        const expanded = this.state.expanded;
        const output = this.outputRows.get(event.y);
        const hint =
            !expanded &&
            (this.header.contains(event) || this.hints.some((hint) => hint.contains(event)));
        if (event.type === "move") {
            let changed: boolean;
            if (output) changed = hover.focus(output.target);
            else if (hint) changed = hover.focus(this.state);
            else {
                changed = hover.blur(this.state);
                for (const target of this.state.outputs.values())
                    changed = hover.blur(target) || changed;
            }
            return { handled: true as const, render: changed };
        }
        if (event.type !== "click" || event.button !== "left") return undefined;
        if (output) {
            hover.clear();
            interaction.openOutput(output.title, output.content);
            return { handled: true as const, render: true };
        }
        if (!expanded && !hint) return undefined;
        hover.clear();
        interaction.expansion.set(this.state, !expanded, (next) => {
            this.state.expanded = next;
        });
        return { handled: true as const, render: true };
    }
    private lines(width: number): string[] {
        const theme = this.theme;
        const expanded = this.state.expanded;
        const inner = Math.max(1, width - 3);
        const { entries } = this.activity;
        const statuses = entries.map((entry) => entry.status);
        const title = `${statusMark(overallStatus(statuses), theme)} ${theme.bold(theme.fg("toolTitle", this.activity.title))}`;
        const counts = meta(theme, [this.activity.summary, ...attentionCounts(theme, statuses)]);
        const heading = counts ? `${title}  ${counts}` : title;
        const frame = (row: string) =>
            expanded
                ? framedRow(theme, row, width)
                : truncateToWidth(`${ROW_INDENT}${row}`, width, "");
        this.header.reset();
        this.hints.length = 0;
        this.outputRows.clear();
        const lines = [
            expanded
                ? framedRow(theme, heading, width)
                : this.interaction
                  ? this.header.render(theme, width, 0, this.hovered, heading)
                  : truncateToWidth(heading, width, "…"),
        ];
        for (const [index, entry] of entries.entries()) {
            lines.push(
                frame(
                    renderToolLine(
                        theme,
                        inner,
                        { ...entry, summary: entry.summary ?? "" },
                        `${branch(theme, index === entries.length - 1)} `,
                    ),
                ),
            );
            const bodyWidth = Math.max(1, inner - BODY_INDENT.length);
            const body = this.body(entry, bodyWidth);
            lines.push(...body.rows.map((row) => frame(BODY_INDENT + row)));
            // A spilled log is longer than any tail, so its browser row shows even when the tail fits.
            if (expanded && this.interaction && (body.hidden || entry.fullOutputPath)) {
                let target = this.state.outputs.get(index);
                if (!target) {
                    target = {};
                    this.state.outputs.set(index, target);
                }
                this.outputRows.set(lines.length, {
                    target,
                    title: `${entry.name} · full output`,
                    content: () =>
                        entry.fullOutputPath
                            ? readFile(entry.fullOutputPath, "utf8")
                            : (entry.output ?? ""),
                });
                const hovered = this.interaction?.hover.has(target);
                lines.push(
                    frame(
                        BODY_INDENT +
                            theme.fg(
                                hovered ? "accent" : "dim",
                                truncateToWidth(HIDDEN_OUTPUT, bodyWidth, ""),
                            ),
                    ),
                );
                continue;
            }
            if (!body.hidden) continue;
            const label = `… ${body.hidden} ${body.partial ? "earlier " : ""}${body.hidden === 1 ? "line" : "lines"}`;
            if (!this.interaction) {
                const hint = `${label} · ${this.expandKey()} to expand`;
                lines.push(
                    frame(BODY_INDENT + theme.fg("dim", truncateToWidth(hint, bodyWidth, ""))),
                );
                continue;
            }
            const hint = new Disclosure();
            this.hints.push(hint);
            lines.push(
                hint.render(
                    theme,
                    width,
                    lines.length,
                    this.hovered,
                    ROW_INDENT + BODY_INDENT,
                    label,
                ),
            );
        }
        return lines;
    }
    private body(
        entry: LuneActivityEntry,
        width: number,
    ): { rows: string[]; hidden: number; partial: boolean } {
        const theme = this.theme;
        const rows = entry.error
            ? wrapTextWithAnsi(sanitizeToolResultText(entry.error), width).map((row) =>
                  theme.fg("error", row),
              )
            : [];
        const output = entry.output
            ? wrapTextWithAnsi(sanitizeToolResultText(entry.output).trimEnd(), width)
            : [];
        const cap = this.state.expanded
            ? this.interaction
                ? config.expandedOutputMaxLines
                : output.length
            : config.previewLines;
        const visible = output.slice(output.length - Math.min(output.length, cap));
        rows.push(...visible.map((row) => theme.fg("toolOutput", row)));
        return { rows, hidden: output.length - visible.length, partial: visible.length > 0 };
    }
}
