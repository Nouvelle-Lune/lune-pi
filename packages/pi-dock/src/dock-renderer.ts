import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { LuneDockSnapshot, LuneDockDisplayMode } from "@lune_99/pi-lune-extensions-core/dock";

export interface VisibleDockItem {
    id: string;
    snapshot: LuneDockSnapshot;
}

/**
 * Levels are complete alternatives, never fragments: resolution degrades only downward.
 */
export function resolveSnapshotLevel(snapshot: LuneDockSnapshot, mode: LuneDockDisplayMode) {
    if (mode === "full") return snapshot.full ?? snapshot.detail ?? snapshot.base;
    if (mode === "detail") return snapshot.detail ?? snapshot.base;
    return snapshot.base;
}

function renderCellText(entry: VisibleDockItem, mode: LuneDockDisplayMode, width: number): string {
    const lines = resolveSnapshotLevel(entry.snapshot, mode).render(width);
    // A level must publish one physical line; wrapping would corrupt the host's single-row widget.
    if (lines.length !== 1 || /[\r\n]/.test(lines[0]!)) {
        throw new Error(`Lune snapshot ${entry.id} (${mode}) must render exactly one line`);
    }
    return truncateToWidth(lines[0]!, width);
}

function highlight(theme: Theme, text: string): string {
    // Reapply selection after ANSI style changes so plugin resets cannot clear its background.
    return text
        .split(/(\x1b\[[\d;:]*m)/)
        .map((part, index) => (index % 2 === 0 ? theme.bg("selectedBg", part) : part))
        .join("");
}

/** Components own their text and styling; this view adds only placement and focus chrome. */
export class DockView {
    /** The controller keeps one view across widget rebuilds, so the window survives a re-created component. */
    private start = 0;

    render(
        entries: readonly VisibleDockItem[],
        width: number,
        theme: Theme,
        selectedId?: string,
        mode: LuneDockDisplayMode = "detail",
    ): string[] {
        width = Math.max(0, Math.floor(width));
        if (entries.length === 0 || width === 0) {
            this.start = 0;
            return [];
        }
        // An unfocused dock passes no selectedId, so there is no cell to keep visible and no focus chrome to draw.
        const selected = entries.findIndex((entry) => entry.id === selectedId);

        const anchor = Math.max(0, selected);

        // The 12-column stride estimates how many cells fit; keep one visible when the row is too narrow to meet it.
        const count = Math.min(entries.length, Math.max(1, Math.floor((width - 1) / 12)));

        // Keep the current window stable until selection leaves it, then move only enough to reveal that cell.
        this.start = Math.min(this.start, anchor, entries.length - count);

        if (anchor >= this.start + count) {
            this.start = anchor - count + 1;
        }

        if (selected < 0) {
            this.start = 0;
        }

        const end = this.start + count;

        let before = this.start > 0 ? `‹${this.start} ` : "";
        let after = end < entries.length ? ` ${entries.length - end}›` : "";

        // Overflow counts must leave the existing gutter available for the selected cell's marker.
        if (selected >= 0 && 1 + visibleWidth(before + after) + 3 * (count - 1) >= width) {
            before = "";
            after = "";
        }

        const overhead = 1 + visibleWidth(before + after) + 3 * (count - 1);
        const available = Math.max(0, width - overhead);
        const pointer = selected >= 0 ? highlight(theme, theme.fg("accent", "❯")) : "";

        const cells = entries.slice(this.start, end).map((entry, index) => {
            // Leftmost cells absorb the remainder so allocation stays independent of the selection.
            const allocated = Math.floor(available / count) + (index < available % count ? 1 : 0);
            const text = renderCellText(entry, mode, allocated);
            const active = entry.id === selectedId;
            // Reuse the gutter or separator's final blank column instead of adding space to a cell.
            const prefix =
                index === 0
                    ? active
                        ? pointer
                        : " "
                    : active
                      ? theme.fg("dim", " │") + pointer
                      : theme.fg("dim", " │ ");
            return prefix + (active ? highlight(theme, text) : text);
        });

        const line = theme.fg("dim", before) + cells.join("") + theme.fg("dim", after);
        return [truncateToWidth(line, width)];
    }
}

/** One-shot rendering for callers without a view instance; window state is deliberately not preserved. */
export function renderDockLine(
    entries: readonly VisibleDockItem[],
    width: number,
    theme: Theme,
    selectedId?: string,
    mode: LuneDockDisplayMode = "detail",
): string[] {
    return new DockView().render(entries, width, theme, selectedId, mode);
}
