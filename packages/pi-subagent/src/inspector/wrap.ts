import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Two generations of this many characters hold every line of a long transcript at one width.
const GENERATION_LIMIT_CHARS = 1_000_000;

/**
 * Wrapped rows per display line and width.
 *
 * A streamed answer grows at its end, so keying by text wraps only the lines that are new. Two
 * generations bound the memory: lines the last frames did not need are dropped on the next rotation,
 * which also drops the rows of a width the pane no longer has.
 */
export class LineWrapCache {
    private recent = new Map<string, readonly string[]>();
    private previous = new Map<string, readonly string[]>();
    private recentChars = 0;

    /** `line` holds no newline. */
    rows(line: string, width: number): readonly string[] {
        const key = `${width}\n${line}`;
        const hit = this.recent.get(key);

        if (hit) {
            return hit;
        }

        const rows = this.previous.get(key) ?? wrapTextWithAnsi(line, width);

        if (this.recentChars >= GENERATION_LIMIT_CHARS) {
            this.previous = this.recent;
            this.recent = new Map();
            this.recentChars = 0;
        }

        this.recent.set(key, rows);
        this.recentChars += line.length;

        return rows;
    }

    clear(): void {
        this.recent.clear();
        this.previous.clear();
        this.recentChars = 0;
    }
}

export interface Excerpt {
    rows: string[];
    /** Lines left out, counting a line that was cut. */
    hidden: number;
}

/**
 * The first `limit` rows of `lines` wrapped to `width`.
 *
 * Only the lines that show are wrapped: a tool's output can be hundreds of kilobytes, and wrapping
 * all of it to keep three rows is what made opening a run slow.
 */
export function headRows(lines: readonly string[], width: number, limit: number): Excerpt {
    const bound = boundOf(width, limit);
    const rows: string[] = [];
    let shown = 0;

    while (shown < lines.length && rows.length < limit) {
        const line = lines[shown]!;
        const kept = line.length > bound ? sliceHead(line, bound) : line;

        rows.push(...wrapTextWithAnsi(kept, width));

        if (kept !== line || rows.length > limit) {
            rows.length = Math.min(rows.length, limit);

            return { rows, hidden: lines.length - shown };
        }

        shown += 1;
    }

    return { rows, hidden: lines.length - shown };
}

/** The last `limit` rows of `lines` wrapped to `width`, wrapping from the end. */
export function tailRows(lines: readonly string[], width: number, limit: number): Excerpt {
    const bound = boundOf(width, limit);
    const chunks: string[][] = [];
    let count = 0;
    // Lines before this index are not shown in full.
    let first = lines.length;

    while (first > 0 && count < limit) {
        const line = lines[first - 1]!;
        const kept = line.length > bound ? sliceTail(line, bound) : line;
        const wrapped = wrapTextWithAnsi(kept, width);

        chunks.push(wrapped);
        count += wrapped.length;

        if (kept !== line || count > limit) {
            return { rows: chunks.reverse().flat().slice(-limit), hidden: first };
        }

        first -= 1;
    }

    return { rows: chunks.reverse().flat(), hidden: first };
}

/**
 * Characters of one line that fill more than `limit` rows, since a character other than a
 * zero-width one takes at least one cell. A longer line is cut before it is wrapped, so a single
 * huge line costs no more than a short one; the cut line counts as left out.
 */
function boundOf(width: number, limit: number): number {
    return (limit + 1) * Math.max(1, width) * 2;
}

function sliceHead(line: string, length: number): string {
    const end = isHighSurrogate(line.charCodeAt(length - 1)) ? length - 1 : length;

    return line.slice(0, end);
}

function sliceTail(line: string, length: number): string {
    const start = line.length - length;

    return line.slice(isLowSurrogate(line.charCodeAt(start)) ? start + 1 : start);
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff;
}
