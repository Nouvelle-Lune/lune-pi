import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LEFT_PANE_RATIO = 0.28;
const LEFT_PANE_MIN_WIDTH = 22;
const LEFT_PANE_MAX_WIDTH = 36;
const RIGHT_PANE_MIN_WIDTH = 32;

// The overlay caps itself at 80% of the terminal, so the body leaves room for the six frame lines
// (top, header, two separators, footer, bottom) or the frame is clipped on short terminals.
const OVERLAY_HEIGHT_RATIO = 0.8;
const FRAME_HEIGHT = 6;
const BODY_MIN_HEIGHT = 8;
const BODY_MAX_HEIGHT = 32;

/** Top border, header and the separator above the panes. */
export const BODY_TOP = 3;

export interface PaneGeometry {
    bodyHeight: number;
    /** Columns between the outer borders. */
    innerWidth: number;
    leftWidth: number;
    rightWidth: number;
    /** First column of the right pane in overlay-local cells, for mouse hit-testing. */
    rightStart: number;
}

export function paneGeometry(width: number, terminalRows: number): PaneGeometry {
    const bodyHeight = Math.min(
        BODY_MAX_HEIGHT,
        Math.max(BODY_MIN_HEIGHT, Math.floor(terminalRows * OVERLAY_HEIGHT_RATIO) - FRAME_HEIGHT),
    );
    const innerWidth = Math.max(LEFT_PANE_MIN_WIDTH + RIGHT_PANE_MIN_WIDTH + 1, width - 2);
    const leftWidth = Math.min(
        LEFT_PANE_MAX_WIDTH,
        Math.max(LEFT_PANE_MIN_WIDTH, Math.round(innerWidth * LEFT_PANE_RATIO)),
        innerWidth - RIGHT_PANE_MIN_WIDTH - 1,
    );
    const rightWidth = innerWidth - leftWidth - 1;

    return { bodyHeight, innerWidth, leftWidth, rightWidth, rightStart: leftWidth + 2 };
}

/** First listed row, keeping the selection centred until the list runs out on either side. */
export function listWindowStart(selected: number, count: number, height: number): number {
    return Math.min(Math.max(0, selected - Math.floor(height / 2)), Math.max(0, count - height));
}

/** One padding column on each side keeps text off the borders and leaves room for a scrollbar. */
export function cell(text: string, width: number): string {
    return ` ${truncateToWidth(text, Math.max(0, width - 2), "…", true)} `;
}

export function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export interface FrameParts {
    header: string;
    left: readonly string[];
    right: readonly string[];
    footer: string;
}

export function assembleFrame(theme: Theme, geometry: PaneGeometry, parts: FrameParts): string[] {
    const { bodyHeight, innerWidth, leftWidth, rightWidth } = geometry;
    const border = (text: string): string => theme.fg("border", text);
    const edge = border("│");
    const lines = [
        border(`┌${"─".repeat(innerWidth)}┐`),
        edge + pad(parts.header, innerWidth) + edge,
        border(`├${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┤`),
    ];

    for (let row = 0; row < bodyHeight; row++) {
        lines.push(
            edge +
                pad(parts.left[row] ?? "", leftWidth) +
                edge +
                pad(parts.right[row] ?? "", rightWidth) +
                edge,
        );
    }

    lines.push(
        border(`├${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┤`),
        edge + pad(parts.footer, innerWidth) + edge,
        border(`└${"─".repeat(innerWidth)}┘`),
    );

    return lines;
}

/** Thumb of a bar over `height` rows showing `total` rows from `start`; undefined when all fit. */
export function paintScrollbar(
    theme: Theme,
    rows: string[],
    start: number,
    height: number,
    total: number,
): string[] {
    if (height <= 0 || total <= height) {
        return rows;
    }

    const size = Math.max(Math.min(2, height), Math.round((height * height) / total));
    const top = Math.round((start / (total - height)) * (height - size));

    // Both panes reserve their last column as padding, so the bar never covers text.
    return rows.map((line, row) => {
        const onThumb = row >= top && row < top + size;

        return (
            line.slice(0, -1) +
            theme.fg(onThumb ? "scrollbarThumb" : "scrollbarTrack", onThumb ? "┃" : "│")
        );
    });
}
