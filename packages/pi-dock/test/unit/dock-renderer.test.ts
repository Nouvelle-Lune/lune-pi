import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
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
            assert.equal(visibleWidth(row), width, `row ${width} must spend the whole width budget`);
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
        assert.deepEqual(
            allocated,
            unfocused,
            "selecting a cell must not resize its neighbors",
        );
    });

    it("scrolls the window only as far as the selection needs", () => {
        const entries = modules(6);
        const view = new DockView();

        assert.deepEqual(view.render(entries, 40, identityTheme), [" item0 │ item1 │ item2 3›"]);
        assert.match(
            view.render(entries, 40, identityTheme, "item-1")[0]!,
            /^❯item0 │ item1 │ item2/,
            "selecting inside the window must not scroll it",
        );
        assert.match(
            view.render(entries, 40, identityTheme, "item-3")[0]!,
            /^❯‹1 item1 │ item2 │ item3 2›/,
            "a selection past the edge must scroll by one cell and count both sides",
        );
        assert.match(
            view.render(entries, 40, identityTheme, "item-5")[0]!,
            /^❯‹3 item3 │ item4 │ item5/,
            "the selected cell must stay inside the window",
        );
        assert.match(
            view.render(entries, 40, identityTheme, "item-0")[0]!,
            /^❯item0 │ item1 │ item2 3›/,
            "selecting before the window must scroll back to the start",
        );
    });

    it("marks the selected cell with a gutter and draws no key hints", () => {
        const entries = modules(6);
        const view = new DockView();
        const focused = view.render(entries, 120, identityTheme, "item-5")[0]!;
        const unfocused = view.render(entries, 120, identityTheme)[0]!;

        assert.ok(focused.startsWith("❯"), "the selected cell must carry the focus mark");
        assert.ok(unfocused.startsWith(" "), "an unfocused dock must keep the gutter blank");
        assert.doesNotMatch(focused, /enter open/, "key hints belong to the footer rule");
        assert.equal(
            focused.length,
            focused.trimEnd().length,
            "the row must not be padded out to the terminal width",
        );
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

        renderDockLine([{ id: "passive", snapshot: { base: passive } }], 80, identityTheme, "passive");

        assert.equal(forwarded, 0, "keyboard input belongs to the controller, not to snapshots");
    });

    it("renders no row without contributions or without width", () => {
        assert.deepEqual(renderDockLine([], 80, identityTheme), []);
        assert.deepEqual(renderDockLine([shell], 0, identityTheme), []);
    });
});
