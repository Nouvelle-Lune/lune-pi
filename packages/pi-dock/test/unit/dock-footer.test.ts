import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import {
    DOCK_STYLES,
    DockFooter,
    replacesFooter,
    type DockFooterInput,
    type DockLayout,
} from "../../src/dock-footer.ts";
import {
    createLayout,
    createStatus,
    identityTheme,
    textComponent,
    textSnapshot,
} from "../harness.ts";

const HINT_FULL = "←→ select · enter open · esc back";
const HINT_SHORT = "enter open · esc back";
const HINT_MINIMAL = "enter open";

function cells(...ids: string[]): DockFooterInput["entries"] {
    return ids.map((id) => ({ id, snapshot: textSnapshot(id) }));
}

function input(overrides: Partial<DockFooterInput> = {}): DockFooterInput {
    return {
        entries: cells("shells", "questions"),
        status: createStatus(),
        selectedId: undefined,
        mode: "detail",
        layout: createLayout(),
        ...overrides,
    };
}

function render(width: number, overrides: Partial<DockFooterInput> = {}): string[] {
    return new DockFooter()
        .render(width, identityTheme, input(overrides))
        .map(stripTerminalSequences);
}

const rule = (width: number) => "─".repeat(width);

/** The terminal column of every bar, so a model that does not sit on a statistics bar shows as a missing column. */
function barColumns(row: string): number[] {
    const columns: number[] = [];
    let column = 0;
    for (const char of row) {
        if (char === "│") columns.push(column);
        column += visibleWidth(char);
    }
    return columns;
}

describe("dock footer", () => {
    it("rules off the dock row, the info row and the block", () => {
        const lines = render(80);

        assert.equal(lines.length, 5);
        assert.equal(lines[0], rule(80));
        assert.match(lines[1]!, /^ shells │ questions/);
        assert.equal(lines[2], rule(80), "an unfocused dock draws a plain rule under its cells");
        assert.match(lines[3]!, /\/work\/project/);
        assert.equal(lines[4], rule(80));
    });

    it("puts the model's divider on a bar of the info row, so the two rows share it", () => {
        // The divider lands on the cache-hit slot, whose bar is drawn once the provider reports cache traffic.
        const [, dockRow, , infoRow] = render(80, {
            status: createStatus({ usage: { cost: 0.12, cacheRead: 3000, cacheHitRate: 50 } }),
        });

        const modelBar = barColumns(dockRow!).at(-1)!;

        assert.equal(visibleWidth(dockRow!), 80);
        assert.match(dockRow!, / │ +claude-test • high$/);
        assert.ok(barColumns(infoRow!).includes(modelBar), `no info row bar at column ${modelBar}`);
    });

    it("ends the model and its speed at the dock edge while keeping its divider on a statistics bar", () => {
        const status = createStatus({
            tokenSpeed: { tokensPerSecond: 55.8, generating: false },
            usage: { input: 1500, output: 20, cost: 0.12 },
        });
        const suffix = "claude-test • high • 55.8 tok/s";

        const [, ruledRow, , infoRow] = render(120, { status });
        const [, boxedRow] = render(120, {
            status,
            layout: createLayout({ style: "boxed" }),
        });

        assert.equal(visibleWidth(ruledRow!), 120);
        assert.ok(ruledRow!.endsWith(suffix), JSON.stringify(ruledRow));
        assert.ok(barColumns(infoRow!).includes(barColumns(ruledRow!).at(-1)!));
        assert.equal(visibleWidth(boxedRow!), 120);
        assert.ok(boxedRow!.endsWith(`${suffix} │`), JSON.stringify(boxedRow));
    });

    it("takes the rightmost bar that leaves room for the whole model", () => {
        const status = createStatus({ autoCompact: true });
        const withProvider = createStatus({ autoCompact: true, showProvider: true });

        const bare = barColumns(render(120, { status })[1]!).at(-1);
        const named = barColumns(render(120, { status: withProvider })[1]!).at(-1);

        // Context and (auto) take 29 columns from the divider prefix, the cost 10 more. The bare
        // model spans 18 and fits the context slot; the provider moves it to the cost slot.
        assert.deepEqual([bare, named], [120 - 29 + 1, 120 - 39 + 1]);
    });

    it("keeps the model where it is as usage arrives", () => {
        const fresh = render(120, { status: createStatus({ autoCompact: true }) })[1];
        const used = render(120, {
            status: createStatus({
                autoCompact: true,
                usage: {
                    input: 1500,
                    output: 20,
                    cacheRead: 3000,
                    cacheWrite: 400,
                    cost: 0.12,
                    cacheHitRate: 50,
                },
            }),
        })[1];

        assert.equal(used, fresh);
    });

    it("drops the provider before it leaves the bars, once the named model fits no bar within half the row", () => {
        // At 80 columns the widest bar within half the row spans 27 columns: the bare model fits, the named one does not.
        const [, dockRow] = render(80, { status: createStatus({ showProvider: true }) });

        assert.match(dockRow!, / │ +claude-test • high$/);
        assert.doesNotMatch(dockRow!, /anthropic/);
    });

    it("names the provider only when Pi names it", () => {
        const withProvider = render(120, { status: createStatus({ showProvider: true }) })[1]!;
        const without = render(120, { status: createStatus({ showProvider: false }) })[1]!;

        assert.match(withProvider, /\(anthropic\) claude-test • high$/);
        assert.doesNotMatch(without, /anthropic/);
    });

    it("drops the provider first when the model does not fit half the row", () => {
        const model = { provider: "anthropic", id: "x".repeat(30), thinking: "high" };

        const [, dockRow] = render(80, { status: createStatus({ showProvider: true, model }) });

        assert.match(dockRow!, new RegExp(` │ ${model.id} • high$`));
        assert.doesNotMatch(dockRow!, /anthropic/);
    });

    it("truncates a model name that cannot fit even without the provider", () => {
        const model = { provider: "anthropic", id: "y".repeat(80), thinking: "high" };

        const [, dockRow] = render(80, { status: createStatus({ model }) });

        assert.equal(visibleWidth(dockRow!), 80);
        assert.match(dockRow!, / │ y+\.\.\.$/, "the cells keep their half of the row");
        assert.match(dockRow!, /^ shells │ questions/);
    });

    it("draws no model below 40 columns, so the cells keep the whole row", () => {
        const narrow = render(39);
        const wide = render(40);

        assert.doesNotMatch(narrow[1]!, /claude-test/);
        assert.match(wide[1]!, /claude-test/);
    });

    it("right-aligns the model alone when there are no cells", () => {
        const lines = render(60, { entries: [] });

        assert.equal(lines.length, 5);
        assert.equal(visibleWidth(lines[1]!), 60);
        assert.match(lines[1]!, /^ +claude-test • high$/);
        assert.doesNotMatch(lines[1]!, /│/);
        assert.equal(lines[2], rule(60));
    });

    it("omits the dock row and the rule under it with neither cells nor model", () => {
        const lines = render(39, { entries: [] });

        assert.equal(lines.length, 3);
        assert.equal(lines[0], rule(39));
        assert.match(
            lines[1]!,
            / 25k\/200k · 12\.3%$/,
            "the context slot keeps its whole reservation",
        );
        assert.doesNotMatch(
            lines[1]!,
            /\/work\/project/,
            "the directory gives way to the context slot",
        );
        assert.equal(visibleWidth(lines[1]!), 39);
        assert.equal(lines[2], rule(39));
    });

    it("keeps the info row when there is no model at all", () => {
        const lines = render(80, { entries: [], status: createStatus({ model: undefined }) });

        assert.match(lines[1]!, /no-model *$/);
        assert.match(lines[3]!, /\/work\/project/);
    });

    it("marks the selected cell and leaves an unfocused dock unmarked", () => {
        const focused = render(80, { selectedId: "questions" })[1]!;
        const unfocused = render(80)[1]!;

        assert.ok(focused.startsWith("❯"));
        assert.ok(unfocused.startsWith(" "));
    });

    describe("key hints", () => {
        it("ride the rule under the cells while the dock is focused", () => {
            const lines = render(120, { selectedId: "shells" });

            assert.equal(lines[0], rule(120), "the rule above the cells stays plain");
            assert.match(lines[2]!, new RegExp(`^─+ ${HINT_FULL} ─$`));
            assert.equal(visibleWidth(lines[2]!), 120);
            assert.equal(lines.filter((line) => line.includes("enter open")).length, 1);
        });

        it("never take width from the cells or the model", () => {
            const plain = render(120)[1];
            const focused = render(120, { selectedId: "shells" })[1];

            assert.equal(focused?.replace("❯", " "), plain);
        });

        it("degrade to shorter hints as the rule narrows", () => {
            assert.match(
                render(30, { selectedId: "shells" })[2]!,
                new RegExp(`^─+ ${HINT_SHORT} ─$`),
            );
            assert.match(
                render(20, { selectedId: "shells" })[2]!,
                new RegExp(`^─+ ${HINT_MINIMAL} ─$`),
            );
        });

        it("leave a plain rule when no hint fits", () => {
            assert.equal(render(10, { selectedId: "shells" })[2], rule(10));
        });

        it("are never drawn for an unfocused dock", () => {
            for (const width of [10, 20, 30, 80, 120]) {
                const text = render(width).join("\n");
                assert.doesNotMatch(text, /enter open/, `width ${width}`);
            }
        });

        it("are not drawn when the dock row is absent", () => {
            const lines = render(39, { entries: [], selectedId: "shells" });

            assert.doesNotMatch(lines.join("\n"), /enter open/);
        });
    });

    describe("extension statuses", () => {
        it("follow the info row on their own row before the closing rule", () => {
            const lines = render(80, {
                status: createStatus({ extensionStatuses: ["alpha", "beta"] }),
            });

            assert.equal(lines.length, 6);
            assert.match(lines[3]!, /\/work\/project/);
            assert.equal(lines[4], " alpha beta");
            assert.equal(lines[5], rule(80));
        });

        it("add no row when there are none", () => {
            assert.equal(render(80).length, 5);
        });

        it("are truncated to the width", () => {
            const status = createStatus({ extensionStatuses: ["a-status-that-is-far-too-long"] });

            const lines = render(20, { status });

            assert.ok(lines.every((line) => visibleWidth(line) <= 20));
            assert.match(lines.join("\n"), /…/);
        });
    });

    it("renders nothing without width", () => {
        assert.deepEqual(render(0), []);
    });

    it("keeps one scroll window across renders", () => {
        const footer = new DockFooter();
        const entries = cells("item-0", "item-1", "item-2", "item-3", "item-4", "item-5");
        const dockRow = (selectedId: string) =>
            stripTerminalSequences(
                footer.render(39, identityTheme, input({ entries, selectedId }))[1]!,
            );

        assert.match(dockRow("item-5"), /^❯‹3 item-3 │ item-4 │ item-5/);

        assert.match(
            dockRow("item-4"),
            /^❯‹3 item-3 │ item-4 │ item-5/,
            "selecting inside the window must not scroll it",
        );
    });
});

const WIDE_CELLS = ["中文🙂 shell", "问题🙂", "目标"].map((text, index) => ({
    id: `wide-${index}`,
    snapshot: { base: textComponent(text) },
}));

const WIDE_STATUS = createStatus({
    cwd: "/工作/项目",
    branch: "分支🙂",
    sessionName: "会话🙂",
    model: { provider: "供应商", id: "模型🙂-1", thinking: "high" },
    showProvider: true,
    usage: {
        input: 1500,
        output: 20,
        cacheRead: 3000,
        cacheWrite: 400,
        cost: 1.5,
        cacheHitRate: 50,
    },
    autoCompact: true,
    extensionStatuses: ["状态🙂 ok"],
});

/** Classic draws no statistics, so it is given none, as the controller does. */
function renderStyle(
    style: DockLayout["style"],
    width: number,
    overrides: Partial<DockFooterInput> = {},
    layout: Partial<DockLayout> = {},
): string[] {
    return render(width, {
        layout: createLayout({ style, ...layout }),
        status: replacesFooter(style) ? createStatus({ showProvider: true }) : undefined,
        ...overrides,
    });
}

describe("dock footer styles", () => {
    it("takes over Pi's footer for every style except classic", () => {
        const actual = DOCK_STYLES.filter(replacesFooter);

        assert.deepEqual(actual, ["ruled", "boxed", "compact", "minimal"]);
    });

    it("never exceeds the requested width, including with wide characters", () => {
        const footer = new DockFooter();
        const switches = [true, false].flatMap((showModel) =>
            [true, false].flatMap((showWorkspace) =>
                [true, false].map((showUsage) => ({ showModel, showWorkspace, showUsage })),
            ),
        );

        for (const style of DOCK_STYLES) {
            for (const layout of switches) {
                for (const entries of [WIDE_CELLS, []]) {
                    for (const selectedId of [undefined, "wide-2"]) {
                        for (let width = 1; width <= 160; width++) {
                            const lines = footer.render(width, identityTheme, {
                                entries,
                                status: replacesFooter(style) ? WIDE_STATUS : undefined,
                                selectedId,
                                mode: "detail",
                                layout: createLayout({ style, ...layout }),
                            });
                            for (const line of lines) {
                                assert.ok(
                                    visibleWidth(line) <= width,
                                    `${style} ${JSON.stringify(layout)} width ${width} line is wider than the terminal: ${JSON.stringify(line)}`,
                                );
                            }
                        }
                    }
                }
            }
        }
    });

    it("renders nothing without width in every style", () => {
        for (const style of DOCK_STYLES) {
            assert.deepEqual(renderStyle(style, 0), [], style);
        }
    });

    describe("ruled", () => {
        it("lets the rule under the cells close the block when no other row follows", () => {
            const layout = { showWorkspace: false, showUsage: false };

            const unfocused = renderStyle("ruled", 80, {}, layout);
            const focused = renderStyle("ruled", 80, { selectedId: "shells" }, layout);

            assert.equal(unfocused.length, 3);
            assert.equal(unfocused[0], rule(80));
            assert.equal(unfocused[2], rule(80));
            assert.equal(focused.length, 3);
            assert.match(focused[2]!, new RegExp(`^─+ ${HINT_FULL} ─$`));
        });

        it("keeps only the info row between the rules when there are no cells and no model room", () => {
            const lines = renderStyle("ruled", 39, { entries: [] });

            assert.equal(lines.length, 3);
            assert.match(
                lines[1]!,
                / 25k\/200k · 12\.3%$/,
                "the context slot keeps its whole reservation",
            );
            assert.doesNotMatch(
                lines[1]!,
                /\/work\/project/,
                "the directory gives way to the context slot",
            );
            assert.equal(visibleWidth(lines[1]!), 39);
        });

        it("keeps only the statuses row when nothing else is drawn", () => {
            const lines = renderStyle(
                "ruled",
                30,
                { entries: [], status: createStatus({ extensionStatuses: ["x"] }) },
                { showWorkspace: false, showUsage: false },
            );

            assert.deepEqual(lines, [rule(30), " x", rule(30)]);
        });

        it("renders nothing when nothing is drawable", () => {
            const lines = renderStyle(
                "ruled",
                30,
                { entries: [] },
                { showWorkspace: false, showUsage: false },
            );

            assert.deepEqual(lines, []);
        });
    });

    describe("boxed", () => {
        it("frames every row in a rounded box exactly as wide as the terminal", () => {
            const lines = renderStyle("boxed", 80, {
                status: createStatus({
                    extensionStatuses: ["alpha"],
                    usage: { cost: 0.12, cacheRead: 3000, cacheHitRate: 50 },
                }),
            });

            assert.equal(lines.length, 6);
            assert.match(lines[0]!, /^╭─+╮$/);
            assert.match(lines[1]!, /^│ shells │ questions .* │ +claude-test • high │$/);
            assert.ok(
                barColumns(lines[3]!).includes(barColumns(lines[1]!).at(-2)!),
                "the model bar continues an info row bar",
            );
            assert.match(lines[2]!, /^├─+┤$/);
            assert.match(lines[3]!, /^│ .*\/work\/project.* │$/);
            assert.match(lines[4]!, /^│ alpha +│$/);
            assert.match(lines[5]!, /^╰─+╯$/);
            for (const line of lines) assert.equal(visibleWidth(line), 80, line);
        });

        it("marks the selected cell inside the border", () => {
            const [, dockRow] = renderStyle("boxed", 80, { selectedId: "shells" });

            assert.match(dockRow!, /^│❯shells │ questions/);
        });

        it("draws the key hints on the rule under the cells while focused", () => {
            const unfocused = renderStyle("boxed", 80);
            const focused = renderStyle("boxed", 80, { selectedId: "shells" });

            assert.match(focused[2]!, new RegExp(`^├─+ ${HINT_FULL} ─┤$`));
            assert.equal(unfocused[2], `├${rule(78)}┤`);
        });

        it("draws the key hints on the bottom border when no row follows the cells", () => {
            const layout = { showWorkspace: false, showUsage: false };

            const focused = renderStyle("boxed", 80, { selectedId: "shells" }, layout);
            const unfocused = renderStyle("boxed", 80, {}, layout);

            assert.equal(focused.length, 3);
            assert.match(focused[2]!, new RegExp(`^╰─+ ${HINT_FULL} ─╯$`));
            assert.equal(unfocused[2], `╰${rule(78)}╯`);
        });

        it("degrades the hint as the box narrows", () => {
            assert.match(
                renderStyle("boxed", 40, { selectedId: "shells" })[2]!,
                new RegExp(`^├─+ ${HINT_SHORT} ─┤$`),
            );
            assert.match(
                renderStyle("boxed", 30, { selectedId: "shells" })[2]!,
                new RegExp(`^├─+ ${HINT_SHORT} ─┤$`),
            );
            assert.match(
                renderStyle("boxed", 26, { selectedId: "shells" })[2]!,
                new RegExp(`^├─+ ${HINT_MINIMAL} ─┤$`),
            );
        });

        it("boxes the info row alone when there are no cells", () => {
            const lines = renderStyle("boxed", 30, { entries: [] });

            assert.equal(lines.length, 3);
            assert.match(lines[0]!, /^╭─+╮$/);
            assert.match(lines[1]!, /^│ .* │$/);
            assert.match(lines[2]!, /^╰─+╯$/);
        });

        it("renders nothing when nothing is drawable", () => {
            const lines = renderStyle(
                "boxed",
                30,
                { entries: [] },
                { showWorkspace: false, showUsage: false },
            );

            assert.deepEqual(lines, []);
        });

        it("falls back to the compact style below 24 columns", () => {
            for (const selectedId of [undefined, "shells"]) {
                assert.deepEqual(
                    renderStyle("boxed", 23, { selectedId }),
                    renderStyle("compact", 23, { selectedId }),
                );
            }
            assert.match(renderStyle("boxed", 24)[0]!, /^╭─+╮$/, "24 columns is the narrowest box");
        });
    });

    describe("compact", () => {
        it("draws the cells and the info row without any frame", () => {
            const lines = renderStyle("compact", 120);

            assert.equal(lines.length, 2);
            assert.match(lines[0]!, /^ shells │ questions .* │ +\(anthropic\) claude-test • high$/);
            assert.match(lines[1]!, /\/work\/project/);
            assert.doesNotMatch(lines.join("\n"), /[─╭╰├]/);
        });

        it("adds the statuses row last", () => {
            const lines = renderStyle("compact", 80, {
                status: createStatus({ extensionStatuses: ["alpha"] }),
            });

            assert.equal(lines.length, 3);
            assert.equal(lines[2], " alpha");
        });

        it("shows the key hint in place of the model while focused", () => {
            const focused = renderStyle("compact", 100, { selectedId: "shells" });
            const unfocused = renderStyle("compact", 100);

            assert.match(focused[0]!, new RegExp(`^❯shells.* │ ${HINT_FULL}$`));
            assert.doesNotMatch(focused[0]!, /claude-test/);
            assert.match(unfocused[0]!, /claude-test/);
            assert.doesNotMatch(unfocused[0]!, /enter open/);
        });

        it("degrades the hint to fit half the row", () => {
            assert.match(
                renderStyle("compact", 50, { selectedId: "shells" })[0]!,
                new RegExp(`${HINT_SHORT}$`),
            );
            assert.match(
                renderStyle("compact", 30, { selectedId: "shells" })[0]!,
                new RegExp(`${HINT_MINIMAL}$`),
            );
            assert.doesNotMatch(
                renderStyle("compact", 22, { selectedId: "shells" })[0]!,
                /enter open/,
            );
        });

        it("shows the hint even when the model is hidden", () => {
            const lines = renderStyle(
                "compact",
                100,
                { selectedId: "shells" },
                { showModel: false },
            );

            assert.match(lines[0]!, new RegExp(`${HINT_FULL}$`));
        });

        it("renders nothing when nothing is drawable", () => {
            const lines = renderStyle(
                "compact",
                30,
                { entries: [] },
                { showWorkspace: false, showUsage: false },
            );

            assert.deepEqual(lines, []);
        });
    });

    describe("minimal", () => {
        it("draws one row of cells, model and context use, and no info row", () => {
            const lines = renderStyle("minimal", 100, {
                status: createStatus({ showProvider: false }),
            });

            assert.equal(lines.length, 1);
            assert.match(
                lines[0]!,
                /^ shells │ questions .* │ claude-test • high │ {2}25k\/200k · 12\.3%$/,
            );
            assert.doesNotMatch(lines[0]!, /\/work\/project/);
        });

        it("adds the statuses row below the dock row", () => {
            const lines = renderStyle("minimal", 100, {
                status: createStatus({ extensionStatuses: ["alpha"] }),
            });

            assert.equal(lines.length, 2);
            assert.equal(lines[1], " alpha");
        });

        it("names the provider when there is room", () => {
            const [row] = renderStyle("minimal", 120);

            assert.match(row!, / │ \(anthropic\) claude-test • high │ {2}25k\/200k · 12\.3%$/);
        });

        it("drops the provider before the context use", () => {
            const [row] = renderStyle("minimal", 70);

            assert.match(row!, / │ claude-test • high │ {2}25k\/200k · 12\.3%$/);
            assert.doesNotMatch(row!, /anthropic/);
        });

        it("drops the speed before the context use", () => {
            const [row] = renderStyle("minimal", 70, {
                status: createStatus({
                    showProvider: false,
                    tokenSpeed: { tokensPerSecond: 55.8, generating: false },
                }),
            });

            assert.match(row!, / │ claude-test • high │ {2}25k\/200k · 12\.3%$/);
            assert.doesNotMatch(row!, /tok\/s/);
        });

        it("shows only the model when usage is hidden", () => {
            const [row] = renderStyle("minimal", 100, {}, { showUsage: false });

            assert.match(row!, /\(anthropic\) claude-test • high$/);
            assert.doesNotMatch(row!, /12\.3%/);
        });

        it("shows only the context use when the model is hidden", () => {
            const [row] = renderStyle("minimal", 100, {}, { showModel: false });

            assert.match(row!, / │ {2}25k\/200k · 12\.3%$/);
            assert.doesNotMatch(row!, /claude-test/);
        });

        it("draws only the cells when both the model and usage are hidden", () => {
            const [row] = renderStyle("minimal", 100, {}, { showModel: false, showUsage: false });

            assert.doesNotMatch(row!, /claude-test|12\.3%/);
            assert.equal(row!.trimEnd(), " shells │ questions");
        });

        it("shows the key hint in place of the model and context while focused", () => {
            const [row] = renderStyle("minimal", 100, { selectedId: "shells" });

            assert.match(row!, new RegExp(`^❯shells.* │ ${HINT_FULL}$`));
            assert.doesNotMatch(row!, /claude-test|12\.3%/);
        });

        it("keeps the right-hand block where it is as the context share grows", () => {
            const rowFor = (percent: number | null) =>
                renderStyle("minimal", 100, {
                    status: createStatus({
                        showProvider: false,
                        context: { tokens: 25_000, percent, window: 256_000 },
                    }),
                })[0]!;
            const columns = (row: string) => {
                const found: number[] = [];
                let column = 0;
                for (const char of row) {
                    if (char === "│") found.push(column);
                    column += visibleWidth(char);
                }
                return found;
            };

            const rows = [9.9, 12.3, 99.95, 100, null].map(rowFor);

            const [first, ...others] = rows.map(columns);
            assert.equal(first!.length, 3, "cells, model and context are separated by bars");
            for (const other of others) assert.deepEqual(other, first);
            assert.deepEqual(
                rows.map((row) => row.slice(-17)),
                [
                    " 25k/256k · 9.9% ",
                    " 25k/256k · 12.3%",
                    " 25k/256k · 100% ",
                    " 25k/256k · 100% ",
                    " 25k/256k · ?    ",
                ],
            );
        });

        it("lets the model claim 60 percent of the row where other styles allow 50", () => {
            const status = createStatus({ showProvider: false });
            const minimalRow = renderStyle("minimal", 40, { status })[0]!;
            const compactRow = renderStyle("compact", 40, { status })[0]!;

            assert.match(minimalRow, / │ claude-test • high$/);
            assert.doesNotMatch(
                compactRow,
                / │ claude-test • high$/,
                "half the row cannot hold the whole model",
            );
            assert.match(compactRow, /claude-test/);
        });
    });

    describe("classic", () => {
        it("draws only the cells, with no frame and no statistics", () => {
            const lines = renderStyle("classic", 80);

            assert.deepEqual(lines, [" shells │ questions"]);
        });

        it("right-aligns the key hint to the full width while focused", () => {
            const lines = renderStyle("classic", 100, { selectedId: "shells" });

            assert.equal(lines.length, 1);
            assert.match(lines[0]!, new RegExp(`^❯shells │ questions +${HINT_FULL}$`));
            assert.equal(visibleWidth(lines[0]!), 100);
        });

        it("degrades the hint and drops it when it leaves less than a gap of three", () => {
            assert.match(
                renderStyle("classic", 50, { selectedId: "shells" })[0]!,
                new RegExp(`${HINT_SHORT}$`),
            );
            assert.match(
                renderStyle("classic", 40, { selectedId: "shells" })[0]!,
                new RegExp(`${HINT_MINIMAL}$`),
            );
            assert.doesNotMatch(
                renderStyle("classic", 30, { selectedId: "shells" })[0]!,
                /enter open/,
            );
        });

        it("never draws a hint for an unfocused dock", () => {
            assert.doesNotMatch(renderStyle("classic", 100)[0]!, /enter open/);
        });

        it("ignores the model, directory and usage switches", () => {
            const hidden = renderStyle(
                "classic",
                80,
                {},
                { showModel: false, showWorkspace: false, showUsage: false },
            );

            assert.deepEqual(hidden, renderStyle("classic", 80));
        });

        it("renders nothing without cells", () => {
            assert.deepEqual(renderStyle("classic", 80, { entries: [] }), []);
        });
    });

    describe("display switches", () => {
        it("hide the model beside the cells", () => {
            const [, dockRow] = renderStyle("ruled", 80, {}, { showModel: false });

            assert.doesNotMatch(dockRow!, /claude-test/);
            assert.match(dockRow!, /^ shells │ questions +$/);
        });

        it("omit the dock row when there are neither cells nor a model to show", () => {
            const lines = renderStyle("ruled", 80, { entries: [] }, { showModel: false });

            assert.equal(lines.length, 3);
            assert.match(lines[1]!, /\/work\/project/);
        });

        it("hide the directory but keep the statistics right-aligned", () => {
            const lines = renderStyle("ruled", 80, {}, { showWorkspace: false });

            assert.doesNotMatch(lines.join("\n"), /\/work\/project/);
            assert.match(lines[3]!, /^ + 25k\/200k · 12\.3%$/);
            assert.equal(visibleWidth(lines[3]!), 80);
        });

        it("hide the statistics but keep the directory", () => {
            const lines = renderStyle("ruled", 80, {}, { showUsage: false });

            assert.match(lines[3]!, /^ \S {2}\/work\/project {2}\S \(main\) *$/);
            assert.doesNotMatch(lines.join("\n"), /12\.3%/);
        });

        it("omit the info row when both are hidden", () => {
            const lines = renderStyle("ruled", 80, {}, { showWorkspace: false, showUsage: false });

            assert.equal(lines.length, 3);
            assert.doesNotMatch(lines.join("\n"), /\/work\/project|12\.3%/);
        });
    });
});
