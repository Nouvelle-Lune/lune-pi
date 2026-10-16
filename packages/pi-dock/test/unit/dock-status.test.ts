import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { describe, it } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import {
    DockStatusSource,
    renderContextCell,
    renderInfoRow,
    renderModelSegment,
    renderStatusRow,
} from "../../src/dock-status.ts";
import {
    FakeFooterData,
    assistantMessage,
    createCompactionReader,
    createContext,
    createRecordingTheme,
    createSessionContext,
    createStatus,
    createUsage,
    identityTheme,
    toolResultMessage,
} from "../harness.ts";

function createSource(options: { cwd?: string } = {}) {
    const { ctx, session } = createSessionContext(options);
    const footerData = new FakeFooterData();
    const compaction = createCompactionReader();
    const source = new DockStatusSource(compaction.read);
    return { ctx, session, footerData, compaction, collect: () => source.collect(ctx, footerData) };
}

/** The statistics are everything after the first cell separator that follows the left-hand text. */
function statsOf(row: string): string | undefined {
    return stripTerminalSequences(row).match(/^.*? +│ (.*)$/)?.[1];
}

/** Each statistic slot of the right-hand block, in order. */
function slotsOf(row: string): string[] {
    return (statsOf(row) ?? "").split(" │ ");
}

/** The terminal column of every cell separator, so a shifted slot shows as a different list. */
function separatorColumns(row: string): number[] {
    const columns: number[] = [];
    let column = 0;
    for (const char of stripTerminalSequences(row)) {
        if (char === "│") columns.push(column);
        column += visibleWidth(char);
    }
    return columns;
}

describe("dock status source", () => {
    it("sums usage from assistant, tool result, usage, compaction and branch summary entries", () => {
        const { session, collect } = createSource();
        const manager = session.sessionManager;
        const first = manager.appendMessage(assistantMessage(createUsage({ input: 1, output: 2, cost: 0.5 })));
        manager.appendMessage(toolResultMessage(createUsage({ input: 10, output: 20, cost: 0.25 })));
        manager.appendUsage("cache_warm", "anthropic", "claude-test", createUsage({ input: 100, cacheRead: 7 }));
        manager.appendCompaction("summary", first, 500, undefined, undefined, createUsage({ input: 1000, cacheWrite: 9 }));
        manager.branchWithSummary(first, "summary", undefined, undefined, createUsage({ input: 10_000, output: 40 }));

        const { cacheHitRate: _rate, ...actual } = collect().usage;

        const expected = { input: 11_111, output: 62, cacheRead: 7, cacheWrite: 9, cost: 0.75 };
        assert.deepEqual(actual, expected);
    });

    it("ignores tool results and summaries that carry no usage", () => {
        const { session, collect } = createSource();
        const manager = session.sessionManager;
        const first = manager.appendMessage(assistantMessage(createUsage({ input: 3 })));
        manager.appendMessage(toolResultMessage());
        manager.appendCompaction("summary", first, 500);
        manager.branchWithSummary(first, "summary");

        const actual = collect().usage.input;

        assert.equal(actual, 3);
    });

    it("counts entries on abandoned branches, as Pi's own footer does", () => {
        const { session, collect } = createSource();
        const manager = session.sessionManager;
        const root = manager.appendMessage(assistantMessage(createUsage({ input: 1 })));
        manager.appendMessage(assistantMessage(createUsage({ input: 10 })));
        manager.branch(root);
        manager.appendMessage(assistantMessage(createUsage({ input: 100 })));

        const actual = collect().usage.input;

        assert.equal(actual, 111);
    });

    it("updates the totals when the session grows", () => {
        const { session, collect } = createSource();
        session.sessionManager.appendMessage(assistantMessage(createUsage({ input: 5, cost: 1 })));
        assert.equal(collect().usage.input, 5, "the first frame reports the first message");

        session.sessionManager.appendMessage(assistantMessage(createUsage({ input: 7, cost: 2 })));
        const actual = collect().usage;

        assert.deepEqual({ input: actual.input, cost: actual.cost }, { input: 12, cost: 3 });
    });

    it("reports the totals of the current session when the context moves to another one", () => {
        const first = createSource();
        const second = createSource();
        first.session.sessionManager.appendMessage(assistantMessage(createUsage({ input: 5 })));
        second.session.sessionManager.appendMessage(assistantMessage(createUsage({ input: 8 })));
        const source = new DockStatusSource(createCompactionReader().read);
        const footerData = new FakeFooterData();
        assert.equal(source.collect(first.ctx, footerData).usage.input, 5);

        const actual = source.collect(second.ctx, footerData).usage.input;

        assert.equal(actual, 8);
    });

    it("derives the cache-hit rate from the latest assistant message only", () => {
        const { session, collect } = createSource();
        session.sessionManager.appendMessage(assistantMessage(createUsage({ input: 100, cacheRead: 300 })));
        session.sessionManager.appendMessage(toolResultMessage(createUsage({ input: 999 })));
        assert.equal(collect().usage.cacheHitRate, 75);

        session.sessionManager.appendMessage(
            assistantMessage(createUsage({ input: 100, cacheRead: 100, cacheWrite: 200 })),
        );
        const actual = collect().usage.cacheHitRate;

        assert.equal(actual, 25);
    });

    it("has no cache-hit rate before the first assistant message reports usage", () => {
        const { session, collect } = createSource();
        assert.equal(collect().usage.cacheHitRate, undefined);

        session.sessionManager.appendMessage(assistantMessage(createUsage()));

        assert.equal(collect().usage.cacheHitRate, undefined);
    });

    it("labels the thinking level, and omits it for models that cannot reason", () => {
        const { session, collect } = createSource();
        const labels = new Map<string, string | undefined>();
        const reasoning = session.model!;

        session.thinkingLevel = "high";
        labels.set("high", collect().model?.thinking);
        session.thinkingLevel = "off";
        labels.set("off", collect().model?.thinking);
        session.thinkingLevel = undefined;
        labels.set("unset", collect().model?.thinking);
        session.model = { ...reasoning, reasoning: false };
        session.thinkingLevel = "high";
        labels.set("non-reasoning", collect().model?.thinking);

        assert.deepEqual(Object.fromEntries(labels), {
            high: "high",
            off: "thinking off",
            unset: "thinking off",
            "non-reasoning": undefined,
        });
    });

    it("reports no model while Pi has none selected", () => {
        const { session, collect } = createSource();
        session.model = undefined;

        assert.equal(collect().model, undefined);
    });

    it("reports the model identity and the session name and branch Pi publishes", () => {
        const { session, footerData, collect } = createSource();
        session.sessionManager.appendSessionInfo("release prep");
        footerData.branch = "feature/x";

        const status = collect();

        assert.deepEqual(
            { model: status.model?.id, provider: status.model?.provider, name: status.sessionName, branch: status.branch },
            { model: "claude-test", provider: "anthropic", name: "release prep", branch: "feature/x" },
        );
    });

    it("reports a missing git branch", () => {
        const { footerData, collect } = createSource();
        footerData.branch = null;

        assert.equal(collect().branch, null);
    });

    it("shows the provider only when more than one provider is available", () => {
        const { footerData, collect } = createSource();

        footerData.providerCount = 1;
        assert.equal(collect().showProvider, false);

        footerData.providerCount = 3;
        assert.equal(collect().showProvider, true);
    });

    it("sorts extension statuses by key and collapses their whitespace", () => {
        const { footerData, collect } = createSource();
        footerData.statuses.set("b", "  two\nlines\t ok  ");
        footerData.statuses.set("c", "   ");
        footerData.statuses.set("a", "first");
        footerData.statuses.set("d", "");

        const actual = collect().extensionStatuses;

        assert.deepEqual(actual, ["first", "two lines ok"]);
    });

    it("abbreviates the home directory as ~ and leaves other paths alone", () => {
        const cases: [string, string][] = [
            [homedir(), "~"],
            [join(homedir(), "projects", "app"), `~${sep}projects${sep}app`],
            ["/work/project", "/work/project"],
            // A sibling that merely shares the home directory's name prefix is not inside it.
            [`${homedir()}-other${sep}app`, `${homedir()}-other${sep}app`],
        ];

        for (const [cwd, expected] of cases) {
            const actual = createSource({ cwd }).collect().cwd;
            assert.equal(actual, expected, `cwd ${cwd}`);
        }
    });

    it("reports Pi's used tokens, context share and window, and unknown values as null", () => {
        const { session, collect } = createSource();
        session.contextUsage = { tokens: 25_000, contextWindow: 100_000, percent: 25 };
        assert.deepEqual(collect().context, { tokens: 25_000, percent: 25, window: 100_000 });

        session.contextUsage = { tokens: null, contextWindow: 100_000, percent: null };
        assert.deepEqual(collect().context, { tokens: null, percent: null, window: 100_000 });
    });

    it("falls back to the model's window when Pi reports no context usage", () => {
        const { session, collect } = createSource();
        session.contextUsage = undefined;
        session.model = { ...session.model!, contextWindow: 64_000 };

        assert.deepEqual(collect().context, { tokens: null, percent: null, window: 64_000 });
    });

    it("reads the auto-compaction setting once per context instead of once per frame", () => {
        const { ctx, compaction } = createSource();
        const footerData = new FakeFooterData();
        const source = new DockStatusSource(compaction.read);
        compaction.enabled = true;

        const frames = [source.collect(ctx, footerData), source.collect(ctx, footerData), source.collect(ctx, footerData)];
        compaction.enabled = false;
        frames.push(source.collect(ctx, footerData));

        assert.deepEqual(
            frames.map((status) => status.autoCompact),
            [true, true, true, true],
        );
        assert.deepEqual(compaction.calls, [ctx]);
    });

    it("re-reads the auto-compaction setting for a new context", () => {
        const first = createSource();
        const second = createSource();
        const compaction = createCompactionReader(false);
        const source = new DockStatusSource(compaction.read);
        const footerData = new FakeFooterData();
        assert.equal(source.collect(first.ctx, footerData).autoCompact, false);

        compaction.enabled = true;
        const actual = source.collect(second.ctx, footerData).autoCompact;

        assert.equal(actual, true);
        assert.deepEqual(compaction.calls, [first.ctx, second.ctx]);
    });
});

describe("dock model segment", () => {
    const budget = 40;

    it("shows the provider, the model and the dimmed thinking level when they fit", () => {
        const status = createStatus({ showProvider: true });

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, budget));

        assert.equal(actual, "(anthropic) claude-test • high");
    });

    it("omits the provider unless more than one is available", () => {
        const status = createStatus({ showProvider: false });

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, budget));

        assert.equal(actual, "claude-test • high");
    });

    it("drops the provider before it truncates the model", () => {
        const status = createStatus({ showProvider: true });
        const bareWidth = visibleWidth("claude-test • high");

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, bareWidth));

        assert.equal(actual, "claude-test • high");
    });

    it("truncates the model name when even the bare name does not fit", () => {
        const status = createStatus({ showProvider: true });

        const actual = renderModelSegment(status, identityTheme, 9);

        assert.ok(visibleWidth(actual) <= 9, `segment exceeds its budget: ${JSON.stringify(actual)}`);
        assert.match(stripTerminalSequences(actual), /^claude/);
    });

    it("shows no thinking level for a model that cannot reason", () => {
        const status = createStatus({
            model: { provider: "anthropic", id: "claude-test", thinking: undefined },
        });

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, budget));

        assert.equal(actual, "claude-test");
    });

    it("names the absence of a model", () => {
        const status = createStatus({ model: undefined, showProvider: true });

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, budget));

        assert.equal(actual, "no-model");
    });
});

/** Reserved columns of each statistic slot, as the info row documents them. */
const SLOT_WIDTH = { tokens: 11, cache: 11, cacheHit: 7, cost: 7, context: 17, auto: 6 } as const;
const BAR = 3;
/** Columns the workspace keeps before any statistic is placed, plus the bar that introduces them. */
const WORKSPACE_RESERVE = 40 + BAR;

function blockWidth(...slots: (keyof typeof SLOT_WIDTH)[]): number {
    return slots.reduce((sum, slot) => sum + SLOT_WIDTH[slot], 0) + BAR * (slots.length - 1);
}

describe("dock info row", () => {
    const fullUsage = {
        input: 1500,
        output: 20,
        cacheRead: 3000,
        cacheWrite: 400,
        cost: 0.1234,
        cacheHitRate: 50,
    };

    it("puts the directory, branch and session name left and every statistic right", () => {
        const status = createStatus({ sessionName: "my-session", usage: fullUsage, autoCompact: true });

        const row = renderInfoRow(status, 160, identityTheme);

        assert.match(
            stripTerminalSequences(row),
            /^ \S {2}\/work\/project {2}\S \(main\) • my-session +│ /,
        );
        assert.deepEqual(slotsOf(row), [
            "↑1.5k ↓  20",
            "R3.0k W 400",
            "CH50.0%",
            " $0.123",
            " 25k/200k · 12.3%",
            "(auto)",
        ]);
        assert.equal(visibleWidth(row), 160, "the statistics must be right-aligned to the edge");
    });

    it("reserves a fixed number of columns for each slot", () => {
        const status = createStatus({ usage: fullUsage, autoCompact: true });

        const actual = slotsOf(renderInfoRow(status, 160, identityTheme)).map((slot) => slot.length);

        assert.deepEqual(actual, [
            SLOT_WIDTH.tokens,
            SLOT_WIDTH.cache,
            SLOT_WIDTH.cacheHit,
            SLOT_WIDTH.cost,
            SLOT_WIDTH.context,
            SLOT_WIDTH.auto,
        ]);
    });

    it("draws only the context and (auto) in a fresh session, right-aligned", () => {
        const row = renderInfoRow(createStatus({ autoCompact: true }), 160, identityTheme);

        assert.deepEqual(slotsOf(row), [" 25k/200k · 12.3%", "(auto)"]);
        assert.equal(visibleWidth(row), 160);
        assert.match(stripTerminalSequences(row), /\(auto\)$/);
    });

    it("leaves no dashes or labels behind for slots that have no data", () => {
        const row = stripTerminalSequences(
            renderInfoRow(createStatus({ autoCompact: true }), 160, identityTheme),
        );

        assert.doesNotMatch(row, /[↑↓$]|\bR\b|\bW\b|CH|-/);
    });

    it("omits the branch and the session name when there are none", () => {
        const row = renderInfoRow(createStatus({ branch: null }), 160, identityTheme);

        assert.match(stripTerminalSequences(row), /^ \S {2}\/work\/project +│ {1,5}\d+k\/200k · +\d+\.\d%$/);
    });

    it("shows an unknown context share as a question mark in its slot", () => {
        const status = createStatus({ context: { tokens: null, percent: null, window: 256_000 } });

        assert.equal(slotsOf(renderInfoRow(status, 160, identityTheme)).at(-1), "   ?/256k ·     ?");
    });

    it("shows input and output tokens independently, right-aligned in their fields", () => {
        const input = renderInfoRow(createStatus({ usage: { input: 1500 } }), 160, identityTheme);
        const output = renderInfoRow(createStatus({ usage: { output: 20 } }), 160, identityTheme);

        assert.equal(slotsOf(input)[0], "↑1.5k");
        assert.equal(slotsOf(output)[0], "↓  20");
    });

    it("shows cache reads and writes independently", () => {
        const read = renderInfoRow(
            createStatus({ usage: { cacheRead: 3000, cacheHitRate: 40 } }),
            160,
            identityTheme,
        );
        const write = renderInfoRow(
            createStatus({ usage: { cacheWrite: 400, cacheHitRate: 0 } }),
            160,
            identityTheme,
        );

        assert.deepEqual(slotsOf(read).slice(0, 2), ["R3.0k", "CH40.0%"]);
        assert.deepEqual(slotsOf(write).slice(0, 2), ["W 400", "CH 0.0%"]);
    });

    it("quotes a cache-hit rate only when the cache was used and a rate exists", () => {
        const unused = renderInfoRow(createStatus({ usage: { cacheHitRate: 40 } }), 160, identityTheme);
        const unknown = renderInfoRow(
            createStatus({ usage: { cacheRead: 3000, cacheHitRate: undefined } }),
            160,
            identityTheme,
        );

        assert.deepEqual(slotsOf(unused), [" 25k/200k · 12.3%"], "no cache traffic draws no CH slot");
        assert.deepEqual(slotsOf(unknown), ["R3.0k", " 25k/200k · 12.3%"], "no rate draws no CH slot");
    });

    it("right-aligns the cost and spends fewer decimals as it grows", () => {
        const costs: [number, string][] = [
            [0.008, " $0.008"],
            [12.3456, "$12.346"],
            [123.456, "$123.46"],
            [1234.56, "$1234.6"],
            [12_345.67, " $12346"],
        ];

        for (const [cost, expected] of costs) {
            const row = renderInfoRow(createStatus({ usage: { cost } }), 160, identityTheme);
            assert.equal(slotsOf(row)[0], expected, `cost ${cost}`);
        }
    });

    it("leaves out a zero part of a token or cache slot without a dash or a gap", () => {
        const cases: [string, Partial<typeof fullUsage>, string][] = [
            ["input only", { input: 28_000 }, "↑ 28k"],
            ["output only", { output: 5600 }, "↓5.6k"],
            ["both tokens", { input: 28_000, output: 5600 }, "↑ 28k ↓5.6k"],
            ["reads only", { cacheRead: 187_000 }, "R187k"],
            ["writes only", { cacheWrite: 4_500_000 }, "W4.5M"],
            ["both cache parts", { cacheRead: 187_000, cacheWrite: 3500 }, "R187k W3.5k"],
        ];

        for (const [name, usage, expected] of cases) {
            const row = renderInfoRow(createStatus({ usage }), 160, identityTheme);

            assert.equal(slotsOf(row)[0], expected, name);
            assert.doesNotMatch(statsOf(row)!, /-/, name);
        }
    });

    it("shows only the cache read in an ordinary session whose provider reports no cache writes", () => {
        const status = createStatus({ usage: { input: 900, output: 40, cacheRead: 187_000, cacheHitRate: 99 } });

        const actual = slotsOf(renderInfoRow(status, 160, identityTheme));

        assert.deepEqual(actual, ["↑ 900 ↓  40", "R187k", "CH99.0%", " 25k/200k · 12.3%"]);
    });

    it("draws no slot for data that is absent", () => {
        const cases: [string, Partial<typeof fullUsage>, string[]][] = [
            ["tokens", { input: 1500 }, ["↑1.5k", " 25k/200k · 12.3%"]],
            ["cost", { cost: 0.5 }, [" $0.500", " 25k/200k · 12.3%"]],
            ["cache and CH", { cacheWrite: 400, cacheHitRate: 0 }, ["W 400", "CH 0.0%", " 25k/200k · 12.3%"]],
        ];

        for (const [name, usage, expected] of cases) {
            const row = renderInfoRow(createStatus({ usage }), 160, identityTheme);
            assert.deepEqual(slotsOf(row), expected, name);
        }
    });

    it("formats token counts like Pi's footer, within four columns, carrying into the next unit", () => {
        const counts: [number, string][] = [
            [7, "   7"],
            [999, " 999"],
            [1234, "1.2k"],
            [9949, "9.9k"],
            [9950, " 10k"],
            [12_345, " 12k"],
            [999_499, "999k"],
            [999_500, "1.0M"],
            [999_999, "1.0M"],
            [1_500_000, "1.5M"],
            [12_000_000, " 12M"],
            [999_999_999, "1.0G"],
            [2_500_000_000, "2.5G"],
        ];

        for (const [input, expected] of counts) {
            const row = renderInfoRow(createStatus({ usage: { input } }), 160, identityTheme);
            assert.equal(slotsOf(row)[0]!.slice(1, 5), expected, `${input} tokens`);
        }
    });

    describe("layout stability", () => {
        const base = { sessionName: "my-session", autoCompact: true } as const;
        /** Every part of every slot has data, so each slot is drawn at its full reserved width. */
        const populated = {
            small: createStatus({
                ...base,
                usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 2, cost: 0.001, cacheHitRate: 0 },
                context: { tokens: 200, percent: 0.1, window: 200_000 },
            }),
            huge: createStatus({
                ...base,
                usage: {
                    input: 987_654_321,
                    output: 123_456_789,
                    cacheRead: 999_999_999,
                    cacheWrite: 555_555,
                    cost: 98_765.4321,
                    cacheHitRate: 100,
                },
                context: { tokens: 200_000, percent: 100, window: 200_000 },
            }),
            nearlyFull: createStatus({
                ...base,
                usage: { input: 1500, output: 1, cost: 99.9999, cacheRead: 3000, cacheWrite: 5, cacheHitRate: 99.96 },
                context: { tokens: 199_920, percent: 99.96, window: 200_000 },
            }),
            unknownContext: createStatus({
                ...base,
                usage: { input: 1, output: 42, cacheRead: 77, cacheWrite: 9, cost: 5, cacheHitRate: 12.3 },
                context: createContext(null, 200_000),
            }),
        };

        it("keeps every separator and the total width where they are as the numbers change", () => {
            for (const width of [160, 120, 100, 80]) {
                const layouts = Object.entries(populated).map(([name, status]) => {
                    const row = renderInfoRow(status, width, identityTheme);
                    return { name, columns: separatorColumns(row), width: visibleWidth(row) };
                });

                const [first, ...others] = layouts;
                for (const other of others) {
                    assert.deepEqual(
                        { columns: other.columns, width: other.width },
                        { columns: first!.columns, width: first!.width },
                        `${other.name} against ${first!.name} at ${width} columns`,
                    );
                }
                assert.equal(first!.width, width);
            }
        });

        /** Thresholds follow from the reserved widths alone: 43 for the workspace plus each slot and its join. */
        function reservedAt(width: number): string[] {
            if (width >= 117) return ["cache", "cacheHit", "tokens", "cost", "context", "auto"];
            if (width >= 103) return ["cacheHit", "tokens", "cost", "context", "auto"];
            if (width >= 93) return ["tokens", "cost", "context", "auto"];
            if (width >= 79) return ["cost", "context", "auto"];
            if (width >= 69) return ["context", "auto"];
            return ["context"];
        }

        const markers = {
            cache: "R",
            cacheHit: "CH",
            tokens: "↑",
            cost: "$",
            context: "/200k ·",
            auto: "(auto)",
        } as const;
        const drawn = (row: string): string[] =>
            Object.entries(markers)
                .filter(([, marker]) => stripTerminalSequences(row).includes(marker))
                .map(([name]) => name);

        it("reserves the same slots at every width, whatever the numbers say", () => {
            for (let width = 40; width <= 170; width++) {
                for (const [name, status] of Object.entries(populated)) {
                    const actual = drawn(renderInfoRow(status, width, identityTheme));

                    assert.deepEqual(
                        actual.sort(),
                        reservedAt(width).sort(),
                        `${name} at ${width} columns`,
                    );
                }
            }
        });

        it("draws a reserved slot only once it has data, whatever the width", () => {
            const fresh = createStatus({ ...base });

            for (let width = 40; width <= 170; width++) {
                const expected = reservedAt(width).filter((slot) => slot === "context" || slot === "auto");

                assert.deepEqual(
                    drawn(renderInfoRow(fresh, width, identityTheme)).sort(),
                    expected.sort(),
                    `${width} columns`,
                );
            }
        });

        it("keeps the slots that are already drawn in place when another one gains data", () => {
            // Slots are ordered tokens, cache, CH, cost, context, (auto); data arriving in that order
            // right to left keeps every drawn slot flush against the ones to its right.
            const cost = { cost: 0.1234 };
            const cache = { cacheRead: 3000, cacheWrite: 400, cacheHitRate: 50 };
            const tokens = { input: 1500, output: 20 };
            const steps = [
                { usage: {} },
                { usage: { ...cost } },
                { usage: { ...cost, ...cache } },
                { usage: { ...cost, ...cache, ...tokens } },
            ];
            const texts = [" 25k/200k · 12.3%", "(auto)", " $0.123", "R3.0k W 400", "CH50.0%", "↑1.5k ↓  20"];
            /** Columns between the start of a slot and the right edge. */
            const fromRight = (row: string, text: string): number | undefined => {
                const plain = stripTerminalSequences(row);
                const at = plain.lastIndexOf(text);
                return at < 0 ? undefined : visibleWidth(plain.slice(at));
            };

            for (const width of [160, 120]) {
                const rows = steps.map(({ usage }) =>
                    renderInfoRow(createStatus({ ...base, usage }), width, identityTheme),
                );

                const appeared = rows.map((row) => texts.filter((t) => fromRight(row, t) !== undefined));
                assert.deepEqual(
                    appeared.map((slots) => slots.length),
                    [2, 3, 5, 6],
                    "each step adds slots to the left of the existing ones",
                );
                for (const row of rows) assert.equal(visibleWidth(row), width);
                for (let step = 1; step < rows.length; step++) {
                    for (const text of appeared[step - 1]!) {
                        assert.equal(
                            fromRight(rows[step]!, text),
                            fromRight(rows[step - 1]!, text),
                            `"${text}" moved at step ${step}, width ${width}`,
                        );
                    }
                }
            }
        });

        it("starts the right block at the same column for any directory, branch or session name", () => {
            const variants = [
                createStatus({ cwd: "/a", branch: null }),
                createStatus({ cwd: "/work/project", branch: "main", sessionName: "s" }),
                createStatus({ cwd: "/work/a-very/long/path/to/the/project", branch: "feature/long-branch-name" }),
                createStatus({ cwd: "/工作/项目", branch: "分支🙂", sessionName: "会话" }),
            ];

            for (const width of [120, 100, 80]) {
                const starts = variants.map(
                    (status) => separatorColumns(renderInfoRow(status, width, identityTheme))[0],
                );

                assert.equal(new Set(starts).size, 1, `columns ${starts.join(", ")} at ${width}`);
            }
        });

        it("keeps the right block where it is when only the context share changes", () => {
            const at = (percent: number | null) =>
                slotsOf(
                    renderInfoRow(
                        createStatus({ context: { tokens: 25_000, percent, window: 256_000 } }),
                        160,
                        identityTheme,
                    ),
                ).at(-1);

            assert.deepEqual([at(9.9), at(12.3), at(100), at(null)], [
                " 25k/256k ·  9.9%",
                " 25k/256k · 12.3%",
                " 25k/256k ·  100%",
                " 25k/256k ·     ?",
            ]);
        });
    });

    describe("slot selection", () => {
        const status = createStatus({
            usage: { ...fullUsage },
            autoCompact: true,
        });
        const markers = {
            cache: "R3.0k",
            cacheHit: "CH50.0%",
            tokens: "↑1.5k",
            cost: "$0.123",
            auto: "(auto)",
            context: " 25k/200k · 12.3%",
        } as const;

        function present(width: number, subject = status): string[] {
            const stats = statsOf(renderInfoRow(subject, width, identityTheme)) ?? "";
            return Object.entries(markers)
                .filter(([, marker]) => stats.includes(marker))
                .map(([name]) => name);
        }

        it("keeps every slot once the workspace reserve and all reserved widths fit", () => {
            const needed =
                WORKSPACE_RESERVE +
                blockWidth("tokens", "cache", "cacheHit", "cost", "context", "auto");

            assert.equal(needed, 117);
            assert.deepEqual(present(needed).sort(), Object.keys(markers).sort());
        });

        it("drops cache, then CH, then tokens, then cost, then (auto) as the width shrinks", () => {
            const survivors = [
                ["tokens", "cacheHit", "cost", "context", "auto"],
                ["tokens", "cost", "context", "auto"],
                ["cost", "context", "auto"],
                ["context", "auto"],
                ["context"],
            ] as const;

            for (const remaining of survivors) {
                const width = WORKSPACE_RESERVE + blockWidth(...remaining);

                assert.deepEqual(present(width).sort(), [...remaining].sort(), `${width} columns`);
            }
        });

        it("keeps a slot at the exact width where it fits and drops it one column earlier", () => {
            const thresholds: [keyof typeof markers, number][] = [
                ["cache", WORKSPACE_RESERVE + blockWidth("tokens", "cache", "cacheHit", "cost", "context", "auto")],
                ["cacheHit", WORKSPACE_RESERVE + blockWidth("tokens", "cacheHit", "cost", "context", "auto")],
                ["tokens", WORKSPACE_RESERVE + blockWidth("tokens", "cost", "context", "auto")],
                ["cost", WORKSPACE_RESERVE + blockWidth("cost", "context", "auto")],
                ["auto", WORKSPACE_RESERVE + blockWidth("context", "auto")],
            ];

            assert.deepEqual(
                thresholds.map(([, width]) => width),
                [117, 103, 93, 79, 69],
            );
            for (const [name, width] of thresholds) {
                assert.ok(present(width).includes(name), `${name} at ${width}`);
                assert.ok(!present(width - 1).includes(name), `${name} at ${width - 1}`);
            }
        });

        it("never drops the context slot", () => {
            for (let width = 1; width <= 170; width++) {
                const stats = statsOf(renderInfoRow(status, width, identityTheme)) ?? "";
                if (width >= BAR + SLOT_WIDTH.context + 2) {
                    assert.ok(stats.includes(markers.context), `context missing at ${width}`);
                }
            }
        });

        it("does not reserve room for (auto) when auto-compaction is off", () => {
            const without = createStatus({ usage: { ...fullUsage } });
            const needed = WORKSPACE_RESERVE + blockWidth("tokens", "cache", "cacheHit", "cost", "context");

            assert.equal(needed, 108);
            assert.deepEqual(
                present(needed, without).sort(),
                ["cache", "cacheHit", "tokens", "cost", "context"].sort(),
            );
            assert.ok(!present(needed - 1, without).includes("cache"));
        });

        it("shows no tokens slot at 80 columns however large the counts, and only context and (auto) for zeros", () => {
            const large = createStatus({
                autoCompact: true,
                usage: { input: 5e8, output: 5e7, cost: 9999 },
            });
            const zero = createStatus({ autoCompact: true });

            assert.deepEqual(slotsOf(renderInfoRow(large, 80, identityTheme)), [
                "$9999.0",
                " 25k/200k · 12.3%",
                "(auto)",
            ]);
            assert.deepEqual(slotsOf(renderInfoRow(zero, 80, identityTheme)), [" 25k/200k · 12.3%", "(auto)"]);
        });
    });

    it("shortens the directory from the left only after the statistics have given way", () => {
        const status = createStatus({
            cwd: "/work/a-long-directory/project",
            branch: null,
            usage: fullUsage,
            autoCompact: true,
        });

        const roomy = stripTerminalSequences(renderInfoRow(status, 130, identityTheme));
        const onlyContextLeft = renderInfoRow(status, 60, identityTheme);
        const shortened = stripTerminalSequences(renderInfoRow(status, 50, identityTheme));
        const narrow = renderInfoRow(status, 37, identityTheme);

        assert.match(roomy, /\/work\/a-long-directory\/project/);
        assert.deepEqual(slotsOf(onlyContextLeft), [" 25k/200k · 12.3%"]);
        assert.match(
            stripTerminalSequences(onlyContextLeft),
            /\/work\/a-long-directory\/project/,
            "the directory outlasts every optional counter",
        );
        assert.match(shortened, /…\/a-long-directory\/project/);
        assert.match(stripTerminalSequences(narrow), /…\/project/);
        assert.doesNotMatch(stripTerminalSequences(narrow), /a-long-directory/);
        assert.deepEqual(slotsOf(narrow), [" 25k/200k · 12.3%"]);
    });

    it("shortens the directory against the full reservation, so it does not jump when usage arrives", () => {
        const cwd = "/work/a-long-directory/project/packages/some-nested-module/src";
        const populated = createStatus({
            cwd,
            branch: "main",
            usage: { ...fullUsage },
            autoCompact: true,
        });
        const fresh = createStatus({ cwd, branch: "main", autoCompact: true });
        const leftOf = (row: string) => stripTerminalSequences(row).split(" │ ")[0]!.trimEnd();

        const before = leftOf(renderInfoRow(fresh, 107, identityTheme));
        const after = leftOf(renderInfoRow(populated, 107, identityTheme));

        assert.match(before, /^ \S {2}…\/some-nested-module\/src {2}\S \(main\)$/);
        assert.equal(after, before);
    });

    it("never exceeds the requested width, including with wide characters", () => {
        const status = createStatus({
            cwd: "/工作/项目/应用",
            branch: "分支🙂",
            sessionName: "会话🙂名称",
            usage: fullUsage,
            autoCompact: true,
        });

        for (let width = 1; width <= 160; width++) {
            const row = renderInfoRow(status, width, identityTheme);
            assert.ok(
                visibleWidth(row) <= width,
                `width ${width} row is wider than the terminal: ${JSON.stringify(row)}`,
            );
        }
    });

    describe("context colour", () => {
        function colorOfContext(percent: number | null): string | undefined {
            const { theme, colorsOf } = createRecordingTheme();
            const status = createStatus({ context: createContext(percent, 200_000) });
            // The recording theme keys colours by the exact text it was asked to colour.
            const label = stripTerminalSequences(renderContextCell(status, identityTheme));
            renderInfoRow(status, 160, theme);
            return colorsOf(label)[0];
        }

        it("is muted at or below 70 percent and when the share is unknown", () => {
            assert.equal(colorOfContext(50), "muted");
            assert.equal(colorOfContext(70), "muted");
            assert.equal(colorOfContext(null), "muted");
        });

        it("warns above 70 percent, up to 90", () => {
            assert.equal(colorOfContext(70.1), "warning");
            assert.equal(colorOfContext(90), "warning");
        });

        it("reports an error above 90 percent", () => {
            assert.equal(colorOfContext(90.1), "error");
            assert.equal(colorOfContext(99), "error");
        });
    });
});

describe("dock extension status row", () => {
    it("renders no row without statuses", () => {
        assert.equal(renderStatusRow([], 80, identityTheme), undefined);
    });

    it("joins the statuses with a space after one leading space", () => {
        const actual = renderStatusRow(["alpha", "beta"], 80, identityTheme);

        assert.equal(actual && stripTerminalSequences(actual), " alpha beta");
    });

    it("truncates with an ellipsis instead of exceeding the width", () => {
        const actual = renderStatusRow(["a-very-long-status-text"], 10, identityTheme)!;

        assert.ok(visibleWidth(actual) <= 10, `row exceeds the width: ${JSON.stringify(actual)}`);
        assert.match(stripTerminalSequences(actual), /…/);
    });
});

describe("dock info row parts", () => {
    const usage = { input: 1500, output: 20, cost: 0.5 };

    it("draws the statistics alone, right-aligned and without a leading bar", () => {
        const status = createStatus({ usage });

        const row = renderInfoRow(status, 70, identityTheme, { workspace: false, usage: true });

        assert.equal(
            stripTerminalSequences(row).trim(),
            "↑1.5k ↓  20 │  $0.500 │  25k/200k · 12.3%",
        );
        assert.equal(visibleWidth(row), 70);
        assert.match(stripTerminalSequences(row), /^ +↑/, "the row starts with padding, not a separator");
    });

    it("gives the statistics the whole width when the directory is hidden", () => {
        const cached = { ...usage, cacheRead: 3000, cacheWrite: 400, cacheHitRate: 50 };
        const status = createStatus({ usage: cached, autoCompact: true });
        const all = blockWidth("tokens", "cache", "cacheHit", "cost", "context", "auto");
        const parts = { workspace: false, usage: true };

        const fits = stripTerminalSequences(renderInfoRow(status, all, identityTheme, parts));
        const oneShort = stripTerminalSequences(renderInfoRow(status, all - 1, identityTheme, parts));

        assert.equal(all, 74);
        assert.match(fits, /^↑.*R.*CH.*\(auto\)$/);
        assert.doesNotMatch(oneShort, /R {3}- W/, "the cache slot goes first");
        assert.match(oneShort, /CH/);
    });

    it("draws the directory and branch alone", () => {
        const status = createStatus({ usage, sessionName: "my-session" });

        const row = stripTerminalSequences(
            renderInfoRow(status, 60, identityTheme, { workspace: true, usage: false }),
        );

        assert.match(row, /^ \S {2}\/work\/project {2}\S \(main\) • my-session *$/);
        assert.doesNotMatch(row, /│|12\.3%/);
    });

    it("drops optional statistics to fit when drawn alone", () => {
        const status = createStatus({ usage, autoCompact: true });

        const row = stripTerminalSequences(
            renderInfoRow(status, 19, identityTheme, { workspace: false, usage: true }),
        );

        assert.equal(row.trim(), "25k/200k · 12.3%");
    });

    it("shortens the directory to fit when drawn alone", () => {
        const status = createStatus({ cwd: "/work/a-long-directory/project", branch: null });

        const row = stripTerminalSequences(
            renderInfoRow(status, 20, identityTheme, { workspace: true, usage: false }),
        );

        assert.match(row, /…\/project/);
        assert.ok(visibleWidth(row) <= 20);
    });

    it("never exceeds the width in either mode, including with wide characters", () => {
        const status = createStatus({
            cwd: "/工作/项目",
            branch: "分支🙂",
            sessionName: "会话🙂",
            usage,
            autoCompact: true,
        });

        for (const parts of [
            { workspace: false, usage: true },
            { workspace: true, usage: false },
        ]) {
            for (let width = 1; width <= 100; width++) {
                const row = renderInfoRow(status, width, identityTheme, parts);
                assert.ok(visibleWidth(row) <= width, `${JSON.stringify(parts)} width ${width}: ${JSON.stringify(row)}`);
            }
        }
    });
});

describe("dock context cell", () => {
    const cell = (tokens: number | null, percent: number | null, window = 256_000) =>
        stripTerminalSequences(
            renderContextCell(createStatus({ context: { tokens, percent, window } }), identityTheme),
        );

    it("shows used tokens, the window and the share, in that order", () => {
        const actual = cell(25_000, 9.8);

        assert.equal(actual, " 25k/256k ·  9.8%");
        assert.ok(actual.indexOf("25k") < actual.indexOf("256k") && actual.indexOf("256k") < actual.indexOf("9.8%"));
    });

    it("right-aligns the share in a field of fixed width", () => {
        assert.deepEqual([cell(0, 0), cell(25_000, 9.9), cell(88_000, 34.34), cell(179_200, 70)], [
            "   0/256k ·  0.0%",
            " 25k/256k ·  9.9%",
            " 88k/256k · 34.3%",
            "179k/256k · 70.0%",
        ]);
    });

    it("separates the window from the share with a middle dot", () => {
        assert.match(cell(25_000, 9.8), /256k · +9\.8%$/);
    });

    it("shows a whole percentage from 99.95 so 100% costs no extra column", () => {
        assert.deepEqual([cell(255_800, 99.94), cell(255_900, 99.95), cell(256_000, 100)], [
            "256k/256k · 99.9%",
            "256k/256k ·  100%",
            "256k/256k ·  100%",
        ]);
    });

    it("shows unknown tokens and an unknown share as question marks in their own fields", () => {
        assert.deepEqual([cell(null, 12.3), cell(25_000, null), cell(null, null, 1_000_000)], [
            "   ?/256k · 12.3%",
            " 25k/256k ·     ?",
            "   ?/1.0M ·     ?",
        ]);
    });

    it("keeps the same width whether or not the fields are known", () => {
        const widths = [cell(null, null), cell(null, 12.3), cell(25_000, null), cell(25_000, 12.3)].map(
            visibleWidth,
        );

        assert.deepEqual(widths, [17, 17, 17, 17]);
    });

    it("keeps the same width as used tokens grow", () => {
        const counts = [0, 999, 1000, 25_000, 999_000];

        const actual = counts.map((tokens) => visibleWidth(cell(tokens, 12.3)));

        assert.deepEqual(actual, counts.map(() => 17));
    });

    it("keeps the same width across shares and windows", () => {
        const percents = [null, 0, 0.04, 9.9, 10, 69.99, 99.94, 99.95, 100];

        for (const percent of percents) {
            for (const window of [8000, 200_000, 1_000_000]) {
                const text = renderContextCell(
                    createStatus({ context: createContext(percent, window) }),
                    identityTheme,
                );
                assert.equal(visibleWidth(text), 17, `${percent} of ${window}`);
            }
        }
    });

    it("warns above 70 percent and reports an error above 90", () => {
        const colorFor = (percent: number) => {
            const { theme, colorsOf } = createRecordingTheme();
            const status = createStatus({ context: createContext(percent, 200_000) });
            renderContextCell(status, theme);
            return colorsOf(stripTerminalSequences(renderContextCell(status, identityTheme)))[0];
        };

        assert.deepEqual([colorFor(70), colorFor(70.1), colorFor(90), colorFor(90.1)], [
            "muted",
            "warning",
            "warning",
            "error",
        ]);
    });

    it("stays muted, with the same padding, while the share is unknown", () => {
        const { theme, colorsOf } = createRecordingTheme();

        renderContextCell(createStatus({ context: createContext(null, 200_000) }), theme);

        assert.deepEqual(colorsOf(cell(null, null, 200_000)), ["muted"]);
    });
});
