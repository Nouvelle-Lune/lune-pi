/** Real header, activity cards and diff components with fixed, offline example content. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keyText, VERSION } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, truncateToWidth } from "@earendil-works/pi-tui";
import { KEYBINDINGS } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createLuneHeader } from "../src/header.ts";
import { ActivityCard } from "../src/renderer/activity-card.ts";
import { DEFAULT_CONFIG, setConfig } from "../src/config/config.ts";
import { renderEditDiffResult } from "../src/renderer/tool/diff/diff-edit-render.ts";
import { palettes } from "../src/palettes/index.ts";
import { makeTheme, writeFrames } from "./doc-images.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const dark = JSON.parse(
    readFileSync(new URL("../src/palettes/pi-core-dark.json", import.meta.url), "utf8"),
);
const light = JSON.parse(
    readFileSync(new URL("../src/palettes/pi-core-light.json", import.meta.url), "utf8"),
);
const options = { version, piVersion: VERSION, keyText };
// A standalone renderer needs Pi's default key registry to display its real shortcut hints.
setKeybindings(new KeybindingsManager(KEYBINDINGS));
setConfig({ ...DEFAULT_CONFIG, enabled: true, mode: "on" });

function overview(theme) {
    const card = new ActivityCard(
        {
            title: "tools",
            entries: [
                {
                    name: "read",
                    summary: "src/retry.ts",
                    status: "done",
                    durationMs: 8,
                    output: "Loaded the current retry policy.",
                },
                {
                    name: "edit",
                    summary: "src/retry.ts",
                    status: "done",
                    durationMs: 12,
                    output: "Updated the retry limit and delay.",
                },
                {
                    name: "bash",
                    summary: "npm test",
                    status: "done",
                    durationMs: 842,
                    output: "24 tests passed",
                },
            ],
        },
        true,
        theme,
        () => "ctrl+o",
    );
    return [...createLuneHeader(theme, options).render(108), ...card.render(108)];
}

/** One band per palette, painted with its own background as the theme paints the terminal. */
function gallery() {
    const lines = [];
    const rowBackgrounds = [];
    for (const { label, description, definition } of Object.values(palettes)) {
        const theme = makeTheme(definition);
        // The header's first five rows open with the one-column indent and the ten-column crescent.
        const moon = createLuneHeader(theme, options)
            .render(120)
            .slice(1, 6)
            .map((line) => truncateToWidth(line, 11, ""));
        const thinking = [
            "thinkingOff",
            "thinkingMinimal",
            "thinkingLow",
            "thinkingMedium",
            "thinkingHigh",
            "thinkingXhigh",
            "thinkingMax",
        ];
        const info = [
            `${theme.bold(theme.fg("text", label))}  ${theme.fg("muted", description)}  ${theme.fg("dim", definition.name)}`,
            `${theme.fg("syntaxKeyword", "const")} ${theme.fg("syntaxVariable", "delay")} ${theme.fg("syntaxOperator", "=")} ${theme.fg("syntaxFunction", "backoff")}${theme.fg("syntaxPunctuation", "(")}${theme.fg("syntaxString", '"retry"')}${theme.fg("syntaxPunctuation", ",")} ${theme.fg("syntaxNumber", "500")}${theme.fg("syntaxPunctuation", ")")} ${theme.fg("syntaxComment", "// ms")}`,
            `${theme.fg("success", "●")} ${theme.fg("toolTitle", "read")} ${theme.fg("muted", "src/retry.ts")} ${theme.fg("dim", "· 8ms")}   ${theme.fg("error", "●")} ${theme.fg("toolTitle", "bash")} ${theme.fg("muted", "npm test")} ${theme.fg("dim", "· 1 failed")}   ${theme.fg("warning", "▲ rate limited")}`,
            `${theme.fg("toolDiffAdded", "+ attempts: 3")}   ${theme.fg("toolDiffRemoved", "- attempts: 1")}   ${theme.fg("mdLink", "docs/retry.md")}`,
            `${thinking.map((token) => theme.fg(token, "━━━")).join("")} ${theme.fg("dim", "thinking off → max")}`,
        ];
        const band = ["", ...moon.map((line, row) => `${line}    ${info[row]}`), ""];
        lines.push(...band);
        rowBackgrounds.push(...band.map(() => definition.vars.bg));
    }
    return { lines, rowBackgrounds };
}

const theme = makeTheme(dark);
const diff = renderEditDiffResult(
    {
        diff: "  1 export const retryPolicy = {\n- 2     attempts: 1,\n+ 2     attempts: 3,\n- 3     delayMs: 100,\n+ 3     delayMs: 500,\n  4 };",
        firstChangedLine: 2,
    },
    { expanded: true, filePath: "src/retry.ts" },
    { ...DEFAULT_CONFIG, diffViewMode: "split" },
    theme,
    "",
);

writeFrames(root, [
    {
        name: "theme-overview",
        title: "pi — Light tools. Deeper work.",
        theme,
        background: dark.vars.bg,
        lines: overview(theme),
    },
    {
        name: "theme-light",
        title: "pi — moonlight, in a lighter palette",
        theme: makeTheme(light),
        background: light.vars.bg,
        lines: overview(makeTheme(light)),
    },
    {
        name: "theme-palettes",
        title: "pi — ten palettes",
        theme,
        background: dark.vars.bg,
        ...gallery(),
    },
    {
        name: "theme-diff",
        title: "pi — see the change before reading the whole file",
        theme,
        background: dark.vars.bg,
        lines: diff.render(108),
    },
]);
