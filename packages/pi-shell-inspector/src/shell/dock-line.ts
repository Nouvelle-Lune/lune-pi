import { visibleWidth } from "@earendil-works/pi-tui";

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
