import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ContextUsage, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createPalette } from "../src/palette.ts";
import { palettes, type PaletteName } from "../src/palettes/index.ts";
import { createContextPanel } from "../src/ui/context-browser.ts";

const categories = [
    { label: "System prompt", tokens: 1200, content: "## Runtime\n\nSystem instructions." },
    {
        label: "Memory",
        tokens: 600,
        content: "## /project/AGENTS.md\n\nUse the active theme and preserve the full context.",
    },
    { label: "Skills", tokens: 400, content: "Skills content." },
    {
        label: "Tool definitions",
        tokens: 800,
        content: '## Definition: read\n\n```json\n{\n    "name": "read"\n}\n```',
    },
    { label: "Tool results", tokens: 2400, content: "Tool results." },
    { label: "Messages", tokens: 1600, content: "## User\n\nConversation content." },
];
const summary: ContextUsage = { tokens: 32000, contextWindow: 128000, percent: 25 };

function fixture(usage = summary, parts = categories) {
    initTheme("dark");
    const native = getThemeByName("dark")!;
    let theme: Theme = createPalette("pi-core-dark", native);
    let rows = 36;
    const copied: string[] = [];
    const panel = createContextPanel(usage, parts, {
        theme: () => theme,
        rows: () => rows,
        repaint() {},
        close() {},
        copy: async (text) => {
            copied.push(text);
        },
        notify() {},
    });
    return {
        panel,
        copied,
        theme: () => theme,
        palette: (name: PaletteName) => {
            theme = createPalette(name, native);
        },
        resize: (height: number) => {
            rows = height;
        },
        render: (width = 112) => panel.render(width).map(stripVTControlCharacters),
    };
}

test("the compact overview keeps Pi usage and raw categories without adjustment or repeated accounting", () => {
    // The simplified presentation removes reconciliation rows without changing any fetched category value.
    const runtime = fixture();
    const text = runtime.render().join("\n");
    assert.match(text, /32\.0k \/ 128k tokens/);
    assert.match(text, /25\.0% used · 96\.0k available/);
    assert.match(text, /Pi context usage · category sizes estimated/);
    assert.match(text, /Context window/);
    for (const category of categories) {
        assert.ok(text.includes(category.label));
        assert.ok(text.includes(category.tokens.toLocaleString("en-US")));
    }
    assert.doesNotMatch(text, /adjustment|Category estimate:|Remaining|billing|estimator|▒/i);
    assert.doesNotMatch(text, /\| ---|##|Tab|←|→/);
});

test("every Lune palette and a live palette change repaint the header, selection and document with active semantic tokens", () => {
    // Keep the same open panel so stale row caches cannot hide a palette-change regression.
    const runtime = fixture();
    runtime.render();
    runtime.panel.handleInput("\x1b[B");
    runtime.panel.handleInput("\x1b[B");
    let previousPlain: string[] | undefined;
    const coloredFrames = new Set<string>();
    for (const name of Object.keys(palettes) as PaletteName[]) {
        runtime.palette(name);
        const theme = runtime.theme();
        const frame = runtime.panel.render(112);
        const colored = frame.join("\n");
        assert.ok(colored.includes(theme.fg("accent", "◐ ")));
        assert.ok(colored.includes(theme.bold(theme.fg("mdHeading", "/project/AGENTS.md"))));
        const selectionPrefix = theme.bg("selectedBg", "selection").split("selection")[0]!;
        assert.ok(colored.includes(selectionPrefix));
        const plain = frame.map(stripVTControlCharacters);
        if (previousPlain) assert.deepEqual(plain, previousPlain);
        previousPlain = plain;
        coloredFrames.add(colored);
    }
    assert.equal(coloredFrames.size, Object.keys(palettes).length);
});

test("context documents render headings and code without changing the content copied", async () => {
    // Styling belongs to the display; copying must preserve the original category document.
    const runtime = fixture();
    runtime.render();
    for (let index = 0; index < 4; index++) runtime.panel.handleInput("\x1b[B");
    const text = runtime.render().join("\n");
    assert.match(text, /Definition: read/);
    assert.match(text, /JSON/);
    assert.match(text, /"name": "read"/);
    assert.doesNotMatch(text, /```|##/);
    runtime.panel.handleInput("c");
    await Promise.resolve();
    assert.deepEqual(runtime.copied, [categories[3]!.content]);
});

test("the context frame retains its footer and selection within short and narrow terminals", () => {
    // Resizing must keep navigation and Escape reachable without exceeding the terminal bounds.
    const runtime = fixture();
    runtime.render();
    for (let index = 0; index < 6; index++) runtime.panel.handleInput("\x1b[B");
    for (const rows of [12, 14, 24, 40]) {
        runtime.resize(rows);
        for (const width of [40, 64, 112]) {
            const frame = runtime.render(width);
            assert.ok(frame.length <= rows - 4);
            assert.ok(frame.every((line) => visibleWidth(line) <= width));
            assert.ok(frame.some((line) => line.includes("›")));
            assert.ok(frame.at(-2)!.includes("Esc"));
            assert.match(frame.at(-1)!, /╰/);
        }
    }
});

test("context stays compact in tall terminals and scrolls long category documents within the frame", () => {
    // The context-specific height limit must not grow with the terminal or truncate the document itself.
    const runtime = fixture(
        summary,
        categories.map((category) => ({
            ...category,
            content: Array.from({ length: 100 }, (_, index) => `context-line-${index}`).join("\n"),
        })),
    );
    runtime.panel.handleInput("\x1b[B");
    for (const height of [36, 80]) {
        runtime.resize(height);
        const frame = runtime.render(100);
        assert.equal(frame.length, 24);
        assert.match(frame.join("\n"), /context-line-0/);
        assert.ok(frame.at(-2)!.includes("Esc"));
    }
    runtime.panel.handleInput("\x1b[F");
    assert.match(runtime.render(100).join("\n"), /context-line-99/);
});

function barCells(frame: string[]): string {
    const bar = frame.join("\n").match(/[█░]{5,}/);
    assert.ok(bar, "The overview renders a context-window composition bar");
    return bar[0];
}

test("the colored bar includes remaining capacity calculated from the raw category estimate", () => {
    // The user explicitly chose category-derived composition while retaining Pi usage in the header.
    const runtime = fixture();
    const frame = runtime.render();
    const segments = barCells(frame);
    const used = [...segments].filter((cell) => cell !== "░").length;
    assert.ok(Math.abs(used / segments.length - 7000 / 128000) <= 1 / segments.length);
    assert.ok(segments.endsWith("░"));
    assert.match(frame.join("\n"), /96\.0k available/);
});

test("an empty category estimate leaves the estimated bar empty while preserving Pi usage", () => {
    // The bar and header intentionally use different sources, without fabricating category contributions.
    const runtime = fixture(
        summary,
        categories.map((category) => ({ ...category, tokens: 0 })),
    );
    const frame = runtime.render();
    assert.match(frame.join("\n"), /32\.0k \/ 128k tokens/);
    assert.match(frame.join("\n"), /96\.0k available/);
    assert.match(barCells(frame), /^░+$/);
});

test("categories above Pi usage retain their original amounts and are not clipped to the Pi total", () => {
    // Removing adjustment must not normalize category values or silently clip later colored segments.
    const runtime = fixture({ ...summary, tokens: 4000, percent: 3.125 });
    const frame = runtime.render();
    const text = frame.join("\n");
    assert.match(text, /4\.0k \/ 128k tokens/);
    assert.match(text, /124k available/);
    assert.doesNotMatch(text, /adjustment|exceed/i);
    for (const category of categories)
        assert.ok(text.includes(category.tokens.toLocaleString("en-US")));
    const segments = barCells(frame);
    const used = [...segments].filter((cell) => cell !== "░").length;
    assert.ok(Math.abs(used / segments.length - 7000 / 128000) <= 1 / segments.length);
});

test("zero Pi usage remains zero even with nonzero category estimates", () => {
    // A valid API zero must not be replaced by an estimated total through truthiness checks.
    const frame = fixture({ ...summary, tokens: 0, percent: 0 }).render();
    const text = frame.join("\n");
    assert.match(text, /0 \/ 128k tokens/);
    assert.match(text, /0\.0% used · 128k available/);
    assert.ok(barCells(frame).includes("█"));
});

test("Pi usage above capacity remains unchanged without forcing the category bar full", () => {
    // The API total and percentage stay independent from category-derived composition.
    const frame = fixture({ tokens: 130000, contextWindow: 128000, percent: 101.5625 }).render();
    assert.match(frame.join("\n"), /130k \/ 128k tokens/);
    assert.match(frame.join("\n"), /101\.6% used · 0 available/);
    assert.ok(barCells(frame).includes("░"));
});

test("category estimates above capacity fill the bar without changing their displayed values", () => {
    // Only the finite chart is clipped to capacity; the fetched category amounts remain visible.
    const frame = fixture(
        summary,
        categories.map((category) => ({ ...category, tokens: 200000 })),
    ).render();
    assert.match(frame.join("\n"), /200,000/);
    assert.match(barCells(frame), /^█+$/);
    assert.ok(frame.every((line) => visibleWidth(line) <= 112));
});

test("unknown Pi usage after compaction remains unknown despite available category estimates", () => {
    // Null means that Pi has no trustworthy total yet, rather than that the window is unused.
    const frame = fixture({ ...summary, tokens: null, percent: null }).render();
    const text = frame.join("\n");
    assert.match(text, /\? \/ 128k tokens/);
    assert.match(text, /Pi context usage unknown/);
    assert.match(text, /\?% used · \? available/);
    assert.ok(barCells(frame).includes("█"));
    assert.doesNotMatch(text, /NaN|Infinity/);
});

test("an unknown context window is explicit and does not invent a remaining capacity", () => {
    // A known token count cannot manufacture a missing model capacity.
    const runtime = fixture({ ...summary, contextWindow: 0, percent: null });
    const text = runtime.render().join("\n");
    assert.match(text, /Window size unavailable/);
    assert.match(text, /\? available/);
    assert.doesNotMatch(text, /NaN|Infinity/);
});

test("copying the overview retains exact Pi totals and raw categories without reconciliation text", async () => {
    // Copy and headless output retain the fetched values after the explanatory footer is removed.
    const runtime = fixture();
    runtime.render();
    runtime.panel.handleInput("c");
    await Promise.resolve();
    assert.match(runtime.copied[0]!, /Pi context usage: 32,000 \/ 128,000 tokens/);
    assert.match(runtime.copied[0]!, /Remaining: 96,000 tokens/);
    for (const category of categories)
        assert.ok(
            runtime.copied[0]!.includes(
                `${category.label}: ${category.tokens.toLocaleString("en-US")} estimated tokens`,
            ),
        );
    assert.doesNotMatch(runtime.copied[0]!, /adjustment|Category estimate:|billing|estimator/i);
});
