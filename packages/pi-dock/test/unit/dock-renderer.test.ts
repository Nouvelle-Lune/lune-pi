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

/** The blank column before the cell plus the cell's text: exactly what selection may paint. */
function cellSpan(row: string, text: string): { start: number; width: number } {
    const plain = stripTerminalSequences(row);
    return { start: plain.indexOf(text) - 1, width: visibleWidth(text) + 1 };
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
        assert.deepEqual(renderDockLine([shell, ask], 120, identityTheme, undefined, "full"), [
            " ● Shell · 3 running · npm test · 14s │ ○ Ask",
        ]);
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
        const row = (selectedId?: string) =>
            view.render(entries, 40, identityTheme, selectedId)[0]!;

        assert.equal(row(), " item0 │ item1 │ item2 3›");
        assert.equal(
            row("item-1"),
            " item0 │❯item1 │ item2 3›",
            "selecting inside the window must not scroll it",
        );
        assert.equal(
            row("item-3"),
            "‹1  item1 │ item2 │❯item3 2›",
            "a selection past the edge must scroll by one cell and count both sides",
        );
        assert.equal(
            row("item-5"),
            "‹3  item3 │ item4 │❯item5",
            "the selected cell must stay inside the window",
        );
        assert.equal(
            row("item-0"),
            "❯item0 │ item1 │ item2 3›",
            "selecting before the window must scroll back to the start",
        );
    });

    it("moves the focus mark into the blank column before the selected cell", () => {
        const entries = modules(6);
        const view = new DockView();
        const focused = view.render(entries, 120, identityTheme, "item-5")[0]!;
        const first = view.render(entries, 120, identityTheme, "item-0")[0]!;
        const unfocused = view.render(entries, 120, identityTheme)[0]!;

        assert.match(focused, /^ item0 │ item1 │ item2 │ item3 │ item4 │❯item5$/);
        assert.match(first, /^❯item0 │ item1/);
        assert.equal(unfocused, " item0 │ item1 │ item2 │ item3 │ item4 │ item5");
        assert.equal(focused.replace("❯", " "), unfocused, "the mark must not add a column");
        assert.equal(
            focused.indexOf("❯"),
            unfocused.indexOf("item5") - 1,
            "the mark abuts the selected cell",
        );
        assert.doesNotMatch(focused, /enter open/, "key hints belong to the footer rule");
        assert.equal(
            focused.length,
            focused.trimEnd().length,
            "the row must not be padded out to the terminal width",
        );
    });

    it("paints only the selected cell's pointer and text with its background", () => {
        const colored = {
            id: "warn",
            snapshot: { base: textComponent("\x1b[33m◐\x1b[39m Shell") },
        };
        const entries = [colored, ...modules(2)];
        const blurredRow = new DockView().render(entries, 60, identityTheme)[0]!;
        const recording = createSelectionTheme();
        const focusedRow = new DockView().render(entries, 60, recording.theme, "warn")[0]!;
        const cell = cellSpan(blurredRow, "◐ Shell");
        const plain = stripTerminalSequences(focusedRow);

        assert.deepEqual(recording.accents, ["❯"], "only the pointer takes the accent color");
        assert.ok(recording.backgrounds[0]!.startsWith("❯"), "the pointer opens the highlight");
        assert.equal(highlightedWidth(recording.backgrounds), cell.width);
        assert.equal(
            plain.indexOf("❯"),
            cell.start,
            "the marker sits in the blank column before the cell",
        );
        assert.equal(plain.slice(cell.start, cell.start + cell.width), "❯◐ Shell");
        assert.equal(
            plain.slice(cell.start + cell.width, cell.start + cell.width + 3),
            " │ ",
            "the highlight must not spill into the separator",
        );
        assert.match(
            focusedRow,
            /\x1b\[33m◐\x1b\[39m Shell/,
            "the status foreground colors survive the highlight",
        );
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
        assert.equal(highlightedWidth(recording.backgrounds), cellSpan(blurredRow, "ab").width);
    });

    it("keeps short cells together as the terminal grows", () => {
        const entries = modules(3);
        const narrow = new DockView().render(entries, 60, identityTheme, "item-1")[0]!;
        const wide = new DockView().render(entries, 200, identityTheme, "item-1")[0]!;
        const blurred = new DockView().render(entries, 200, identityTheme)[0]!;
        const recording = createSelectionTheme();
        const highlighted = new DockView().render(entries, 200, recording.theme, "item-1")[0]!;

        assert.equal(wide, narrow, "a wider terminal must not stretch the cells");
        assert.equal(wide, " item0 │❯item1 │ item2");
        assert.doesNotMatch(wide, / {4,}/, "cells must stay together, without blank gaps");
        assert.equal(stripTerminalSequences(highlighted), wide);
        assert.equal(
            highlightedWidth(recording.backgrounds),
            cellSpan(blurred, "item1").width,
            "the background covers only the compact cell",
        );
    });

    it("keeps the focus mark beside its cell at narrow widths", () => {
        const entries = modules(6);
        const row = (width: number) =>
            stripTerminalSequences(
                new DockView().render(entries, width, identityTheme, "item-2")[0]!,
            );

        for (const width of [1, 2, 3, 5, 7, 8, 12, 14]) {
            const line = row(width);
            assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
            assert.match(
                line,
                /^(?:‹2 )?❯/,
                `width ${width} must keep the mark beside the selected cell`,
            );
        }

        // Below eight columns the overflow counts would leave no room for the cell's text.
        assert.equal(row(7), "❯item2");
        assert.equal(row(8), "‹2 ❯. 3›");
        assert.equal(row(12), "‹2 ❯item2 3›");
        assert.equal(row(14), "‹2 ❯item2 3›", "a wider row must not stretch the cells");
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
