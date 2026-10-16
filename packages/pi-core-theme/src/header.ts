import type { keyText, Theme } from "@earendil-works/pi-coding-agent";
import {
    parseColor,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Color,
    type Component,
} from "@earendil-works/pi-tui";
import { palettes, type PaletteDefinition } from "./palettes/index.ts";

type MoonKey = "w" | "i" | "p" | "b" | "d";
type MoonColors = Readonly<Record<MoonKey, Color>>;
const crescent = ({ vars }: PaletteDefinition): MoonColors => ({
    w: parseColor(vars.moon1!),
    i: parseColor(vars.moon2!),
    p: parseColor(vars.moon3!),
    b: parseColor(vars.moon4!),
    d: parseColor(vars.moon5!),
});
const paletteMoons = new Map<string, MoonColors>(
    Object.entries(palettes).map(([name, { definition }]) => [name, crescent(definition)]),
);
const moonColors = paletteMoons.get("pi-core-dark")!;
// The light crescent fades one step deeper, so its lit edge and text survive light backgrounds.
const lightMoonColors = paletteMoons.get("pi-core-light")!;
/** Lune palettes tint the crescent; any other theme keeps the ice-blue brand moon. */
const moonPalette = (theme: Theme) =>
    paletteMoons.get(theme.name ?? "") ??
    (theme.appearance === "light" ? lightMoonColors : moonColors);

// A "lune" is a crescent. The colour fades from moonlight (w) at the top
// to deep blue (d) at the bottom: one colour per terminal line, no stray pixels.
// Half blocks show two pixel rows per terminal row: 10 pixel rows = 5 lines.
const moonPixels: readonly string[] = [
    "   wwww   ",
    " wwww     ",
    " iiii     ",
    "iiii      ",
    "pppp      ",
    "pppp      ",
    "bbbb      ",
    " bbbb     ",
    " dddd     ",
    "   dddd   ",
];
const logoWidth = moonPixels[0]!.length;
const logoGap = 4; // empty columns between the logo and the text
const indent = 1; // empty columns at the left edge
const verticalPadding = 1; // empty lines above and below the header

// Small stars in the open side of the crescent. Key = "terminalRow:column".
// Only ASCII glyphs, so the width is the same in every terminal. Use {} to remove them.
const stars: Readonly<Record<string, { glyph: string; color: MoonKey }>> = {
    "0:9": { glyph: ".", color: "b" },
    "1:7": { glyph: "*", color: "i" },
    "3:8": { glyph: ".", color: "d" },
};

/** Stateful Pi helpers must come from the loaded extension entry, not a dependency copy. */
export interface HeaderOptions {
    readonly version: string;
    readonly piVersion: string;
    readonly keyText: typeof keyText;
}

function moonLines(theme: Theme): string[] {
    const colors = moonPalette(theme);
    const pixel = (row: number, column: number) => {
        const key = moonPixels[row]?.[column];
        return key && key !== " " ? colors[key as MoonKey] : undefined;
    };
    const lines: string[] = [];
    for (let row = 0; row < moonPixels.length; row += 2) {
        let line = "";
        for (let column = 0; column < logoWidth; column++) {
            const top = pixel(row, column);
            const bottom = pixel(row + 1, column);
            const star = stars[`${row / 2}:${column}`];
            if (top) line += theme.style("▀", { fg: top, bg: bottom });
            else if (bottom) line += theme.style("▄", { fg: bottom });
            else if (star) line += theme.style(star.glyph, { fg: colors[star.color] });
            else line += " ";
        }
        lines.push(line);
    }
    return lines;
}

/** Put two blocks side by side. The shorter block is centred vertically. */
function sideBySide(left: string[], leftWidth: number, right: string[], gap: number): string[] {
    const height = Math.max(left.length, right.length);
    const leftTop = Math.floor((height - left.length) / 2);
    const rightTop = Math.floor((height - right.length) / 2);
    return Array.from({ length: height }, (_, row) => {
        const l = left[row - leftTop] ?? " ".repeat(leftWidth);
        const r = right[row - rightTop] ?? "";
        return `${l}${" ".repeat(gap)}${r}`;
    });
}

/** Fill items down the columns (two at most). Fall back to one wrapped column if too narrow. */
function columns(items: string[], available: number, gap: number): string[] {
    if (items.length === 0) return [];
    const itemWidth = Math.max(...items.map(visibleWidth));
    const count = Math.max(1, Math.min(2, Math.floor((available + gap) / (itemWidth + gap))));
    if (count === 1) return items.flatMap((item) => wrapTextWithAnsi(item, available));
    const rows = Math.ceil(items.length / count);
    return Array.from({ length: rows }, (_, row) =>
        Array.from({ length: count }, (_, col) => items[col * rows + row] ?? "")
            .map((item, col, all) =>
                col < all.length - 1
                    ? item + " ".repeat(itemWidth - visibleWidth(item) + gap)
                    : item,
            )
            .join(""),
    );
}

/** Pack items into lines. An item is never split across two lines. */
function packItems(items: string[], available: number, gap: number): string[] {
    const lines: string[] = [];
    let current = "";
    for (const item of items.filter(Boolean)) {
        const next = current ? `${current}${" ".repeat(gap)}${item}` : item;
        if (current && visibleWidth(next) > available) {
            lines.push(current);
            current = item;
        } else {
            current = next;
        }
    }
    if (current) lines.push(current);
    return lines;
}

/** Passive header/preview; Pi owns repainting, expansion and the current Theme object. */
export function createLuneHeader(
    theme: Theme,
    { version, piVersion, keyText }: HeaderOptions,
): Component & { setExpanded(expanded: boolean): void } {
    let expanded = false;
    const dim = (value: string) => theme.fg("dim", value);

    return {
        setExpanded(value) {
            expanded = value;
        },
        // Render from live theme/keybinding values so invalidation needs no cache cleanup.
        invalidate() {},
        render(width) {
            const inner = width - indent;
            if (inner < 1) return [];
            // Read per render: Pi may hand over a live theme that a palette switch changes.
            const moon = moonPalette(theme);
            const light = theme.appearance === "light";
            const keyColor = light ? moon.b : moon.p;
            const taglineColor = light ? moon.d : moon.i;
            const hint = (key: string, action: string) =>
                key ? `${theme.style(key, { fg: keyColor })} ${theme.fg("muted", action)}` : "";

            // Group 1: who this is. Group 2: what to type. Group 3: which keys to press.
            const identity = [
                `${theme.bold(theme.fg("text", "L U N E"))}  ${dim(`theme v${version} · pi v${piVersion}`)}`,
                theme.style("Light tools. Deeper work.", { fg: taglineColor }),
            ];
            const hintGroups = [
                [
                    hint("/", "commands"),
                    hint("!", "shell"),
                    hint("/lune-core-settings", "settings"),
                ],
                [
                    hint(keyText("app.tools.expand"), expanded ? "less" : "more"),
                    hint(keyText("app.interrupt"), "interrupt"),
                    hint(keyText("app.model.select"), "models"),
                ],
            ];

            const logo = moonLines(theme);
            // Five lines of text, the same height as the five-line logo.
            const info = [
                ...identity,
                "",
                ...hintGroups.map((group) => packItems(group, Infinity, 3)[0] ?? ""),
            ];
            const infoWidth = Math.max(...info.map(visibleWidth));
            const body =
                inner >= logoWidth + logoGap + infoWidth
                    ? sideBySide(logo, logoWidth, info, logoGap)
                    : [
                          ...logo,
                          "",
                          ...identity.flatMap((line) => wrapTextWithAnsi(line, inner)),
                          "",
                          ...hintGroups.flatMap((group) => packItems(group, inner, 3)),
                      ];

            const lines = [...body];
            if (expanded) {
                const shortcuts = [
                    hint(keyText("app.clear"), "clear (twice: exit)"),
                    hint(keyText("app.exit"), "exit on empty editor"),
                    hint(keyText("app.suspend"), "suspend"),
                    hint(keyText("app.thinking.cycle"), "cycle thinking level"),
                    hint(
                        [keyText("app.model.cycleForward"), keyText("app.model.cycleBackward")]
                            .filter(Boolean)
                            .join(" / "),
                        "cycle models",
                    ),
                    hint(keyText("app.tools.expand"), "expand tools and help"),
                    hint(keyText("app.thinking.toggle"), "expand thinking"),
                    hint(keyText("tui.editor.deleteToLineEnd"), "delete to line end"),
                    hint(keyText("app.editor.external"), "external editor"),
                    hint(keyText("app.message.followUp"), "queue follow-up"),
                    hint(keyText("app.message.dequeue"), "edit queued messages"),
                    hint(keyText("app.clipboard.pasteImage"), "paste image or file"),
                    hint("!!", "shell, not in context"),
                    hint("drop files", "attach"),
                ].filter(Boolean);
                lines.push("", dim("Shortcuts"), ...columns(shortcuts, inner, 3));
            }

            const pad = " ".repeat(indent);
            const space = Array.from({ length: verticalPadding }, () => "");
            return [...space, ...lines.map((line) => (line ? pad + line : line)), ...space].map(
                (line) => truncateToWidth(line, width, ""),
            );
        },
    };
}
