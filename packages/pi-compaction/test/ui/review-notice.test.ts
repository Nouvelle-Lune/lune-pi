import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { CompactionRunUpdate, CompactionStage } from "../../src/compaction-controller.ts";
import type { ProtectedTool, ResultChunk } from "../../src/tool-review/candidates.ts";
import type { ChunkDecision, ToolReviewReport } from "../../src/tool-review/review.ts";
import {
    COMPACT_NOTICE_WIDTH,
    FULL_NOTICE_WIDTH,
    REVIEW_ENTRY_TYPE,
    REVIEW_NOTICE_WIDGET,
    createReviewNotice,
    parseToolReviewRecord,
    reviewEntryLines,
    reviewProgressLine,
    reviewProgressView,
    toolReviewRecord,
    type ProtectedCategory,
    type ReviewProgressView,
    type ToolReviewRecord,
} from "../../src/ui/review-notice.ts";
import { markerTheme, plainTheme, recordWidgets } from "../harness/widget-ui.ts";

const STAGES: CompactionStage[] = [
    "preparing",
    "chunks",
    "summarizing",
    "awaiting-commit",
    "complete",
    "failed",
    "cancelled",
];

/** A report whose chunk decisions are given per call: drop, keep. */
function report(
    options: {
        calls?: Record<string, Array<"drop" | "keep">>;
        removedCalls?: string[];
        protectedTools?: ProtectedTool[];
        charsBefore?: number;
        charsAfterTruncation?: number;
        charsAfter?: number;
    } = {},
): ToolReviewReport {
    const calls = options.calls ?? { r1: ["drop", "keep"], r2: ["drop", "drop"] };
    const chunks: ResultChunk[] = [];
    const chunkDecisions: ChunkDecision[] = [];
    for (const [toolCallId, actions] of Object.entries(calls)) {
        actions.forEach((action, index) => {
            const chunkId = `${toolCallId}-c${index}`;
            chunks.push({
                id: chunkId,
                toolCallId,
                blockIndex: 0,
                start: index * 10,
                end: index * 10 + 10,
                text: chunkId,
            });
            chunkDecisions.push({ chunkId, probability: action === "drop" ? 1 : 0, action });
        });
    }
    return {
        model: "provider/jev-latest",
        pricingKnown: true,
        protectedTools: options.protectedTools ?? [{ id: "w", reasons: ["tool-not-deletable"] }],
        candidateTools: Object.keys(calls).length,
        chunks,
        chunkDecisions,
        removedCalls: options.removedCalls ?? ["r2"],
        oversizedRequests: 0,
        requests: chunks.length,
        requestBudget: 1000,
        budgetFallbacks: [],
        usage: [],
        charsBefore: options.charsBefore ?? 120_000,
        charsAfterTruncation: options.charsAfterTruncation ?? 80_000,
        charsAfter: options.charsAfter ?? 30_000,
    };
}

function update(
    stage: CompactionStage,
    overrides: Partial<CompactionRunUpdate> = {},
): CompactionRunUpdate {
    return {
        runId: 1,
        stage,
        completedBatches: 0,
        totalBatches: 0,
        ...overrides,
    };
}

const FINISHED: CompactionStage[] = ["complete", "failed", "cancelled"];

/** An update carrying everything a real run knows at the given stage. */
function richUpdate(stage: CompactionStage): CompactionRunUpdate {
    return update(stage, {
        candidateTools: 2,
        protectedTools: 1,
        completedBatches: 3,
        totalBatches: 4,
        ...(stage === "summarizing" || stage === "awaiting-commit" || FINISHED.includes(stage)
            ? { jev: report() }
            : {}),
    });
}

/** The saved record behind the examples: 33 calls, 12 reviewed, 21 protected, 989k to 515k. */
function exampleRecord(overrides: Partial<ToolReviewRecord> = {}): ToolReviewRecord {
    return {
        version: 1,
        model: "provider/jev-latest",
        candidateTools: 12,
        protectedTools: 21,
        protectedReasons: [
            { category: "nested", count: 16 },
            { category: "recent", count: 4 },
            { category: "error", count: 1 },
        ],
        removedCalls: 3,
        droppedFragments: 13,
        placeholders: 0,
        unreviewed: 0,
        charsBefore: 989_000,
        charsAfterTruncation: 546_000,
        charsAfter: 515_000,
        ...overrides,
    };
}

const RUNNING: CompactionStage[] = ["preparing", "chunks", "summarizing", "awaiting-commit"];

test("record: counts come from the report and drops inside removed calls are not fragments", () => {
    const actual = toolReviewRecord(report({ charsBefore: 1000, charsAfterTruncation: 800 }));
    const expected: ToolReviewRecord = {
        version: 1,
        model: "provider/jev-latest",
        candidateTools: 2,
        protectedTools: 1,
        protectedReasons: [{ category: "not-permitted", count: 1 }],
        removedCalls: 1,
        droppedFragments: 1,
        placeholders: 0,
        unreviewed: 0,
        charsBefore: 1000,
        charsAfterTruncation: 800,
        charsAfter: 30_000,
    };
    assert.deepEqual(actual, expected);
});

test("record: each protected tool counts once under its first matching category, largest first", () => {
    const tools: ProtectedTool[] = [
        { id: "a", reasons: ["error-result", "retained-region"] },
        { id: "b", reasons: ["error-result"] },
        { id: "c", reasons: ["error-result", "non-text-result"] },
        { id: "d", reasons: ["nested-call-failed", "tool-not-deletable"] },
        { id: "e", reasons: ["nested-call-failed", "non-text-result"] },
        { id: "f", reasons: ["incomplete-nested-calls"] },
        { id: "g", reasons: ["nested-tool-not-deletable"] },
        { id: "h", reasons: ["non-text-result"] },
        { id: "i", reasons: ["unpaired-or-duplicate-id"] },
    ];
    const record = toolReviewRecord(report({ protectedTools: tools }));
    // Ties (media, other) keep category priority order.
    const expected: { category: ProtectedCategory; count: number }[] = [
        { category: "nested", count: 3 },
        { category: "error", count: 2 },
        { category: "recent", count: 1 },
        { category: "not-permitted", count: 1 },
        { category: "media", count: 1 },
        { category: "other", count: 1 },
    ];
    assert.deepEqual(record.protectedReasons, expected);
    assert.equal(record.protectedTools, 9);
});

test("record: the largest category leads even when it has the lowest priority", () => {
    const tools: ProtectedTool[] = [
        { id: "a", reasons: ["retained-region"] },
        { id: "b", reasons: ["unknown"] },
        { id: "c", reasons: [] },
    ];
    const actual = toolReviewRecord(report({ protectedTools: tools })).protectedReasons;
    assert.deepEqual(actual, [
        { category: "other", count: 2 },
        { category: "recent", count: 1 },
    ]);
});

test("record: parsing accepts a valid record and returns it unchanged", () => {
    const record = exampleRecord();
    assert.deepEqual(parseToolReviewRecord(JSON.parse(JSON.stringify(record))), record);
    assert.deepEqual(parseToolReviewRecord(toolReviewRecord(report())), toolReviewRecord(report()));
});

test("record: every malformed variant is rejected as a malformed record", () => {
    const valid = exampleRecord() as unknown as Record<string, unknown>;
    const variants: Record<string, unknown> = {
        undefined: undefined,
        null: null,
        string: "record",
        "wrong version": { ...valid, version: 2 },
        "missing version": { ...valid, version: undefined },
        "non-string model": { ...valid, model: 7 },
        "reasons not an array": { ...valid, protectedReasons: {} },
        "reason not an object": { ...valid, protectedReasons: ["nested"] },
        "reason null": { ...valid, protectedReasons: [null] },
        "unknown category": { ...valid, protectedReasons: [{ category: "bogus", count: 1 }] },
        "negative reason count": {
            ...valid,
            protectedReasons: [{ category: "nested", count: -1 }],
        },
        "fractional reason count": {
            ...valid,
            protectedReasons: [{ category: "nested", count: 1.5 }],
        },
    };
    for (const field of [
        "candidateTools",
        "protectedTools",
        "removedCalls",
        "droppedFragments",
        "placeholders",
        "unreviewed",
        "charsBefore",
        "charsAfterTruncation",
        "charsAfter",
    ]) {
        variants[`${field} missing`] = { ...valid, [field]: undefined };
        variants[`${field} negative`] = { ...valid, [field]: -1 };
        variants[`${field} fractional`] = { ...valid, [field]: 0.5 };
        variants[`${field} string`] = { ...valid, [field]: "3" };
        variants[`${field} unsafe`] = { ...valid, [field]: Number.MAX_SAFE_INTEGER + 1 };
        variants[`${field} NaN`] = { ...valid, [field]: Number.NaN };
    }
    for (const [name, data] of Object.entries(variants))
        assert.throws(
            () => parseToolReviewRecord(data),
            { message: "Malformed tool review record" },
            name,
        );
});

test("view: running stages map to their display state and settled stages have no view", () => {
    const expected = {
        preparing: "preparing",
        chunks: "reviewing",
        summarizing: "summarizing",
        "awaiting-commit": "summarizing",
        complete: undefined,
        failed: undefined,
        cancelled: undefined,
    };
    const actual = Object.fromEntries(
        STAGES.map((stage) => [stage, reviewProgressView(update(stage))?.state]),
    );
    assert.deepEqual(actual, expected);
});

test("view: total calls is the candidate and protected counts together, unknown until both exist", () => {
    const known = reviewProgressView(update("chunks", { candidateTools: 5, protectedTools: 3 }));
    assert.deepEqual(known?.calls, { total: 8, reviewed: 5 });
    assert.equal(reviewProgressView(update("preparing"))?.calls, undefined);
    assert.equal(reviewProgressView(update("chunks", { candidateTools: 2 }))?.calls, undefined);
});

test("view: batch progress exists only while reviewing", () => {
    for (const stage of RUNNING) {
        const view = reviewProgressView(update(stage, { completedBatches: 1, totalBatches: 3 }));
        const expected = stage === "chunks" ? { completed: 1, total: 3 } : undefined;
        assert.deepEqual(view?.batches, expected, stage);
    }
});

test("view: the result appears once the report exists", () => {
    assert.equal(reviewProgressView(update("chunks"))?.result, undefined);
    const jev = report();
    for (const stage of ["chunks", "summarizing", "awaiting-commit"] as const)
        assert.deepEqual(reviewProgressView(update(stage, { jev }))?.result, toolReviewRecord(jev));
});

test("progress line: the documented rows are produced at a wide width", () => {
    const line = (view: ReviewProgressView): string => reviewProgressLine(view, 120, plainTheme());
    assert.equal(line({ state: "preparing" }), "◐ Tool review · preparing");
    assert.equal(
        line({
            state: "reviewing",
            calls: { total: 33, reviewed: 12 },
            batches: { completed: 7, total: 24 },
        }),
        "◐ Tool review · 33 calls · 12 in review · 7/24 requests",
    );
    assert.equal(
        line({ state: "summarizing", result: exampleRecord() }),
        "◐ Tool review · summarizing · −3 calls · −13 fragments · 989k → 515k",
    );
});

test("progress line: parts give way whole down to the marker and never exceed the width", () => {
    const views: ReviewProgressView[] = [
        { state: "preparing" },
        {
            state: "reviewing",
            calls: { total: 33, reviewed: 12 },
            batches: { completed: 7, total: 24 },
        },
        { state: "summarizing", result: exampleRecord() },
        { state: "summarizing", result: exampleRecord({ removedCalls: 0, droppedFragments: 0 }) },
    ];
    for (const view of views) {
        let previous = Number.POSITIVE_INFINITY;
        for (let width = 120; width >= 1; width--) {
            const line = reviewProgressLine(view, width, plainTheme());
            assert.ok(visibleWidth(line) <= width, `${view.state} ${width}: "${line}"`);
            assert.ok(!line.includes("…"), `${view.state} ${width}: "${line}"`);
            assert.ok(line.startsWith("◐"), `${view.state} ${width}: "${line}"`);
            assert.ok(visibleWidth(line) <= previous, `${view.state} ${width} grew`);
            previous = visibleWidth(line);
        }
        assert.equal(reviewProgressLine(view, 1, plainTheme()), "◐");
    }
});

test("progress line: a narrow summarizing row keeps the removed calls and drops the size first", () => {
    const wide = "◐ Tool review · summarizing · −3 calls · −13 fragments · 989k → 515k";
    const narrower = reviewProgressLine(
        { state: "summarizing", result: exampleRecord() },
        visibleWidth(wide) - 1,
        plainTheme(),
    );
    assert.ok(narrower.includes("−3 calls"), narrower);
    assert.ok(!narrower.includes("989k"), narrower);
});

test("progress line: a zero width renders nothing", () => {
    assert.equal(reviewProgressLine({ state: "preparing" }, 0, plainTheme()), "");
});

test("progress line: colors are resolved at render time from the theme", () => {
    const line = reviewProgressLine({ state: "preparing" }, 120, markerTheme());
    assert.ok(line.includes("<accent>◐"), line);
    assert.ok(line.includes("<muted>preparing"), line);
});

test("entry: the collapsed row shows the edits and the size", () => {
    const rows = reviewEntryLines(exampleRecord(), 120, plainTheme(), false);
    assert.deepEqual(rows, ["◇ Tool review · −3 calls · −13 fragments · 989k → 515k"]);
});

test("entry: a record without edits says nothing was removed", () => {
    const record = exampleRecord({ removedCalls: 0, droppedFragments: 0 });
    const rows = reviewEntryLines(record, 120, plainTheme(), false);
    assert.deepEqual(rows, ["◇ Tool review · nothing removed · 989k → 515k"]);
});

test("entry: the expanded full-width form has a header, a calls row and a result row", () => {
    const rows = reviewEntryLines(exampleRecord(), 120, plainTheme(), true);
    assert.deepEqual(rows, [
        "◇ Tool review · provider/jev-latest",
        "  33 calls · 12 reviewed · 21 protected (16 nested · 4 recent · 1 error)",
        "  −3 calls · −13 fragments · 989k → 515k · truncation −443k · classifier −31k",
    ]);
});

test("entry: the middle widths merge the details into one row under the header", () => {
    for (const width of [COMPACT_NOTICE_WIDTH, 60, FULL_NOTICE_WIDTH - 1]) {
        const rows = reviewEntryLines(exampleRecord(), width, plainTheme(), true);
        assert.ok(rows.length <= 2 && rows.length >= 1, `${width}: ${rows.length} rows`);
        assert.ok(rows[0]!.includes("Tool review"), rows[0]);
        if (rows.length === 2) assert.ok(rows[1]!.includes("−3 calls"), `${width}: ${rows[1]}`);
    }
});

test("entry: below the compact width the expanded form is one row without the model", () => {
    const rows = reviewEntryLines(exampleRecord(), COMPACT_NOTICE_WIDTH - 1, plainTheme(), true);
    assert.equal(rows.length, 1);
    assert.ok(!rows[0]!.includes("jev-latest"), rows[0]);
    assert.ok(rows[0]!.includes("−3 calls"), rows[0]);
});

test("entry: the model is the first part to drop", () => {
    const model = "provider/a-very-long-classifier-model-identifier-latest";
    const record = exampleRecord({ model });
    const wide = reviewEntryLines(record, 100, plainTheme(), true);
    assert.equal(wide[0], `◇ Tool review · ${model}`);
    // At the compact boundary the header is narrower than the model line, so the model gives way.
    const narrow = reviewEntryLines(record, COMPACT_NOTICE_WIDTH, plainTheme(), true);
    assert.equal(narrow[0], "◇ Tool review");
    assert.ok(narrow.slice(1).some((row) => row.includes("−3 calls")));
});

test("entry: every record and mode fits every width with no ellipsis and sane row counts", () => {
    const records = [
        exampleRecord(),
        exampleRecord({ removedCalls: 0, droppedFragments: 0 }),
        exampleRecord({ placeholders: 2, unreviewed: 3, protectedReasons: [] }),
        exampleRecord({ model: "provider/a-very-long-classifier-model-identifier-latest" }),
        exampleRecord({ charsAfter: 600_000, charsAfterTruncation: 400_000 }),
    ];
    for (const record of records)
        for (const expanded of [false, true])
            for (let width = 1; width <= 120; width++) {
                const rows = reviewEntryLines(record, width, plainTheme(), expanded);
                const label = `${expanded ? "expanded" : "collapsed"} ${width}`;
                const maximum =
                    !expanded || width < COMPACT_NOTICE_WIDTH
                        ? 1
                        : width < FULL_NOTICE_WIDTH
                          ? 2
                          : 3;
                assert.ok(rows.length >= 1 && rows.length <= maximum, `${label}: ${rows.length}`);
                if (!expanded || width < COMPACT_NOTICE_WIDTH) assert.equal(rows.length, 1, label);
                assert.notEqual(rows[0]!.trim(), "", label);
                for (const row of rows) {
                    assert.ok(visibleWidth(row) <= width, `${label}: "${row}"`);
                    assert.ok(!row.includes("…"), `${label}: "${row}"`);
                }
            }
});

test("entry: sizes are rounded and savings carry their sign", () => {
    const record = exampleRecord({
        charsBefore: 1_200_000,
        charsAfterTruncation: 1_300_000,
        charsAfter: 1_300_000,
    });
    const rows = reviewEntryLines(record, 120, plainTheme(), true);
    assert.ok(rows[2]!.includes("1.2M → 1.3M"), rows[2]);
    assert.ok(rows[2]!.includes("truncation +100k"), rows[2]);
    assert.ok(rows[2]!.includes("classifier ±0"), rows[2]);
});

test("entry: colors are resolved at render time from the theme", () => {
    const rows = reviewEntryLines(exampleRecord(), 120, markerTheme(), true).join("\n");
    assert.ok(rows.includes("<accent>◇"), rows);
    assert.ok(rows.includes("<muted>provider/jev-latest"), rows);
});

interface Piece {
    readonly pi: ExtensionAPI;
    readonly renderers: Map<string, (...args: never[]) => unknown>;
    readonly appended: { customType: string; data: unknown }[];
}

function stubPi(): Piece {
    const renderers = new Map<string, (...args: never[]) => unknown>();
    const appended: { customType: string; data: unknown }[] = [];
    const pi = {
        registerEntryRenderer: (type: string, renderer: (...args: never[]) => unknown) => {
            renderers.set(type, renderer);
        },
        appendEntry: (customType: string, data: unknown) => {
            appended.push({ customType, data });
        },
    } as unknown as ExtensionAPI;
    return { pi, renderers, appended };
}

function context(hasUI: boolean, widgets: { setWidget: (...args: never[]) => void }) {
    return { hasUI, ui: { setWidget: widgets.setWidget } } as unknown as ExtensionContext;
}

/** RPC reports a usable UI, but its widget surface renders lines instead of mounting factories. */
function rpcContext(
    widgets: { setWidget: (...args: never[]) => void },
    hasUI = true,
): ExtensionContext {
    return {
        hasUI,
        mode: "rpc",
        ui: { setWidget: widgets.setWidget },
    } as unknown as ExtensionContext;
}

/** The shared recorder types content as a factory, so RPC lines are narrowed by hand. */
function rpcLines(widgets: ReturnType<typeof recordWidgets>, index = 0): string[] {
    const content: unknown = widgets.calls[index]!.content;
    assert.ok(Array.isArray(content), `call ${index} must send lines instead of a factory`);
    assert.ok(
        content.every((line) => typeof line === "string"),
        `call ${index} must send only string lines`,
    );
    return content as string[];
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

test("notice: creating it registers the entry renderer for the review type", () => {
    const { pi, renderers } = stubPi();
    createReviewNotice(pi);
    assert.deepEqual([...renderers.keys()], [REVIEW_ENTRY_TYPE]);
    assert.equal(REVIEW_ENTRY_TYPE, "lune-compaction-review");
});

test("notice: a context without a UI does nothing, yet the renderer is registered", async () => {
    const { pi, renderers, appended } = stubPi();
    const widgets = recordWidgets();
    const listener = createReviewNotice(pi);
    listener(update("chunks"), context(false, widgets));
    listener(richUpdate("complete"), context(false, widgets));
    listener(undefined, context(false, widgets));
    await macrotask();
    assert.deepEqual(widgets.calls, []);
    assert.deepEqual(appended, []);
    assert.equal(renderers.size, 1);
});

test("notice: the first update mounts one single-row widget above the editor", () => {
    const widgets = recordWidgets();
    createReviewNotice(stubPi().pi)(update("preparing"), context(true, widgets));
    assert.equal(widgets.calls.length, 1);
    assert.equal(widgets.calls[0]!.key, REVIEW_NOTICE_WIDGET);
    assert.equal(typeof widgets.calls[0]!.content, "function");
    assert.deepEqual(widgets.calls[0]!.options, { placement: "aboveEditor" });
    assert.deepEqual(widgets.component()!.render(100), ["◐ Tool review · preparing"]);
});

test("notice: later updates re-render the mounted component instead of mounting again", () => {
    const widgets = recordWidgets();
    const listener = createReviewNotice(stubPi().pi);
    const ctx = context(true, widgets);
    listener(update("preparing"), ctx);
    listener(richUpdate("summarizing"), ctx);
    const after = widgets.component()!.render(100).join("\n");
    assert.equal(widgets.calls.length, 1);
    assert.equal(widgets.tui.renders, 1);
    assert.ok(after.includes("−1 call"), after);
    assert.ok(!after.includes("preparing") || after.includes("summarizing"), after);
});

test("notice: every settled stage clears a shown widget and leaves nothing pinned", () => {
    for (const stage of FINISHED) {
        const widgets = recordWidgets();
        const listener = createReviewNotice(stubPi().pi);
        const ctx = context(true, widgets);
        listener(update("chunks"), ctx);
        listener(richUpdate(stage), ctx);
        assert.equal(widgets.calls.length, 2, stage);
        assert.equal(widgets.calls[1]!.key, REVIEW_NOTICE_WIDGET, stage);
        assert.equal(widgets.calls[1]!.content, undefined, stage);
        assert.equal(widgets.component(), undefined, stage);
    }
});

test("notice: clearing sends nothing unless something was shown", () => {
    const widgets = recordWidgets();
    const listener = createReviewNotice(stubPi().pi);
    const ctx = context(true, widgets);
    listener(undefined, ctx);
    listener(richUpdate("complete"), ctx);
    assert.equal(widgets.calls.length, 0);
    listener(update("preparing"), ctx);
    listener(undefined, ctx);
    assert.equal(widgets.calls.length, 2);
    assert.equal(widgets.calls[1]!.content, undefined);
    listener(undefined, ctx);
    assert.equal(widgets.calls.length, 2);
});

test("notice: after Pi disposes the component the next update mounts a new one", () => {
    const widgets = recordWidgets();
    const listener = createReviewNotice(stubPi().pi);
    const ctx = context(true, widgets);
    listener(update("preparing"), ctx);
    widgets.component()!.dispose?.();
    listener(update("chunks"), ctx);
    assert.equal(widgets.calls.length, 2);
    assert.equal(typeof widgets.calls[1]!.content, "function");
});

test("notice: a completed report is appended as an entry only after a macrotask", async () => {
    const { pi, appended } = stubPi();
    const widgets = recordWidgets();
    const listener = createReviewNotice(pi);
    const jev = report();
    listener(update("complete", { jev }), context(true, widgets));
    await Promise.resolve();
    assert.deepEqual(appended, [], "the entry must not land before Pi rebuilds its transcript");
    await macrotask();
    assert.deepEqual(appended, [{ customType: REVIEW_ENTRY_TYPE, data: toolReviewRecord(jev) }]);
});

test("notice: a complete update without a report appends nothing", async () => {
    const { pi, appended } = stubPi();
    createReviewNotice(pi)(update("complete"), context(true, recordWidgets()));
    await macrotask();
    assert.deepEqual(appended, []);
});

test("notice: failed and cancelled runs never append an entry", async () => {
    const { pi, appended } = stubPi();
    const listener = createReviewNotice(pi);
    for (const stage of ["failed", "cancelled"] as const)
        listener(richUpdate(stage), context(true, recordWidgets()));
    await macrotask();
    assert.deepEqual(appended, []);
});

test("notice: a failing append is logged and does not throw", async (t) => {
    const warned = t.mock.method(console, "warn", () => undefined);
    const pi = {
        registerEntryRenderer: () => undefined,
        appendEntry: () => {
            throw new Error("session closed");
        },
    } as unknown as ExtensionAPI;
    createReviewNotice(pi)(richUpdate("complete"), context(true, recordWidgets()));
    await macrotask();
    assert.equal(warned.mock.callCount(), 1);
});

test("notice: a render failure renders nothing, logs, and clears the widget after the render", async (t) => {
    const logged = t.mock.method(console, "error", () => undefined);
    const broken = {
        fg: () => {
            throw new Error("theme exploded");
        },
    } as never;
    const widgets = recordWidgets(broken);
    createReviewNotice(stubPi().pi)(update("preparing"), context(true, widgets));
    const lines = widgets.component()!.render(100);
    assert.deepEqual(lines, []);
    assert.equal(logged.mock.callCount(), 1);
    // Pi is mid-render, so the clear must wait for a microtask.
    assert.equal(widgets.calls.length, 1);
    await Promise.resolve();
    assert.equal(widgets.calls.length, 2);
    assert.equal(widgets.calls[1]!.key, REVIEW_NOTICE_WIDGET);
    assert.equal(widgets.calls[1]!.content, undefined);
    assert.deepEqual(widgets.component()?.render(100) ?? [], []);
});

test("notice: an RPC context receives the plain row at width 80 above the editor", () => {
    const widgets = recordWidgets();
    createReviewNotice(stubPi().pi)(update("preparing"), rpcContext(widgets));
    assert.equal(widgets.calls.length, 1);
    assert.equal(widgets.calls[0]!.key, REVIEW_NOTICE_WIDGET);
    assert.deepEqual(widgets.calls[0]!.options, { placement: "aboveEditor" });
    assert.deepEqual(rpcLines(widgets), ["◐ Tool review · preparing"]);
});

test("notice: every RPC update sends a new row that fits 80 columns", () => {
    const widgets = recordWidgets();
    const listener = createReviewNotice(stubPi().pi);
    const ctx = rpcContext(widgets);
    listener(
        update("chunks", {
            candidateTools: 2,
            protectedTools: 1,
            completedBatches: 1,
            totalBatches: 3,
        }),
        ctx,
    );
    listener(richUpdate("summarizing"), ctx);
    assert.equal(widgets.calls.length, 2);
    assert.equal(rpcLines(widgets, 0).length, 1);
    assert.ok(rpcLines(widgets, 0)[0]!.includes("2 in review"));
    assert.ok(rpcLines(widgets, 1)[0]!.includes("−1 call"));
    for (const index of [0, 1]) assert.ok(visibleWidth(rpcLines(widgets, index)[0]!) <= 80);
});

test("notice: RPC terminal stages and clears send undefined content", async () => {
    for (const stage of FINISHED) {
        const { pi } = stubPi();
        const widgets = recordWidgets();
        const listener = createReviewNotice(pi);
        listener(richUpdate(stage), rpcContext(widgets));
        assert.equal(widgets.calls.length, 1, stage);
        assert.equal(widgets.calls[0]!.content, undefined, stage);
        assert.deepEqual(widgets.calls[0]!.options, { placement: "aboveEditor" }, stage);
    }
    const widgets = recordWidgets();
    createReviewNotice(stubPi().pi)(undefined, rpcContext(widgets));
    assert.equal(widgets.calls[0]!.content, undefined);
});

test("notice: an RPC completion still appends the entry after a macrotask", async () => {
    const { pi, appended } = stubPi();
    const jev = report();
    createReviewNotice(pi)(update("complete", { jev }), rpcContext(recordWidgets()));
    assert.deepEqual(appended, []);
    await macrotask();
    assert.deepEqual(appended, [{ customType: REVIEW_ENTRY_TYPE, data: toolReviewRecord(jev) }]);
});

test("notice: an RPC context without a UI does nothing", async () => {
    const { pi, appended } = stubPi();
    const widgets = recordWidgets();
    const listener = createReviewNotice(pi);
    const ctx = rpcContext(widgets, false);
    listener(update("chunks"), ctx);
    listener(richUpdate("complete"), ctx);
    listener(undefined, ctx);
    await macrotask();
    assert.deepEqual(widgets.calls, []);
    assert.deepEqual(appended, []);
});

function renderEntry(piece: Piece, data: unknown, expanded: boolean, theme: Theme = plainTheme()) {
    const renderer = piece.renderers.get(REVIEW_ENTRY_TYPE)!;
    return (renderer as (...args: unknown[]) => { render(width: number): string[] })(
        { type: "custom", customType: REVIEW_ENTRY_TYPE, data },
        { expanded },
        theme,
    );
}

test("renderer: rows carry one column of padding and fit the width", () => {
    const piece = stubPi();
    createReviewNotice(piece.pi);
    for (const expanded of [false, true])
        for (const width of [2, 30, COMPACT_NOTICE_WIDTH, 60, 100]) {
            const rows = renderEntry(piece, exampleRecord(), expanded).render(width);
            const expected = reviewEntryLines(exampleRecord(), width - 1, plainTheme(), expanded);
            assert.deepEqual(
                rows,
                expected.map((row) => ` ${row}`),
                `${expanded} ${width}`,
            );
            for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: "${row}"`);
        }
});

test("renderer: the theme passed at render time colors the rows", () => {
    const piece = stubPi();
    createReviewNotice(piece.pi);
    const rows = renderEntry(piece, exampleRecord(), false, markerTheme()).render(100);
    assert.ok(rows[0]!.startsWith(" <accent>◇"), rows[0]);
});

test("renderer: malformed entry data makes the renderer throw", () => {
    const piece = stubPi();
    createReviewNotice(piece.pi);
    assert.throws(() => renderEntry(piece, { version: 1 }, false), {
        message: "Malformed tool review record",
    });
    assert.throws(() => renderEntry(piece, undefined, true), {
        message: "Malformed tool review record",
    });
});
