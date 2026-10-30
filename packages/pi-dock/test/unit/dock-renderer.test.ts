import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    stripTerminalSequences,
    truncateToWidth,
    visibleWidth,
    type Component,
} from "@earendil-works/pi-tui";

import { DockView, renderDockLine, resolveSnapshotLevel } from "../../src/dock-renderer.ts";
import { identityTheme, textComponent } from "../harness.ts";

const levels = {
    base: textComponent("● Shell"),
    detail: textComponent("● Shell · 3 running"),
    full: textComponent("● Shell · 3 running · npm test · 14s"),
};

const shell = { id: "shell", snapshot: levels };
const ask = { id: "ask", snapshot: { base: textComponent("○ Ask") } };

function modules(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        id: `item-${index}`,
        snapshot: { base: textComponent(`item${index}`) },
    }));
}

/** Records the focus marker and background spans, so a test can see exactly what the dock paints. */
function createSelectionTheme(): {
    theme: Theme;
    backgrounds: string[];
    accents: string[];
} {
    const backgrounds: string[] = [];
    const accents: string[] = [];
    const theme = {
        fg: (color: string, text: string) => {
            if (color === "accent") accents.push(text);
            return text;
        },
        bg: (_color: string, text: string) => {
            backgrounds.push(text);
            return text;
        },
        bold: (text: string) => text,
        style: (text: string) => text,
    } as unknown as Theme;
    return { theme, backgrounds, accents };
}

/** The columns the blurred row gives the cell holding `text`, marker and padding included. */
function cellSpan(row: string, text: string): { start: number; width: number } {
    const plain = stripTerminalSequences(row);
    const content = plain.indexOf(text);
    const separator = plain.indexOf(" │ ", content);
    const start = content - 2;
    return { start, width: (separator < 0 ? plain.length : separator) - start };
}

function highlightedWidth(backgrounds: readonly string[]): number {
    return backgrounds.reduce((total, part) => total + visibleWidth(part), 0);
}

describe("dock renderer", () => {
    it("resolves a display mode to the most detailed complete level available", () => {
        const cases = [
            [levels, "base", levels.base],
            [levels, "detail", levels.detail],
            [levels, "full", levels.full],
            // A missing level degrades downward instead of mixing fragments of two levels.
            [{ base: levels.base, detail: levels.detail }, "full", levels.detail],
            [{ base: levels.base }, "base", levels.base],
            [{ base: levels.base }, "detail", levels.base],
            [{ base: levels.base }, "full", levels.base],
        ] as const;

        for (const [snapshot, mode, expected] of cases) {
            assert.strictEqual(resolveSnapshotLevel(snapshot, mode), expected);
        }
    });

    it("composes one row from plugin-rendered cells joined by a dim separator", () => {
        const lines = renderDockLine([shell, ask], 120, identityTheme, undefined, "full");

        assert.equal(lines.length, 1);
        assert.match(lines[0]!, /^ {3}● Shell · 3 running · npm test · 14s +│ {3}○ Ask +$/);
        assert.equal(visibleWidth(lines[0]!), 120, "the cells pad out their whole allocation");
    });

    it("never exceeds the requested width, including with wide characters", () => {
        const wide = modules(8).map((entry) => ({
            ...entry,
            snapshot: { base: textComponent("中文🙂 shell") },
        }));
        const view = new DockView();

        for (const width of [1, 5, 14, 40, 80, 200]) {
            const lines = view.render(wide, width, identityTheme, "item-7");
            assert.equal(lines.length, 1, `width ${width} must still produce one row`);
            assert.ok(
                visibleWidth(lines[0]!) <= width,
                `width ${width} row is wider than the terminal: ${JSON.stringify(lines[0])}`,
            );
        }
    });

    it("fills the terminal width when the cells exceed their allocation", () => {
        const full = {
            base: { render: (width: number) => ["#".repeat(width)], invalidate() {} },
        };
        const entries = [0, 1, 2].map((index) => ({ id: `item-${index}`, snapshot: full }));

        for (const width of [40, 41, 80, 200]) {
            const row = renderDockLine(entries, width, identityTheme)[0]!;
            assert.equal(
                visibleWidth(row),
                width,
                `row ${width} must spend the whole width budget`,
            );
        }
    });

    it("allocates the same cell width whether or not an item is selected", () => {
        const allocated: number[] = [];
        const measuring: Component = {
            render: (width) => {
                allocated.push(width);
                return [truncateToWidth("中文🙂 shell", width)];
            },
            invalidate() {},
        };
        const entries = modules(2).map((entry) => ({ ...entry, snapshot: { base: measuring } }));
        const view = new DockView();

        view.render(entries, 80, identityTheme);
        const unfocused = allocated.splice(0);

        view.render(entries, 80, identityTheme, "item-0");
        assert.deepEqual(allocated, unfocused, "selecting a cell must not resize its neighbors");
    });

    it("scrolls the window only as far as the selection needs", () => {
        const entries = modules(6);
        const view = new DockView();
        const row = (selectedId?: string) => view.render(entries, 40, identityTheme, selectedId)[0];

        assert.equal(row(), "   item0    │   item1    │   item2    3›");
        assert.equal(
            row("item-1"),
            "   item0    │ ❯ item1    │   item2    3›",
            "selecting inside the window must not scroll it",
        );
        assert.equal(
            row("item-3"),
            " ‹1   item1   │   item2   │ ❯ item3   2›",
            "a selection past the edge must scroll by one cell and count both sides",
        );
        assert.equal(
            row("item-5"),
            " ‹3   item3    │   item4    │ ❯ item5   ",
            "the selected cell must stay inside the window",
        );
        assert.equal(
            row("item-0"),
            " ❯ item0    │   item1    │   item2    3›",
            "selecting before the window must scroll back to the start",
        );
    });

    it("places the focus mark at the selected cell start and reserves its columns in every cell", () => {
        const entries = modules(3);
        const view = new DockView();
        const blurred = view.render(entries, 60, identityTheme)[0]!;
        const focused = view.render(entries, 60, identityTheme, "item-1")[0]!;

        assert.equal(focused, "   item0            │ ❯ item1            │   item2          ");
        assert.equal(visibleWidth(focused), 60);
        assert.equal(focused.replace("❯", " "), blurred, "focus must not move any other cell");
        assert.equal(focused.indexOf("❯"), blurred.indexOf("item1") - 2);
        assert.doesNotMatch(blurred, /❯/, "a blurred dock draws no pointer");
        assert.doesNotMatch(focused, /enter open/, "key hints belong to the footer row");
    });

    it("fills the selected cell's whole allocation with its background and keeps its colors", () => {
        const colored = {
            id: "warn",
            snapshot: { base: textComponent("\x1b[33m◐\x1b[39m Shell") },
        };
        const entries = [colored, ...modules(2)];
        const blurredRow = new DockView().render(entries, 60, identityTheme)[0]!;
        const recording = createSelectionTheme();
        const focusedRow = new DockView().render(entries, 60, recording.theme, "warn")[0]!;
        const cell = cellSpan(blurredRow, "◐");

        assert.deepEqual(recording.accents, ["❯ "], "only the pointer takes the accent color");
        assert.ok(recording.backgrounds[0]!.startsWith("❯ "), "the pointer opens the highlight");
        assert.equal(highlightedWidth(recording.backgrounds), cell.width);
        assert.equal(
            stripTerminalSequences(focusedRow).indexOf("❯"),
            cell.start,
            "the marker sits at the cell start",
        );
        assert.match(
            focusedRow,
            /\x1b\[33m◐\x1b\[39m Shell/,
            "the status foreground colors survive the highlight",
        );
        assert.match(recording.backgrounds.at(-1)!, / +$/, "the highlight covers the padding");
        assert.equal((focusedRow.match(/❯/g) ?? []).length, 1, "unselected cells draw no pointer");

        const blurred = createSelectionTheme();
        new DockView().render(entries, 60, blurred.theme);
        assert.deepEqual(blurred.backgrounds, [], "a blurred dock draws no background");
    });

    it("reopens the highlight after a plugin's own ANSI reset", () => {
        const reset = { id: "reset", snapshot: { base: textComponent("a\x1b[0mb") } };
        const entries = [reset, ...modules(2)];
        const blurredRow = new DockView().render(entries, 60, identityTheme)[0]!;
        const recording = createSelectionTheme();
        const focusedRow = new DockView().render(entries, 60, recording.theme, "reset")[0]!;

        assert.ok(recording.backgrounds.length > 1, "a reset must split the highlight");
        assert.ok(focusedRow.includes("a\x1b[0mb"), "the plugin's own output is unchanged");
        assert.equal(highlightedWidth(recording.backgrounds), cellSpan(blurredRow, "a").width);
    });

    it("keeps the selected marker visible in one row at narrow widths", () => {
        const entries = modules(6);
        const view = new DockView();

        for (const width of [1, 2, 3, 5, 7, 8, 12, 14]) {
            const lines = view.render(entries, width, identityTheme, "item-2");
            assert.equal(lines.length, 1, `width ${width} must still produce one row`);
            const row = stripTerminalSequences(lines[0]!);
            assert.ok(visibleWidth(row) <= width, `width ${width}: ${JSON.stringify(row)}`);
            assert.ok(
                row.includes("❯"),
                `width ${width} must keep the marker: ${JSON.stringify(row)}`,
            );
        }

        // Below eight columns the overflow counts would push the marker aside, so they give way.
        const narrow = stripTerminalSequences(view.render(entries, 7, identityTheme, "item-2")[0]!);
        const wider = stripTerminalSequences(view.render(entries, 8, identityTheme, "item-2")[0]!);

        assert.doesNotMatch(narrow, /[‹›]/);
        assert.match(wider, /^ ‹2 ❯/);
    });

    it("rejects a level that does not publish exactly one physical line", () => {
        for (const lines of [[], ["a", "b"], ["a\nb"], ["a\rb"]]) {
            assert.throws(
                () =>
                    renderDockLine(
                        [
                            {
                                id: "invalid",
                                snapshot: { base: { render: () => lines, invalidate() {} } },
                            },
                        ],
                        80,
                        identityTheme,
                    ),
                /exactly one line/,
            );
        }
    });

    it("never forwards input to snapshot components", () => {
        let forwarded = 0;
        const passive: Component = {
            ...textComponent("snapshot"),
            handleInput() {
                forwarded++;
            },
        };

        renderDockLine(
            [{ id: "passive", snapshot: { base: passive } }],
            80,
            identityTheme,
            "passive",
        );

        assert.equal(forwarded, 0, "keyboard input belongs to the controller, not to snapshots");
    });

    it("renders no row without contributions or without width", () => {
        assert.deepEqual(renderDockLine([], 80, identityTheme), []);
        assert.deepEqual(renderDockLine([shell], 0, identityTheme), []);
    });
});
