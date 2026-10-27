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
    type DockStatus,
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

/** Each drawn statistic slot of the right-hand block, in order, padding included; blank slots between them merge into the slot on their left. */
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
        const first = manager.appendMessage(
            assistantMessage(createUsage({ input: 1, output: 2, cost: 0.5 })),
        );
        manager.appendMessage(
            toolResultMessage(createUsage({ input: 10, output: 20, cost: 0.25 })),
        );
        manager.appendUsage(
            "cache_warm",
            "anthropic",
            "claude-test",
            createUsage({ input: 100, cacheRead: 7 }),
        );
        manager.appendCompaction(
            "summary",
            first,
            500,
            undefined,
            undefined,
            createUsage({ input: 1000, cacheWrite: 9 }),
        );
        manager.branchWithSummary(
            first,
            "summary",
            undefined,
            undefined,
            createUsage({ input: 10_000, output: 40 }),
        );

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
        session.sessionManager.appendMessage(
            assistantMessage(createUsage({ input: 100, cacheRead: 300 })),
        );
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
            {
                model: status.model?.id,
                provider: status.model?.provider,
                name: status.sessionName,
                branch: status.branch,
            },
            {
                model: "claude-test",
                provider: "anthropic",
                name: "release prep",
                branch: "feature/x",
            },
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

        const frames = [
            source.collect(ctx, footerData),
            source.collect(ctx, footerData),
            source.collect(ctx, footerData),
        ];
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
    // Wide enough for the provider, model, thinking level and speed segment together.
    const budget = 60;
    const bare = "claude-test • high";

    it("shows the provider, the model and the thinking level when they fit", () => {
        const status = createStatus({ showProvider: true });

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, budget));

        assert.equal(actual, `(anthropic) ${bare}`);
    });

    it("omits the provider unless more than one is available", () => {
        const status = createStatus({ showProvider: false });

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, budget));

        assert.equal(actual, bare);
    });

    it("drops the provider before it truncates the model", () => {
        const status = createStatus({ showProvider: true });
        const bareWidth = visibleWidth(bare);

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, bareWidth));

        assert.equal(actual, bare);
    });

    it("truncates the model name when even the bare name does not fit", () => {
        const status = createStatus({ showProvider: true });

        const actual = renderModelSegment(status, identityTheme, 9);
        const plain = stripTerminalSequences(actual);

        assert.ok(
            visibleWidth(actual) <= 9,
            `segment exceeds its budget: ${JSON.stringify(actual)}`,
        );
        assert.match(plain, /^claude/);
        assert.doesNotMatch(plain, /tok\/s/, "the speed segment must give way to the model");
    });

    it("shows no thinking level for a model that cannot reason", () => {
        const status = createStatus({
            model: { provider: "anthropic", id: "claude-test", thinking: undefined },
        });

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, budget));

        assert.equal(actual, "claude-test");
    });

    it("names the absence of a model without a speed segment", () => {
        const status = createStatus({ model: undefined, showProvider: true });

        const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, budget));

        assert.equal(actual, "no-model");
        assert.doesNotMatch(actual, /tok\/s/);
    });
});

describe("dock model speed segment", () => {
    const bare = "claude-test • high";
    const budget = 60;

    function segment(tokenSpeed: DockStatus["tokenSpeed"]) {
        const status = createStatus({ tokenSpeed });
        return stripTerminalSequences(renderModelSegment(status, identityTheme, budget));
    }

    it("appends the latest measured rate with one decimal", () => {
        const cases: [number, string][] = [
            [55.84, " · 55.8 tok/s"],
            [12.34, " · 12.3 tok/s"],
            [999.9, " · 999.9 tok/s"],
        ];

        for (const [tokensPerSecond, expected] of cases) {
            const actual = segment({ tokensPerSecond, generating: false });

            assert.equal(actual, bare + expected, `${tokensPerSecond} tokens per second`);
        }
    });

    it("omits the speed segment when no reliable positive finite rate exists", () => {
        const cases: [string, DockStatus["tokenSpeed"]][] = [
            ["no measurement", { tokensPerSecond: undefined, generating: false }],
            [
                "generating without a prior measurement",
                { tokensPerSecond: undefined, generating: true },
            ],
            ["zero", { tokensPerSecond: 0, generating: false }],
            ["negative", { tokensPerSecond: -12.5, generating: false }],
            ["not a number", { tokensPerSecond: Number.NaN, generating: false }],
            ["infinite", { tokensPerSecond: Number.POSITIVE_INFINITY, generating: false }],
        ];

        for (const [name, tokenSpeed] of cases) {
            const actual = segment(tokenSpeed);

            assert.equal(actual, bare, name);
            assert.doesNotMatch(actual, /tok\/s|—|0/, name);
        }
    });

    it("reports a positive rate below a tenth as <0.1", () => {
        const actual = segment({ tokensPerSecond: 0.06, generating: false });

        assert.equal(actual, bare + " · <0.1 tok/s");
    });

    it("bounds only a large rate to six numeric columns", () => {
        for (const tokensPerSecond of [12_345.6, 999_999_999, 1_500_000_000]) {
            const actual = segment({ tokensPerSecond, generating: false });
            const match = actual.match(/^claude-test • high · (\S+) tok\/s$/);

            assert.ok(match, `${tokensPerSecond} tokens per second: ${JSON.stringify(actual)}`);
            assert.ok(
                match[1]!.length <= 6,
                `${tokensPerSecond} exceeds six numeric columns: ${JSON.stringify(match[1])}`,
            );
        }
    });

    it("hides the whole speed segment before shortening the model and thinking", () => {
        const withSpeed = bare + " · 55.8 tok/s";
        const cases: [number, string][] = [
            [visibleWidth(withSpeed), withSpeed],
            [visibleWidth(withSpeed) - 1, bare],
            [visibleWidth(bare), bare],
        ];

        for (const [width, expected] of cases) {
            const status = createStatus({
                tokenSpeed: { tokensPerSecond: 55.8, generating: false },
            });

            const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, width));

            assert.equal(actual, expected, `${width} columns`);
        }
    });

    it("keeps the speed by dropping the provider, then restores the provider before the bare model", () => {
        const status = createStatus({
            showProvider: true,
            tokenSpeed: { tokensPerSecond: 55.8, generating: false },
        });
        const named = `(anthropic) ${bare}`;
        const speed = " · 55.8 tok/s";
        const cases: [number, string][] = [
            [visibleWidth(named + speed), named + speed],
            [visibleWidth(bare + speed), bare + speed],
            [visibleWidth(named), named],
        ];

        for (const [width, expected] of cases) {
            const actual = stripTerminalSequences(renderModelSegment(status, identityTheme, width));

            assert.equal(actual, expected, `${width} columns`);
        }
    });

    it("highlights a measured speed while generating, dims it once finished, and draws none without a rate", () => {
        function speedColors(tokenSpeed: DockStatus["tokenSpeed"]): string[] | undefined {
            const { theme, colorsOf } = createRecordingTheme();
            const text = stripTerminalSequences(
                renderModelSegment(createStatus({ tokenSpeed }), theme, budget),
            );
            if (!text.endsWith(" tok/s")) return undefined;
            return colorsOf(text.slice(bare.length));
        }

        const actual = {
            generating: speedColors({ tokensPerSecond: 55.8, generating: true }),
            ended: speedColors({ tokensPerSecond: 55.8, generating: false }),
            unknown: speedColors({ tokensPerSecond: undefined, generating: true }),
        };

        assert.deepEqual(actual, {
            generating: ["accent"],
            ended: ["dim"],
            unknown: undefined,
        });
    });
});

/** Reserved columns of each statistic slot, leftmost first, as the info row documents them. */
const SLOT_WIDTH = {
    write: 5,
    read: 5,
    cacheHit: 8,
    tokens: 11,
    cost: 7,
    context: 17,
    auto: 6,
} as const;
type SlotName = keyof typeof SLOT_WIDTH;
const ALL_SLOTS = Object.keys(SLOT_WIDTH) as SlotName[];
const WITHOUT_AUTO = ALL_SLOTS.filter((slot) => slot !== "auto");
/** Every slot is introduced by its own bar, the first one dividing the statistics from the directory. */
const BAR = 3;
/** Columns the workspace keeps before any statistic is placed. */
const WORKSPACE_RESERVE = 40;

function blockWidth(...slots: SlotName[]): number {
    return slots.reduce((sum, slot) => sum + BAR + SLOT_WIDTH[slot], 0);
}

/**
 * Each reserved slot with the bar before it, cut from the right edge by the reserved widths alone and
 * stripped of trailing padding, so a blank slot reads as "". Every statistic is one column per character.
 */
function cellsOf(row: string, reserved: readonly SlotName[]): Record<SlotName, string | undefined> {
    const plain = stripTerminalSequences(row);
    const cells: Partial<Record<SlotName, string>> = {};
    let end = plain.length;
    for (const slot of [...reserved].reverse()) {
        const start = end - BAR - SLOT_WIDTH[slot];
        cells[slot] = plain.slice(start, end).trimEnd();
        end = start;
    }
    return cells as Record<SlotName, string | undefined>;
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

    it("puts the directory, branch and session name left and every statistic on a grid against the right edge", () => {
        const status = createStatus({
            sessionName: "my-session",
            usage: fullUsage,
            autoCompact: true,
        });

        const row = stripTerminalSequences(renderInfoRow(status, 160, identityTheme));

        assert.match(row, /^ \S {2}\/work\/project {2}\S \(main\) • my-session +│ /);
        const expected =
            " │ W400  │ R3.0k │ CH 50.0% │ ↑1.5k ↓20   │ $0.123  │  25k/200k · 12.3% │ (auto)";
        assert.equal(row.slice(-expected.length), expected);
        assert.equal(visibleWidth(row), 160);
    });

    it("reserves a fixed number of columns for each slot", () => {
        const status = createStatus({ usage: fullUsage, autoCompact: true });
        const row = renderInfoRow(status, 160, identityTheme);

        const actual = separatorColumns(row).map((column) => 160 - column);

        // Columns from each bar to the right edge: W, R, CH, tokens, cost, context, (auto).
        assert.deepEqual(actual, [79, 71, 63, 52, 38, 28, 8]);
    });

    it("draws only the context and (auto) in a fresh session, against the right edge", () => {
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

        assert.match(
            stripTerminalSequences(row),
            /^ \S {2}\/work\/project +│ {1,5}\d+k\/200k · +\d+\.\d%$/,
        );
    });

    it("shows an unknown context share as a question mark in its slot", () => {
        const status = createStatus({ context: { tokens: null, percent: null, window: 256_000 } });

        const actual = cellsOf(renderInfoRow(status, 160, identityTheme), WITHOUT_AUTO).context;

        assert.equal(actual, " │    ?/256k · ?");
    });

    it("puts each token counter right after its label, in columns of its own", () => {
        const rowFor = (usage: Partial<typeof fullUsage>) =>
            cellsOf(renderInfoRow(createStatus({ usage }), 160, identityTheme), WITHOUT_AUTO)
                .tokens;

        const actual = [
            rowFor({ input: 1500 }),
            rowFor({ output: 20 }),
            rowFor({ input: 1500, output: 20 }),
            rowFor({ input: 28_000, output: 5600 }),
        ];

        assert.deepEqual(actual, [" │ ↑1.5k", " │       ↓20", " │ ↑1.5k ↓20", " │ ↑28k  ↓5.6k"]);
    });

    it("gives cache reads and cache writes a slot each", () => {
        const cellsFor = (usage: Partial<typeof fullUsage>) =>
            cellsOf(renderInfoRow(createStatus({ usage }), 160, identityTheme), WITHOUT_AUTO);

        const read = cellsFor({ cacheRead: 3000, cacheHitRate: 40 });
        const write = cellsFor({ cacheWrite: 400, cacheHitRate: 0 });
        const both = cellsFor({ cacheRead: 187_000, cacheWrite: 4_500_000, cacheHitRate: 4 });

        assert.deepEqual([read.write, read.read, read.cacheHit], ["", " │ R3.0k", " │ CH 40.0%"]);
        assert.deepEqual([write.write, write.read, write.cacheHit], [" │ W400", "", " │ CH 0.0%"]);
        assert.deepEqual(
            [both.write, both.read, both.cacheHit],
            [" │ W4.5M", " │ R187k", " │ CH 4.0%"],
        );
    });

    it("quotes a cache-hit rate only when the cache was used and a rate exists", () => {
        const unused = renderInfoRow(
            createStatus({ usage: { cacheHitRate: 40 } }),
            160,
            identityTheme,
        );
        const unknown = renderInfoRow(
            createStatus({ usage: { cacheRead: 3000, cacheHitRate: undefined } }),
            160,
            identityTheme,
        );

        assert.equal(
            cellsOf(unused, WITHOUT_AUTO).cacheHit,
            "",
            "no cache traffic draws no CH slot",
        );
        assert.deepEqual(
            [cellsOf(unknown, WITHOUT_AUTO).read, cellsOf(unknown, WITHOUT_AUTO).cacheHit],
            [" │ R3.0k", ""],
            "no rate draws no CH slot",
        );
    });

    it("puts the cost right after its bar and spends fewer decimals as it grows", () => {
        const costs: [number, string][] = [
            [0.008, " │ $0.008"],
            [12.3456, " │ $12.346"],
            [123.456, " │ $123.46"],
            [1234.56, " │ $1234.6"],
            [12_345.67, " │ $12346"],
        ];

        for (const [cost, expected] of costs) {
            const row = renderInfoRow(createStatus({ usage: { cost } }), 160, identityTheme);
            assert.equal(cellsOf(row, WITHOUT_AUTO).cost, expected, `cost ${cost}`);
        }
    });

    it("leaves a zero counter blank, without a dash", () => {
        const cases: Partial<typeof fullUsage>[] = [
            { input: 28_000 },
            { output: 5600 },
            { cacheRead: 187_000 },
            { cacheWrite: 4_500_000 },
        ];

        for (const usage of cases) {
            const row = renderInfoRow(createStatus({ usage }), 160, identityTheme);

            assert.doesNotMatch(statsOf(row)!, /-|\b0\b/, JSON.stringify(usage));
        }
    });

    it("keeps the drawn slots together in an ordinary session whose provider reports no cache writes", () => {
        const status = createStatus({
            usage: { input: 900, output: 40, cacheRead: 187_000, cacheHitRate: 99, cost: 0.01 },
        });
        const row = renderInfoRow(status, 160, identityTheme);

        const actual = statsOf(row);

        // The blank cache-write slot sits left of every drawn one, inside the gap after the directory.
        assert.equal(actual, "R187k │ CH 99.0% │ ↑900  ↓40   │ $0.010  │  25k/200k · 12.3%");
        assert.equal(cellsOf(row, WITHOUT_AUTO).write, "");
    });

    it("draws nothing in a reserved slot until it has data", () => {
        const cases: [string, Partial<typeof fullUsage>, SlotName[]][] = [
            ["tokens", { input: 1500 }, ["tokens", "context"]],
            ["cost", { cost: 0.5 }, ["cost", "context"]],
            [
                "cache writes and CH",
                { cacheWrite: 400, cacheHitRate: 0 },
                ["write", "cacheHit", "context"],
            ],
        ];

        for (const [name, usage, expected] of cases) {
            const cells = cellsOf(
                renderInfoRow(createStatus({ usage }), 160, identityTheme),
                WITHOUT_AUTO,
            );

            const actual = WITHOUT_AUTO.filter((slot) => cells[slot] !== "");

            assert.deepEqual(actual, expected, name);
        }
    });

    it("formats token counts like Pi's footer, within four columns, carrying into the next unit", () => {
        const counts: [number, string][] = [
            [7, "7"],
            [999, "999"],
            [1234, "1.2k"],
            [9949, "9.9k"],
            [9950, "10k"],
            [12_345, "12k"],
            [999_499, "999k"],
            [999_500, "1.0M"],
            [999_999, "1.0M"],
            [1_500_000, "1.5M"],
            [12_000_000, "12M"],
            [999_999_999, "1.0G"],
            [2_500_000_000, "2.5G"],
        ];

        for (const [input, expected] of counts) {
            const row = renderInfoRow(
                createStatus({ usage: { input, output: 1 } }),
                160,
                identityTheme,
            );
            const tokens = cellsOf(row, WITHOUT_AUTO).tokens!;

            assert.equal(tokens.slice(BAR, BAR + 5), `↑${expected}`.padEnd(5), `${input} tokens`);
            assert.equal(tokens.indexOf("↓"), BAR + 6, `${input} tokens moved the output counter`);
        }
    });

    describe("layout stability", () => {
        const base = { sessionName: "my-session", autoCompact: true } as const;
        /** Every part of every slot has data, so each slot is drawn at its full reserved width. */
        const populated = {
            small: createStatus({
                ...base,
                usage: {
                    input: 7,
                    output: 3,
                    cacheRead: 1,
                    cacheWrite: 2,
                    cost: 0.001,
                    cacheHitRate: 0,
                },
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
                usage: {
                    input: 1500,
                    output: 1,
                    cost: 99.9999,
                    cacheRead: 3000,
                    cacheWrite: 5,
                    cacheHitRate: 99.96,
                },
                context: { tokens: 199_920, percent: 99.96, window: 200_000 },
            }),
            unknownContext: createStatus({
                ...base,
                usage: {
                    input: 1,
                    output: 42,
                    cacheRead: 77,
                    cacheWrite: 9,
                    cost: 5,
                    cacheHitRate: 12.3,
                },
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

        /** Thresholds follow from the reserved widths alone: 40 for the workspace plus each slot and its bar. */
        function reservedAt(width: number): SlotName[] {
            if (width >= 120) return ALL_SLOTS;
            if (width >= 112) return ["read", "cacheHit", "tokens", "cost", "context", "auto"];
            if (width >= 104) return ["cacheHit", "tokens", "cost", "context", "auto"];
            if (width >= 90) return ["cacheHit", "cost", "context", "auto"];
            if (width >= 80) return ["cacheHit", "context", "auto"];
            if (width >= 69) return ["context", "auto"];
            return ["context"];
        }

        const markers: Record<SlotName, string> = {
            write: "W",
            read: "R",
            cacheHit: "CH",
            tokens: "↑",
            cost: "$",
            context: "/200k ·",
            auto: "(auto)",
        };
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
                        [...reservedAt(width)].sort(),
                        `${name} at ${width} columns`,
                    );
                }
            }
        });

        it("draws a reserved slot only once it has data, whatever the width", () => {
            const fresh = createStatus({ ...base });

            for (let width = 40; width <= 170; width++) {
                const expected = reservedAt(width).filter(
                    (slot) => slot === "context" || slot === "auto",
                );

                assert.deepEqual(
                    drawn(renderInfoRow(fresh, width, identityTheme)).sort(),
                    expected.sort(),
                    `${width} columns`,
                );
            }
        });

        it("keeps every bar and label in place as data arrives, in whatever order", () => {
            const tokens = { input: 1500, output: 20 };
            const cost = { cost: 0.1234 };
            const read = { cacheRead: 3000, cacheHitRate: 50 };
            const write = { cacheWrite: 400 };
            // A session reports tokens and cost first; cache reads and writes follow when the provider has them.
            const orders = {
                session: [
                    {},
                    { ...tokens, ...cost },
                    { ...tokens, ...cost, ...read },
                    { ...tokens, ...cost, ...read, ...write },
                ],
                reverse: [
                    {},
                    { ...write },
                    { ...write, ...read },
                    { ...write, ...read, ...cost },
                    { ...write, ...read, ...cost, ...tokens },
                ],
                outputFirst: [
                    { output: 20 },
                    { ...tokens },
                    { ...tokens, cacheRead: 3000 },
                    { ...tokens, ...read },
                ],
            };
            const labels = ["W", "R", "CH", "↑", "↓", "$", "/200k", "(auto)"];
            const columnsOf = (row: string) => {
                const plain = stripTerminalSequences(row);
                return Object.fromEntries(
                    labels
                        .filter((label) => plain.includes(label))
                        .map((label) => [label, plain.indexOf(label)]),
                );
            };

            for (const width of [160, 120, 100]) {
                for (const [name, steps] of Object.entries(orders)) {
                    const rows = steps.map((usage) =>
                        renderInfoRow(createStatus({ ...base, usage }), width, identityTheme),
                    );

                    for (let step = 1; step < rows.length; step++) {
                        const before = rows[step - 1]!;
                        const after = rows[step]!;
                        const where = `${name} step ${step} at ${width} columns`;
                        assert.equal(visibleWidth(after), width, where);
                        for (const column of separatorColumns(before)) {
                            assert.ok(
                                separatorColumns(after).includes(column),
                                `bar at ${column} moved, ${where}`,
                            );
                        }
                        for (const [label, column] of Object.entries(columnsOf(before))) {
                            assert.equal(
                                columnsOf(after)[label],
                                column,
                                `"${label}" moved, ${where}`,
                            );
                        }
                    }
                }
            }
        });

        it("starts the right block at the same column for any directory, branch or session name", () => {
            const variants = [
                createStatus({ cwd: "/a", branch: null }),
                createStatus({ cwd: "/work/project", branch: "main", sessionName: "s" }),
                createStatus({
                    cwd: "/work/a-very/long/path/to/the/project",
                    branch: "feature/long-branch-name",
                }),
                createStatus({ cwd: "/工作/项目", branch: "分支🙂", sessionName: "会话" }),
            ];

            for (const width of [120, 100, 80]) {
                const starts = variants.map(
                    (status) => separatorColumns(renderInfoRow(status, width, identityTheme))[0],
                );

                assert.equal(new Set(starts).size, 1, `columns ${starts.join(", ")} at ${width}`);
            }
        });

        it("keeps the slash and the dot of the context slot in place when only the share changes", () => {
            const at = (percent: number | null) =>
                cellsOf(
                    renderInfoRow(
                        createStatus({ context: { tokens: 25_000, percent, window: 256_000 } }),
                        160,
                        identityTheme,
                    ),
                    WITHOUT_AUTO,
                ).context;

            assert.deepEqual(
                [at(9.9), at(12.3), at(100), at(null)],
                [
                    " │  25k/256k · 9.9%",
                    " │  25k/256k · 12.3%",
                    " │  25k/256k · 100%",
                    " │  25k/256k · ?",
                ],
            );
        });
    });

    describe("slot selection", () => {
        const status = createStatus({
            usage: { ...fullUsage },
            autoCompact: true,
        });
        const markers: Record<SlotName, string> = {
            write: "W400",
            read: "R3.0k",
            cacheHit: "CH 50.0%",
            tokens: "↑1.5k",
            cost: "$0.123",
            auto: "(auto)",
            context: " 25k/200k · 12.3%",
        };

        function present(width: number, subject = status): string[] {
            const stats = statsOf(renderInfoRow(subject, width, identityTheme)) ?? "";
            return Object.entries(markers)
                .filter(([, marker]) => stats.includes(marker))
                .map(([name]) => name);
        }

        it("keeps every slot once the workspace reserve and all reserved widths fit", () => {
            const needed = WORKSPACE_RESERVE + blockWidth(...ALL_SLOTS);

            assert.equal(needed, 120);
            assert.deepEqual(present(needed).sort(), Object.keys(markers).sort());
        });

        it("drops cache writes, then reads, then tokens, then cost, then CH, then (auto) as the width shrinks", () => {
            const survivors: SlotName[][] = [
                ["read", "cacheHit", "tokens", "cost", "context", "auto"],
                ["cacheHit", "tokens", "cost", "context", "auto"],
                ["cacheHit", "cost", "context", "auto"],
                ["cacheHit", "context", "auto"],
                ["context", "auto"],
                ["context"],
            ];

            for (const remaining of survivors) {
                const width = WORKSPACE_RESERVE + blockWidth(...remaining);

                assert.deepEqual(present(width).sort(), [...remaining].sort(), `${width} columns`);
            }
        });

        it("keeps a slot at the exact width where it fits and drops it one column earlier", () => {
            const thresholds: [SlotName, number][] = [
                ["write", WORKSPACE_RESERVE + blockWidth(...ALL_SLOTS)],
                [
                    "read",
                    WORKSPACE_RESERVE +
                        blockWidth("read", "cacheHit", "tokens", "cost", "context", "auto"),
                ],
                [
                    "tokens",
                    WORKSPACE_RESERVE + blockWidth("cacheHit", "tokens", "cost", "context", "auto"),
                ],
                ["cost", WORKSPACE_RESERVE + blockWidth("cacheHit", "cost", "context", "auto")],
                ["cacheHit", WORKSPACE_RESERVE + blockWidth("cacheHit", "context", "auto")],
                ["auto", WORKSPACE_RESERVE + blockWidth("context", "auto")],
            ];

            assert.deepEqual(
                thresholds.map(([, width]) => width),
                [120, 112, 104, 90, 80, 69],
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
            const needed = WORKSPACE_RESERVE + blockWidth(...WITHOUT_AUTO);

            assert.equal(needed, 111);
            assert.deepEqual(present(needed, without).sort(), [...WITHOUT_AUTO].sort());
            assert.ok(!present(needed - 1, without).includes("write"));
        });

        it("shows no tokens slot however large the counts, and keeps CH once cost has given way", () => {
            const large = createStatus({
                autoCompact: true,
                usage: { input: 5e8, output: 5e7, cost: 9999 },
            });
            const cached = createStatus({
                autoCompact: true,
                usage: { input: 5e8, output: 5e7, cost: 9999, cacheRead: 3000, cacheHitRate: 50 },
            });
            const zero = createStatus({ autoCompact: true });

            assert.deepEqual(slotsOf(renderInfoRow(large, 90, identityTheme)), [
                "$9999.0",
                " 25k/200k · 12.3%",
                "(auto)",
            ]);
            assert.deepEqual(slotsOf(renderInfoRow(large, 80, identityTheme)), [
                " 25k/200k · 12.3%",
                "(auto)",
            ]);
            assert.deepEqual(slotsOf(renderInfoRow(cached, 80, identityTheme)), [
                "CH 50.0%",
                " 25k/200k · 12.3%",
                "(auto)",
            ]);
            assert.deepEqual(slotsOf(renderInfoRow(zero, 80, identityTheme)), [
                " 25k/200k · 12.3%",
                "(auto)",
            ]);
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

    it("draws the statistics alone, against the right edge and without a leading bar", () => {
        const status = createStatus({ usage });

        const row = renderInfoRow(status, 70, identityTheme, { workspace: false, usage: true });

        assert.equal(
            stripTerminalSequences(row).trim(),
            "↑1.5k ↓20   │ $0.500  │  25k/200k · 12.3%",
        );
        assert.equal(visibleWidth(row), 70);
        assert.match(
            stripTerminalSequences(row),
            /^ +↑/,
            "the row starts with padding, not a separator",
        );
    });

    it("draws the bar of the leftmost slot once a slot further left gains data", () => {
        const parts = { workspace: false, usage: true };
        const before = renderInfoRow(createStatus({ usage }), 80, identityTheme, parts);
        const after = renderInfoRow(
            createStatus({ usage: { ...usage, cacheRead: 3000 } }),
            80,
            identityTheme,
            parts,
        );

        const expected = stripTerminalSequences(before).replace(/ {3}↑/, " │ ↑");
        const actual = stripTerminalSequences(after).replace(/R3\.0k/, "     ");

        assert.equal(actual, expected);
    });

    it("gives the statistics the whole width when the directory is hidden", () => {
        const cached = { ...usage, cacheRead: 3000, cacheWrite: 400, cacheHitRate: 50 };
        const status = createStatus({ usage: cached, autoCompact: true });
        const all = blockWidth(...ALL_SLOTS);
        const parts = { workspace: false, usage: true };

        const fits = stripTerminalSequences(renderInfoRow(status, all, identityTheme, parts));
        const oneShort = stripTerminalSequences(
            renderInfoRow(status, all - 1, identityTheme, parts),
        );

        assert.equal(all, 80);
        assert.match(fits, /^ {3}W400 .*R3\.0k.*CH.*\(auto\)$/);
        assert.doesNotMatch(oneShort, /W400/, "the cache-write slot goes first");
        assert.match(oneShort, /^ +R3\.0k │ CH/);
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
                assert.ok(
                    visibleWidth(row) <= width,
                    `${JSON.stringify(parts)} width ${width}: ${JSON.stringify(row)}`,
                );
            }
        }
    });
});

describe("dock context cell", () => {
    const cell = (tokens: number | null, percent: number | null, window = 256_000) =>
        stripTerminalSequences(
            renderContextCell(
                createStatus({ context: { tokens, percent, window } }),
                identityTheme,
            ),
        );

    it("shows used tokens, the window and the share, in that order", () => {
        const actual = cell(25_000, 9.8);

        assert.equal(actual, " 25k/256k · 9.8% ");
        assert.ok(
            actual.indexOf("25k") < actual.indexOf("256k") &&
                actual.indexOf("256k") < actual.indexOf("9.8%"),
        );
    });

    it("right-aligns the used tokens, so the slash and the share keep their columns", () => {
        assert.deepEqual(
            [cell(0, 0), cell(25_000, 9.9), cell(88_000, 34.34), cell(179_200, 70)],
            ["   0/256k · 0.0% ", " 25k/256k · 9.9% ", " 88k/256k · 34.3%", "179k/256k · 70.0%"],
        );
    });

    it("separates the window from the share with a middle dot", () => {
        assert.match(cell(25_000, 9.8), /256k · 9\.8% *$/);
    });

    it("shows a whole percentage from 99.95 so 100% costs no extra column", () => {
        assert.deepEqual(
            [cell(255_800, 99.94), cell(255_900, 99.95), cell(256_000, 100)],
            ["256k/256k · 99.9%", "256k/256k · 100% ", "256k/256k · 100% "],
        );
    });

    it("shows unknown tokens and an unknown share as question marks in their own fields", () => {
        assert.deepEqual(
            [cell(null, 12.3), cell(25_000, null), cell(null, null, 1_000_000)],
            ["   ?/256k · 12.3%", " 25k/256k · ?    ", "   ?/1.0M · ?    "],
        );
    });

    it("keeps the same width whether or not the fields are known", () => {
        const widths = [
            cell(null, null),
            cell(null, 12.3),
            cell(25_000, null),
            cell(25_000, 12.3),
        ].map(visibleWidth);

        assert.deepEqual(widths, [17, 17, 17, 17]);
    });

    it("keeps the same width as used tokens grow", () => {
        const counts = [0, 999, 1000, 25_000, 999_000];

        const actual = counts.map((tokens) => visibleWidth(cell(tokens, 12.3)));

        assert.deepEqual(
            actual,
            counts.map(() => 17),
        );
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

        assert.deepEqual(
            [colorFor(70), colorFor(70.1), colorFor(90), colorFor(90.1)],
            ["muted", "warning", "warning", "error"],
        );
    });

    it("stays muted, with the same padding, while the share is unknown", () => {
        const { theme, colorsOf } = createRecordingTheme();

        renderContextCell(createStatus({ context: createContext(null, 200_000) }), theme);

        assert.deepEqual(colorsOf(cell(null, null, 200_000)), ["muted"]);
    });
});
