import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";
import { patchMethod } from "./hover.ts";

// CSI, OSC and APC sequences; everything between them is text.
const escapes = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_][^\x07\x1b]*(?:\x07|\x1b\\))/g;

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

/** Link text is underlined only while `hovered` is its target; text outside links keeps its own style. */
export function underlineHoveredLinks(line: string, hovered: string | undefined): string {
    if (!line.includes("\x1b]8;")) return line;
    let result = "";
    let index = 0;
    let href: string | undefined;
    // Underline as the line asks for it, and as the terminal shows it after our changes.
    let requested = false;
    let shown = false;
    const show = (underline: boolean) => {
        if (underline !== shown) result += underline ? "\x1b[4m" : "\x1b[24m";
        shown = underline;
    };
    const text = (end: number) => {
        if (end <= index) return;
        show(href ? href === hovered : requested);
        result += line.slice(index, end);
    };
    for (const match of line.matchAll(escapes)) {
        text(match.index);
        const code = match[0];
        result += code;
        index = match.index + code.length;
        const link = /^\x1b\]8;[^;]*;([^\x07\x1b]*)/.exec(code);
        if (link) href = link[1] || undefined;
        else {
            const underline = underlineAfter(code);
            if (underline !== undefined) requested = shown = underline;
        }
    }
    text(line.length);
    show(requested);
    return result;
}

type LinkHoverHost = { getScreenLines?: () => string[] };

/**
 * Pi underlines every link. Each frame drops that underline and adds it to the link under the
 * pointer instead. Only fullscreen reports pointer motion; elsewhere the terminal shows hover.
 */
export function installLinkHover(tui: object, repaint: () => void) {
    const host = tui as LinkHoverHost;
    let hovered: string | undefined;
    const stopFrames = patchMethod<(lines: string[]) => string[]>(
        tui,
        "applyLineResets",
        (original) =>
            function (this: unknown, lines) {
                for (let row = 0; row < lines.length; row++)
                    lines[row] = underlineHoveredLinks(lines[row]!, hovered);
                return original.call(this, lines);
            },
    );
    const stopInput = patchMethod<(data: string) => unknown>(
        tui,
        "handleViewportInput",
        (original) =>
            function (this: unknown, data) {
                const mouse = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
                if (mouse) {
                    const code = Number(mouse[1]);
                    let next = hovered;
                    // A wheel scroll moves the text under a pointer that stays still.
                    if ((code & 64) !== 0) next = undefined;
                    else if ((code & 32) !== 0 && (code & 3) === 3) {
                        const line = host.getScreenLines?.()[Number(mouse[3]) - 1];
                        next =
                            line === undefined
                                ? undefined
                                : getOsc8LinkAtColumn(line, Number(mouse[2]) - 1);
                    }
                    if (next !== hovered) {
                        hovered = next;
                        repaint();
                    }
                }
                return original.call(this, data);
            },
    );
    return () => {
        stopInput();
        stopFrames();
    };
}
