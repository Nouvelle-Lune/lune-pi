import { visibleWidth } from "@earendil-works/pi-tui";
import { patchMethod } from "./hover.ts";

// CSI, OSC and APC sequences; everything between them is text.
const escapes = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const osc8 = /^\x1b\]8;[^;]*;([^\x07\x1b]*)/;
const wordCharacter = /[\p{L}\p{N}]/u;

type Piece = { code: string } | { text: string };

function* pieces(line: string): Generator<Piece> {
    let index = 0;
    for (const match of line.matchAll(escapes)) {
        if (match.index > index) yield { text: line.slice(index, match.index) };
        yield { code: match[0] };
        index = match.index + match[0].length;
    }
    if (index < line.length) yield { text: line.slice(index) };
}

/** The underline state an SGR sequence leaves, or undefined when it does not change underline. */
function underlineAfter(code: string): boolean | undefined {
    const params = /^\x1b\[([\d;:]*)m$/.exec(code)?.[1];
    if (params === undefined) return undefined;
    if (!params) return false;
    let underline: boolean | undefined;
    const parts = params.split(";");
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        if (part === "0" || part === "24" || part === "4:0") underline = false;
        else if (part === "4" || part.startsWith("4:")) underline = true;
        // Extended colors carry numbers that are not attributes, such as the 4 in `38;5;4`.
        else if (part === "38" || part === "48" || part === "58")
            index += parts[index + 1] === "5" ? 2 : parts[index + 1] === "2" ? 4 : 0;
    }
    return underline;
}

/** One OSC 8 link on a row. `ordinal` counts the links on the row; `start` and `end` are columns. */
export interface LinkSpan {
    href: string;
    ordinal: number;
    start: number;
    end: number;
    /** No letter or digit comes before the link: it may continue a link wrapped from the row above. */
    leading: boolean;
    /** No letter or digit comes after the link: it may continue on the row below. */
    trailing: boolean;
}

export function findLinks(line: string): LinkSpan[] {
    if (!line.includes("\x1b]8;")) return [];
    const spans: LinkSpan[] = [];
    // Where each span's text ends in `text`, to look at what follows it once the row is known.
    const ends: number[] = [];
    let text = "";
    let column = 0;
    let open: { href: string; start: number; offset: number } | undefined;
    const close = () => {
        if (!open) return;
        spans.push({
            href: open.href,
            ordinal: spans.length,
            start: open.start,
            end: column,
            leading: !wordCharacter.test(text.slice(0, open.offset)),
            trailing: true,
        });
        ends.push(text.length);
        open = undefined;
    };
    for (const piece of pieces(line)) {
        if ("text" in piece) {
            text += piece.text;
            column += visibleWidth(piece.text);
            continue;
        }
        const link = osc8.exec(piece.code);
        if (!link) continue;
        close();
        if (link[1]) open = { href: link[1], start: column, offset: text.length };
    }
    close();
    spans.forEach((span, index) => {
        span.trailing = !wordCharacter.test(text.slice(ends[index]));
    });
    return spans;
}

/**
 * Link text is underlined only for the links in `picked` (by ordinal); text outside links keeps
 * its own underline.
 */
export function underlineLinks(line: string, picked?: ReadonlySet<number>): string {
    if (!line.includes("\x1b]8;")) return line;
    let result = "";
    let ordinal = -1;
    let linked = false;
    // Underline as the line asks for it, and as the terminal shows it after our changes.
    let requested = false;
    let shown = false;
    const show = (underline: boolean) => {
        if (underline !== shown) result += underline ? "\x1b[4m" : "\x1b[24m";
        shown = underline;
    };
    for (const piece of pieces(line)) {
        if ("text" in piece) {
            show(linked ? !!picked?.has(ordinal) : requested);
            result += piece.text;
            continue;
        }
        result += piece.code;
        const link = osc8.exec(piece.code);
        if (link) {
            linked = !!link[1];
            if (linked) ordinal++;
        } else {
            const underline = underlineAfter(piece.code);
            if (underline !== undefined) requested = shown = underline;
        }
    }
    show(requested);
    return result;
}

export interface Pointer {
    row: number;
    column: number;
}

function linkAt(lines: readonly string[], pointer: Pointer | undefined) {
    const line = pointer && lines[pointer.row];
    if (!pointer || line === undefined) return undefined;
    return findLinks(line).find(
        (span) => span.start <= pointer.column && pointer.column < span.end,
    );
}

/**
 * The links to underline for a pointer, by row. Only the link under the pointer counts, not other
 * links with the same target; a link wrapped over several rows counts on all of them.
 */
export function hoveredLinks(
    lines: readonly string[],
    pointer: Pointer | undefined,
): Map<number, Set<number>> {
    const picked = new Map<number, Set<number>>();
    const hit = linkAt(lines, pointer);
    if (!pointer || !hit) return picked;
    picked.set(pointer.row, new Set([hit.ordinal]));
    // A wrapped link ends one row and starts the next with nothing but markup around it.
    const extend = (step: 1 | -1) => {
        let span = hit;
        for (let row = pointer.row + step; row >= 0 && row < lines.length; row += step) {
            if (step === 1 ? !span.trailing : !span.leading) return;
            const spans = findLinks(lines[row]!);
            const next = step === 1 ? spans[0] : spans.at(-1);
            if (next?.href !== hit.href || !(step === 1 ? next.leading : next.trailing)) return;
            picked.set(row, new Set([next.ordinal]));
            span = next;
        }
    };
    extend(1);
    extend(-1);
    return picked;
}

/**
 * Pi underlines every link. Each frame drops that underline and adds it to the link under the
 * pointer instead. Only fullscreen reports pointer motion; elsewhere the terminal shows hover.
 */
export function installLinkHover(tui: object, repaint: () => void) {
    const host = tui as { getScreenLines?: () => string[] };
    let pointer: Pointer | undefined;
    const stopFrames = patchMethod<(lines: string[]) => string[]>(
        tui,
        "applyLineResets",
        (original) =>
            function (this: unknown, lines) {
                const picked = hoveredLinks(lines, pointer);
                for (let row = 0; row < lines.length; row++)
                    lines[row] = underlineLinks(lines[row]!, picked.get(row));
                return original.call(this, lines);
            },
    );
    const stopInput = patchMethod<(data: string) => unknown>(
        tui,
        "handleViewportInput",
        (original) =>
            function (this: unknown, data) {
                const mouse = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
                const code = Number(mouse?.[1]);
                // Motion with no button held; a drag selects text and a wheel scrolls it.
                if (mouse && (code & 32) !== 0 && (code & 3) === 3) {
                    const screen = host.getScreenLines?.() ?? [];
                    const key = (at: Pointer | undefined) => {
                        const hit = linkAt(screen, at);
                        return hit && `${at!.row}:${hit.ordinal}`;
                    };
                    const before = key(pointer);
                    pointer = { row: Number(mouse[3]) - 1, column: Number(mouse[2]) - 1 };
                    if (key(pointer) !== before) repaint();
                }
                return original.call(this, data);
            },
    );
    return () => {
        stopInput();
        stopFrames();
    };
}
