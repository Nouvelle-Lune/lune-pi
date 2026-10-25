import type { Theme, ThemeBg } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Pi's expand key, written out rather than read from `keyHint()`: that helper colours with the
 * theme module's own global, which an extension's copy of the module never initializes.
 */
export const EXPAND_KEY = "ctrl+o";

/**
 * Clip one line to the columns a row has left.
 *
 * `truncateToWidth` closes a cut with a full reset, which would drop a band's background from
 * everything after the ellipsis.
 */
export function clipToWidth(text: string, width: number): string {
    const ellipsis = "…";

    if (width <= 0) {
        return "";
    }

    if (visibleWidth(text) <= width) {
        return text;
    }

    const ellipsisWidth = visibleWidth(ellipsis);

    if (width <= ellipsisWidth) {
        return sliceByColumn(ellipsis, 0, width, true);
    }

    return `${sliceByColumn(text, 0, width - ellipsisWidth, true)}${ellipsis}`;
}

/** A part of a one-line summary; parts with a lower rank give way first when the line is too long. */
export interface RankedPart {
    text: string;
    rank: number;
}

/**
 * The richest line that fits in `width`. `compose` gets the kept parts in their original order;
 * the lowest-ranked part, the last one among equals, is left out until the line fits. So a narrow
 * row shows fewer complete parts instead of a cut one. Undefined when not even `compose([])` fits.
 */
export function fitRanked(
    parts: readonly RankedPart[],
    width: number,
    compose: (texts: readonly string[]) => string,
): string | undefined {
    const kept = [...parts];

    for (;;) {
        const line = compose(kept.map((part) => part.text));

        if (visibleWidth(line) <= width) {
            return line;
        }

        if (kept.length === 0) {
            return undefined;
        }

        let lowest = 0;

        for (let index = 1; index < kept.length; index++) {
            if (kept[index]!.rank <= kept[lowest]!.rank) {
                lowest = index;
            }
        }

        kept.splice(lowest, 1);
    }
}

/**
 * Text from a run as plain display lines: terminal sequences removed, a carriage return keeping
 * what a terminal would leave on screen, and tabs expanded because rows are measured in cells.
 */
export function displayLines(text: string): string[] {
    return stripTerminalSequences(text).split("\n").map(displayLine);
}

function displayLine(line: string): string {
    const segments = line.split("\r");

    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index]!;

        if (segment.length > 0) {
            return segment.replace(/\t/g, "   ");
        }
    }

    return "";
}

/** One row of a full-width band with side padding, like Pi's tool result box. */
export function bandRow(
    theme: Theme,
    token: ThemeBg,
    row: string,
    inner: number,
    paddingX: number,
): string {
    const margin = " ".repeat(paddingX);
    const fill = " ".repeat(Math.max(0, inner - visibleWidth(row)));

    return theme.bg(token, `${margin}${row}${fill}${margin}`);
}
