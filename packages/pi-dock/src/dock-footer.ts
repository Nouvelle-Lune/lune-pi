import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LuneDockDisplayMode } from "@lune_99/pi-lune-extensions-core/dock";
import { DockView, type VisibleDockItem } from "./dock-renderer.ts";
import {
    CELL_SEPARATOR,
    modelSegmentVariants,
    renderContextCell,
    renderInfoRow,
    renderModelSegment,
    renderStatusRow,
    statColumns,
    type DockStatus,
} from "./dock-status.ts";

export const DOCK_STYLES = ["ruled", "boxed", "compact", "minimal", "classic"] as const;
export type DockStyle = (typeof DOCK_STYLES)[number];

/** Which of the footer's statistics a style shows; classic leaves Pi's footer in charge of them. */
export interface DockLayout {
    style: DockStyle;
    showModel: boolean;
    showWorkspace: boolean;
    showUsage: boolean;
}

export interface DockFooterInput {
    entries: readonly VisibleDockItem[];
    /** Undefined for the classic style, which draws no statistics. */
    status: DockStatus | undefined;
    /** Set only while the dock has focus: an unfocused dock draws no selection and no key hints. */
    selectedId: string | undefined;
    mode: LuneDockDisplayMode;
    layout: DockLayout;
}

/** Classic keeps Pi's own footer; every other style takes it over. */
export function replacesFooter(style: DockStyle): boolean {
    return style !== "classic";
}

/** Below this width the model name would crowd out the cells, so the cells keep the whole row. */
const MIN_MODEL_ROW_WIDTH = 40;
/** A box narrower than this has no room for its border and a cell, so it degrades to compact. */
const MIN_BOX_WIDTH = 24;

/** Longest first, so a narrow row still advertises some key. */
const KEY_HINTS = ["←→ select · enter open · esc back", "enter open · esc back", "enter open"];

interface Rows {
    dock: string | undefined;
    info: string | undefined;
    statuses: string | undefined;
}

/** What the dock row draws on its right; `width` is the span it occupies, at least the text's own. */
interface RightSegment {
    text: string;
    width: number;
}

const SEPARATOR_WIDTH = visibleWidth(CELL_SEPARATOR);

/**
 * Takes over Pi's footer: the module cells beside the model, then the working directory beside
 * the usage statistics, framed according to the chosen style.
 */
export class DockFooter {
    /** Owned here so the cell window survives the widget component being re-created. */
    private readonly cells = new DockView();

    render(width: number, theme: Theme, input: DockFooterInput): string[] {
        width = Math.max(0, Math.floor(width));
        if (width === 0) return [];
        switch (input.layout.style) {
            case "classic":
                return this.renderClassic(width, theme, input);
            case "boxed":
                return width < MIN_BOX_WIDTH
                    ? this.renderCompact(width, theme, input)
                    : this.renderBoxed(width, theme, input);
            case "compact":
            case "minimal":
                return this.renderCompact(width, theme, input);
            case "ruled":
                return this.renderRuled(width, theme, input);
        }
    }

    /** The original single row: cells with the key hint on the right, nothing else. */
    private renderClassic(width: number, theme: Theme, input: DockFooterInput): string[] {
        const row = this.cells.render(input.entries, width, theme, input.selectedId, input.mode)[0];
        if (row === undefined) return [];
        if (input.selectedId === undefined) return [row];
        for (const hint of KEY_HINTS) {
            const gap = width - visibleWidth(row) - visibleWidth(hint);
            if (gap >= 3) return [row + " ".repeat(gap) + theme.fg("dim", hint)];
        }
        return [row];
    }

    private renderRuled(width: number, theme: Theme, input: DockFooterInput): string[] {
        const rows = this.renderRows(width, theme, input, false);
        const rule = theme.fg("borderMuted", "─".repeat(width));
        const lines = [rule];
        // The rule under the dock row carries the key hints and doubles as the closing rule.
        if (rows.dock !== undefined) {
            lines.push(
                rows.dock,
                input.selectedId === undefined ? rule : this.renderHintRule(width, theme),
            );
        }
        if (rows.info !== undefined) lines.push(rows.info);
        if (rows.statuses !== undefined) lines.push(rows.statuses);
        if (rows.info !== undefined || rows.statuses !== undefined) lines.push(rule);
        return lines.length === 1 ? [] : lines;
    }

    private renderBoxed(width: number, theme: Theme, input: DockFooterInput): string[] {
        // "│ " before and " │" after leave 4 columns, 1 of which the rows already spend on their gutter.
        const rows = this.renderRows(width - 3, theme, input, false);
        const border = (text: string) => theme.fg("borderMuted", text);
        const frame = (left: string, fill: string, right: string) =>
            border(left) + fill + border(right);
        const wrap = (row: string) =>
            border("│") +
            row +
            " ".repeat(Math.max(0, width - 3 - visibleWidth(row))) +
            " " +
            border("│");
        const plain = border("─".repeat(width - 2));
        const hinted =
            input.selectedId === undefined ? plain : this.renderHintRule(width - 2, theme);

        const more = rows.info !== undefined || rows.statuses !== undefined;
        const lines: string[] = [];
        if (rows.dock !== undefined) {
            lines.push(wrap(rows.dock), frame(more ? "├" : "╰", hinted, more ? "┤" : "╯"));
        }
        if (rows.info !== undefined) lines.push(wrap(rows.info));
        if (rows.statuses !== undefined) lines.push(wrap(rows.statuses));
        if (lines.length === 0) return [];
        if (rows.dock === undefined || more) lines.push(frame("╰", plain, "╯"));
        return [frame("╭", plain, "╮"), ...lines];
    }

    /** No frame at all; with no rule to ride on, the key hint takes the model's place while focused. */
    private renderCompact(width: number, theme: Theme, input: DockFooterInput): string[] {
        const rows = this.renderRows(width, theme, input, true);
        return [rows.dock, rows.info, rows.statuses].filter((row) => row !== undefined);
    }

    private renderRows(
        width: number,
        theme: Theme,
        input: DockFooterInput,
        inlineHints: boolean,
    ): Rows {
        const { status, layout } = input;
        const showInfo = status !== undefined && layout.style !== "minimal";
        return {
            dock: this.renderDockRow(width, theme, input, inlineHints),
            info:
                showInfo && (layout.showWorkspace || layout.showUsage)
                    ? renderInfoRow(status, width, theme, {
                          workspace: layout.showWorkspace,
                          usage: layout.showUsage,
                      })
                    : undefined,
            statuses: status && renderStatusRow(status.extensionStatuses, width, theme),
        };
    }

    private renderDockRow(
        width: number,
        theme: Theme,
        input: DockFooterInput,
        inlineHints: boolean,
    ): string | undefined {
        const hasCells = input.entries.length > 0;
        const right = this.renderRightSegment(width, theme, input, inlineHints);
        if (!hasCells && !right.text) return undefined;

        const segment =
            " ".repeat(Math.max(0, right.width - visibleWidth(right.text))) + right.text;
        const tail = (hasCells && right.text ? theme.fg("dim", CELL_SEPARATOR) : "") + segment;
        const left = hasCells
            ? (this.cells.render(
                  input.entries,
                  width - visibleWidth(tail),
                  theme,
                  input.selectedId,
                  input.mode,
              )[0] ?? "")
            : "";
        return (
            left + " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(tail))) + tail
        );
    }

    /** Key hint while focused (when inline), otherwise the model; the minimal style adds context use. */
    private renderRightSegment(
        width: number,
        theme: Theme,
        input: DockFooterInput,
        inlineHints: boolean,
    ): RightSegment {
        const { status, layout } = input;
        const minimal = layout.style === "minimal";
        const flush = (text: string): RightSegment => ({ text, width: visibleWidth(text) });
        // Minimal has no info row to share the line with, so the right side may claim more of it.
        const budget = Math.floor(width * (minimal ? 0.6 : 0.5)) - SEPARATOR_WIDTH;
        if (inlineHints && input.selectedId !== undefined) {
            const hint = KEY_HINTS.find((candidate) => visibleWidth(candidate) <= budget);
            if (hint) return flush(theme.fg("dim", hint));
        }
        if (!status || width < MIN_MODEL_ROW_WIDTH) return flush("");
        if (minimal && layout.showUsage) {
            // Context use outranks optional model segments, so speed never displaces the counter.
            const context = renderContextCell(status, theme);
            const models = layout.showModel ? modelSegmentVariants(status, theme) : [""];
            for (const model of models) {
                const combined = model
                    ? model + theme.fg("dim", CELL_SEPARATOR) + context
                    : context;
                if (visibleWidth(combined) <= budget) return flush(combined);
            }
        }
        if (!layout.showModel) return flush("");
        // Keep the divider on the statistics grid without moving the model off the right edge.
        return !minimal && layout.showUsage
            ? this.placeModel(width, theme, status, layout.showWorkspace, budget)
            : flush(renderModelSegment(status, theme, budget));
    }

    /**
     * Keeps the divider on an info-row bar while the model stays flush right within that span.
     * The rightmost bar with room wins; optional model segments go before divider alignment does,
     * and a model too wide for any bar uses only its own width.
     */
    private placeModel(
        width: number,
        theme: Theme,
        status: DockStatus,
        workspace: boolean,
        budget: number,
    ): RightSegment {
        const spans = statColumns(status, width, workspace)
            .map((column) => column - SEPARATOR_WIDTH)
            .filter((span) => span <= budget)
            .sort((a, b) => a - b);
        for (const text of modelSegmentVariants(status, theme)) {
            const span = spans.find((candidate) => candidate >= visibleWidth(text));
            if (span !== undefined) return { text, width: span };
        }
        const text = renderModelSegment(status, theme, budget);
        return { text, width: visibleWidth(text) };
    }

    /** The hint rides the rule under the cells, so it never takes width from a cell or the model. */
    private renderHintRule(width: number, theme: Theme): string {
        for (const hint of KEY_HINTS) {
            const fill = width - visibleWidth(hint) - 3;
            if (fill < 3) continue;
            return (
                theme.fg("borderMuted", "─".repeat(fill)) +
                ` ${theme.fg("dim", hint)} ` +
                theme.fg("borderMuted", "─")
            );
        }
        return theme.fg("borderMuted", "─".repeat(width));
    }
}
