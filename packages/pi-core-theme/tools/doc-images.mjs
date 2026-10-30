/**
 * Turn real component output into the same SVG/PNG terminal frames as Ask Question.
 * Fixtures stay offline and settings use a temporary sandbox, never the user's files.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Theme, initTheme } from "@earendil-works/pi-coding-agent";
import { colorToHex, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import {
    createDefinedSettingsSection,
    getSettingsPanelRegistry,
} from "@lune_99/pi-lune-extensions-core/panel/host";
import { openSettingsPanel } from "@lune_99/pi-lune-extensions-core/panel/tui";
import { createSettingsSandbox } from "@lune_99/pi-lune-extensions-core/testing";

const darkFile = new URL(
    "./modes/interactive/theme/dark.json",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const dark = JSON.parse(readFileSync(darkFile, "utf8"));
const backgrounds = new Set([
    "selectedBg",
    "searchMatchBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
]);

/** Use actual Pi tokens with explicit truecolor output, independent of the invoking terminal. */
export function makeTheme(definition = dark) {
    const colors = Object.entries(definition.colors).map(([key, value]) => [
        key,
        colorToHex(parseColor(definition.vars[value] ?? value)),
    ]);
    initTheme("dark", false);
    return new Theme(
        Object.fromEntries(colors.filter(([key]) => !backgrounds.has(key))),
        Object.fromEntries(colors.filter(([key]) => backgrounds.has(key))),
        "truecolor",
        { name: definition.name, appearance: definition.appearance },
    );
}

/** Capture the production settings panel through its public UI entry, with isolated storage. */
export async function settingsFrame({
    definition,
    panel,
    theme,
    values = {},
    keys = [],
    width = 106,
}) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-doc-images-" });
    let release;
    let component;
    let lines;
    try {
        const lease = await sandbox.acquire(definition);
        for (const [key, value] of Object.entries(values)) await lease.settings.set(key, value);
        const ctx = {
            mode: "tui",
            hasUI: true,
            cwd: sandbox.cwd,
            thinkingLevel: "medium",
            modelRegistry: { find: () => undefined },
            ui: {
                theme,
                custom: async (factory) => {
                    component = factory(
                        { terminal: { rows: 42, columns: width }, requestRender() {} },
                        theme,
                        {},
                        () => {},
                    );
                    for (const key of keys) component.handleInput(key);
                    lines = component.render(width);
                },
            },
        };
        release = getSettingsPanelRegistry().register(
            ctx.ui,
            createDefinedSettingsSection(lease.settings, panel),
        );
        await openSettingsPanel(ctx, { section: panel.id });
        return lines;
    } finally {
        component?.dispose();
        release?.();
        await sandbox.dispose();
    }
}

const ansi16 = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
];
function color256(index) {
    if (index < 16) return ansi16[index];
    if (index < 232) {
        const n = index - 16;
        const level = (v) => (v === 0 ? 0 : 55 + v * 40);
        return `#${[Math.floor(n / 36), Math.floor((n % 36) / 6), n % 6].map((v) => level(v).toString(16).padStart(2, "0")).join("")}`;
    }
    return `#${(8 + (index - 232) * 10).toString(16).padStart(2, "0").repeat(3)}`;
}

const escape = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[a-zA-Z]/g;
function runs(line) {
    const output = [];
    let state = {};
    let last = 0;
    const push = (value) => {
        if (value) output.push({ text: value, ...state });
    };
    escape.lastIndex = 0;
    for (let match = escape.exec(line); match; match = escape.exec(line)) {
        push(line.slice(last, match.index));
        last = match.index + match[0].length;
        // Cursor and hyperlink controls have no visual representation in a still frame.
        if (match[1] === undefined) continue;
        const codes = match[1] === "" ? [0] : match[1].split(";").map(Number);
        for (let i = 0; i < codes.length; i++) {
            const code = codes[i];
            if (code === 0) state = {};
            else if (code === 1) state.bold = true;
            else if (code === 2) state.dim = true;
            else if (code === 3) state.italic = true;
            else if (code === 4) state.underline = true;
            else if (code === 7) state.inverse = true;
            else if (code === 9) state.strike = true;
            else if (code === 22) {
                state.bold = false;
                state.dim = false;
            } else if (code === 23) state.italic = false;
            else if (code === 24) state.underline = false;
            else if (code === 27) state.inverse = false;
            else if (code === 29) state.strike = false;
            else if (code === 39) delete state.fg;
            else if (code === 49) delete state.bg;
            else if (code >= 30 && code <= 37) state.fg = ansi16[code - 30];
            else if (code >= 40 && code <= 47) state.bg = ansi16[code - 40];
            else if (code >= 90 && code <= 97) state.fg = ansi16[code - 90 + 8];
            else if (code >= 100 && code <= 107) state.bg = ansi16[code - 100 + 8];
            else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
                state[code === 38 ? "fg" : "bg"] = color256(codes[i + 2]);
                i += 2;
            } else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
                state[code === 38 ? "fg" : "bg"] = `#${codes
                    .slice(i + 2, i + 5)
                    .map((v) => v.toString(16).padStart(2, "0"))
                    .join("")}`;
                i += 4;
            } else throw new Error(`Unsupported terminal style: ${code}`);
        }
    }
    push(line.slice(last));
    return output;
}

const xml = (value) =>
    value.replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
    );
const CELL = 8.43;
const LINE = 19.4;
const PAD = 18;
const BAR = 34;

/** `rowBackgrounds` paints whole rows, like a terminal whose default background a palette set. */
function toSvg({ title, lines, theme, background = "#181a1b", rowBackgrounds = [] }) {
    if (!lines?.length) throw new Error(`Empty documentation frame: ${title}`);
    const width = Math.max(...lines.map(visibleWidth)) * CELL + PAD * 2;
    const height = lines.length * LINE + PAD * 2 + BAR;
    const foreground = colorToHex(theme.colors.text);
    const body = lines
        .map((line, row) => {
            const y = BAR + PAD + row * LINE;
            const rectangles = [];
            const text = [];
            let column = 0;
            for (const run of runs(line)) {
                const cells = visibleWidth(run.text);
                if (!cells) continue;
                const x = PAD + column * CELL;
                const fg = run.inverse
                    ? (run.bg ?? rowBackgrounds[row] ?? background)
                    : (run.fg ?? foreground);
                const bg = run.inverse ? (run.fg ?? foreground) : run.bg;
                if (bg)
                    rectangles.push(
                        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(cells * CELL).toFixed(2)}" height="${LINE}" fill="${bg}"/>`,
                    );
                const decoration = [
                    run.underline ? "underline" : "",
                    run.strike ? "line-through" : "",
                ]
                    .filter(Boolean)
                    .join(" ");
                const attributes = `${run.bold ? ' font-weight="600"' : ""}${run.italic ? ' font-style="italic"' : ""}${run.dim ? ' opacity="0.65"' : ""}${decoration ? ` text-decoration="${decoration}"` : ""}`;
                // Explicit cell positions keep Unicode and font substitutions on the terminal grid.
                text.push(
                    `<text x="${x.toFixed(2)}" y="${(y + LINE * 0.72).toFixed(2)}" fill="${fg}" textLength="${(cells * CELL).toFixed(2)}" lengthAdjust="spacingAndGlyphs"${attributes}>${xml(run.text)}</text>`,
                );
                column += cells;
            }
            return rectangles.join("") + text.join("");
        })
        .join("\n");
    // One rectangle per run of equal rows: per-row rectangles leave anti-aliased seams between them.
    const bands = [];
    for (let row = 0; row < lines.length; row++) {
        const fill = rowBackgrounds[row];
        if (!fill || fill === rowBackgrounds[row - 1]) continue;
        let end = row;
        while (rowBackgrounds[end + 1] === fill) end++;
        bands.push(
            `<rect x="0" y="${(BAR + PAD + row * LINE).toFixed(2)}" width="${width.toFixed(2)}" height="${((end - row + 1) * LINE).toFixed(2)}" fill="${fill}"/>`,
        );
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Menlo, FiraCode Nerd Font Mono, monospace" font-size="14" xml:space="preserve" role="img" aria-label="${xml(title)}">
<title>${xml(title)}</title>
<rect width="${width}" height="${height}" rx="10" fill="${background}"/>
<rect width="${width}" height="${BAR}" rx="10" fill="${colorToHex(theme.colors.borderMuted)}" opacity="0.25"/>
<circle cx="24" cy="17" r="5" fill="#ff5f57"/><circle cx="42" cy="17" r="5" fill="#febc2e"/><circle cx="60" cy="17" r="5" fill="#28c840"/>
<text x="80" y="22" fill="${colorToHex(theme.colors.muted)}" font-size="13">${xml(title)}</text>
${bands.length ? `${bands.join("")}\n` : ""}${body}
</svg>\n`;
}

export function writeFrames(root, frames) {
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    for (const frame of frames) {
        const svg = join(docs, `${frame.name}.svg`);
        writeFileSync(svg, toSvg(frame));
        execFileSync("rsvg-convert", ["-z", "2", "-o", join(docs, `${frame.name}.png`), svg]);
        console.log(`docs/${frame.name}.svg + .png (${frame.lines.length} rows)`);
    }
}
