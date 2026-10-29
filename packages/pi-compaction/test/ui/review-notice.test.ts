import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionRunUpdate, CompactionStage } from "../../src/compaction-controller.ts";
import type { ProtectedTool, ResultChunk } from "../../src/tool-review/candidates.ts";
import type { ChunkDecision, ToolReviewReport } from "../../src/tool-review/review.ts";
import {
    COMPACT_NOTICE_WIDTH,
    FULL_NOTICE_WIDTH,
    REVIEW_NOTICE_WIDGET,
    createReviewNotice,
    reviewNoticeLines,
    reviewNoticeView,
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

/** An update carrying everything a real run knows at the given stage. */
function richUpdate(stage: CompactionStage): CompactionRunUpdate {
    const jev = report();
    const finished = stage === "complete" || stage === "failed" || stage === "cancelled";
    return update(stage, {
        reviewModel: "provider/a-very-long-classifier-model-identifier-latest",
        candidateTools: 2,
        protectedTools: 1,
        completedBatches: 3,
        totalBatches: 4,
        ...(stage === "summarizing" || stage === "awaiting-commit" || finished ? { jev } : {}),
        ...(stage === "failed"
            ? { error: "Summary failed:\n  the provider said something quite long indeed " }
            : {}),
    });
}

test("view: each stage maps to its display state", () => {
    const expected = {
        preparing: "preparing",
        chunks: "reviewing",
        summarizing: "summarizing",
        "awaiting-commit": "summarizing",
        complete: "complete",
        failed: "failed",
        cancelled: "cancelled",
    };
    const actual = Object.fromEntries(
        STAGES.map((stage) => [stage, reviewNoticeView(update(stage)).state]),
    );
    assert.deepEqual(actual, expected);
});

test("view: total calls is the candidate and protected counts together", () => {
    const view = reviewNoticeView(update("chunks", { candidateTools: 5, protectedTools: 3 }));
    const expected = { total: 8, reviewed: 5, protected: 3 };
    assert.deepEqual(view.calls, expected);
});

test("view: calls stay unknown until both counts are known", () => {
    assert.equal(reviewNoticeView(update("preparing")).calls, undefined);
    assert.equal(reviewNoticeView(update("chunks", { candidateTools: 2 })).calls, undefined);
});

test("view: each protected tool counts once under its first matching label, most frequent first", () => {
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
    const view = reviewNoticeView(
        update("summarizing", { jev: report({ protectedTools: tools }) }),
    );
    // Ties (media, other) keep label priority order.
    const expected = [
        { label: "nested", count: 3 },
        { label: "error", count: 2 },
        { label: "recent", count: 1 },
        { label: "not permitted", count: 1 },
        { label: "media", count: 1 },
        { label: "other", count: 1 },
    ];
    assert.deepEqual(view.protectedReasons, expected);
});

test("view: character savings split into truncation and classifier shares", () => {
    const view = reviewNoticeView(
        update("complete", {
            jev: report({ charsBefore: 1000, charsAfterTruncation: 800, charsAfter: 500 }),
        }),
    );
    const expected = { before: 1000, after: 500, truncation: 200, classifier: 300 };
    assert.deepEqual(view.outcome?.chars, expected);
});

test("view: drops inside fully removed calls are not counted as fragments", () => {
    const view = reviewNoticeView(update("complete", { jev: report() }));
    const actual = { removedCalls: view.outcome?.removedCalls, fragments: view.outcome?.fragments };
    assert.deepEqual(actual, { removedCalls: 1, fragments: 1 });
});

test("view: batch progress exists only while reviewing", () => {
    for (const stage of STAGES) {
        const view = reviewNoticeView(update(stage, { completedBatches: 1, totalBatches: 3 }));
        const expected = stage === "chunks" ? { completed: 1, total: 3 } : undefined;
        assert.deepEqual(view.batches, expected, stage);
    }
});

test("view: an error message collapses whitespace to single spaces", () => {
    const view = reviewNoticeView(update("failed", { error: "  boom\n\n  and\tmore  " }));
    assert.equal(view.error, "boom and more");
});

test("lines: the row count follows the width", () => {
    const view = reviewNoticeView(richUpdate("complete"));
    const rows = (width: number): number => reviewNoticeLines(view, width, plainTheme()).length;
    assert.equal(rows(FULL_NOTICE_WIDTH), 3);
    assert.equal(rows(120), 3);
    assert.equal(rows(FULL_NOTICE_WIDTH - 1), 2);
    assert.equal(rows(COMPACT_NOTICE_WIDTH), 2);
    assert.equal(rows(COMPACT_NOTICE_WIDTH - 1), 1);
});

test("lines: failed and cancelled notices are always one row", () => {
    for (const stage of ["failed", "cancelled"] as const) {
        const view = reviewNoticeView(richUpdate(stage));
        for (const width of [10, 47, 48, 71, 72, 120])
            assert.equal(
                reviewNoticeLines(view, width, plainTheme()).length,
                1,
                `${stage} ${width}`,
            );
    }
});

test("lines: no state at any width overflows, wraps past three rows or truncates with an ellipsis", () => {
    for (const stage of STAGES) {
        const view = reviewNoticeView(richUpdate(stage));
        for (let width = 1; width <= 120; width++) {
            const lines = reviewNoticeLines(view, width, plainTheme());
            assert.ok(lines.length <= 3, `${stage} ${width}: ${lines.length} rows`);
            for (const line of lines) {
                assert.ok(visibleWidth(line) <= width, `${stage} ${width}: "${line}"`);
                assert.ok(!line.includes("…"), `${stage} ${width}: "${line}"`);
            }
        }
    }
});

test("lines: parts drop whole, so a narrow complete row keeps the removed count and loses the model first", () => {
    const view = reviewNoticeView(richUpdate("complete"));
    const wide = reviewNoticeLines(view, 100, plainTheme()).join("\n");
    assert.ok(wide.includes("a-very-long-classifier-model-identifier-latest"));
    const narrow = reviewNoticeLines(view, COMPACT_NOTICE_WIDTH - 1, plainTheme());
    assert.equal(narrow.length, 1);
    assert.ok(narrow[0]!.includes("−1 call"), narrow[0]);
    assert.ok(!narrow[0]!.includes("classifier-model"), narrow[0]);
});

test("lines: colors are resolved at render time from the theme", () => {
    const render = (stage: CompactionStage): string =>
        reviewNoticeLines(reviewNoticeView(richUpdate(stage)), 100, markerTheme()).join("\n");
    assert.ok(render("failed").includes("<error>✖"));
    assert.ok(render("cancelled").includes("<warning>⚠"));
    assert.ok(render("complete").includes("<accent>◇"));
    assert.ok(render("chunks").includes("<accent>◐"));
});

function context(hasUI: boolean, widgets: { setWidget: (...args: never[]) => void }) {
    return { hasUI, ui: { setWidget: widgets.setWidget } } as unknown as ExtensionContext;
}

test("notice: a context without a UI never touches widgets", () => {
    const widgets = recordWidgets();
    const listener = createReviewNotice();
    listener(update("chunks"), context(false, widgets));
    listener(undefined, context(false, widgets));
    assert.deepEqual(widgets.calls, []);
});

test("notice: the first update pins one widget above the editor", () => {
    const widgets = recordWidgets();
    createReviewNotice()(update("preparing"), context(true, widgets));
    assert.equal(widgets.calls.length, 1);
    assert.equal(widgets.calls[0]!.key, REVIEW_NOTICE_WIDGET);
    assert.equal(typeof widgets.calls[0]!.content, "function");
    assert.deepEqual(widgets.calls[0]!.options, { placement: "aboveEditor" });
});

test("notice: later updates re-render the mounted component instead of pinning again", () => {
    const widgets = recordWidgets();
    const listener = createReviewNotice();
    const ctx = context(true, widgets);
    listener(update("preparing"), ctx);
    const before = widgets.component()!.render(100).join("\n");
    listener(richUpdate("complete"), ctx);
    const after = widgets.component()!.render(100).join("\n");
    assert.equal(widgets.calls.length, 1);
    assert.equal(widgets.tui.renders, 1);
    assert.ok(before.includes("preparing"));
    assert.ok(after.includes("−1 call"));
    assert.ok(!after.includes("preparing"));
});

test("notice: clearing removes the widget only when something was shown", () => {
    const widgets = recordWidgets();
    const listener = createReviewNotice();
    const ctx = context(true, widgets);
    listener(undefined, ctx);
    assert.equal(widgets.calls.length, 0);
    listener(update("preparing"), ctx);
    listener(undefined, ctx);
    assert.equal(widgets.calls.length, 2);
    assert.equal(widgets.calls[1]!.key, REVIEW_NOTICE_WIDGET);
    assert.equal(widgets.calls[1]!.content, undefined);
    listener(undefined, ctx);
    assert.equal(widgets.calls.length, 2);
});

test("notice: after Pi disposes the component the next update mounts a new one", () => {
    const widgets = recordWidgets();
    const listener = createReviewNotice();
    const ctx = context(true, widgets);
    listener(update("preparing"), ctx);
    widgets.component()!.dispose?.();
    listener(update("chunks"), ctx);
    assert.equal(widgets.calls.length, 2);
    assert.equal(typeof widgets.calls[1]!.content, "function");
});

test("notice: a render failure renders nothing, logs, and clears the widget after the render", async (t) => {
    const logged = t.mock.method(console, "error", () => undefined);
    const broken = {
        fg: () => {
            throw new Error("theme exploded");
        },
    } as never;
    const widgets = recordWidgets(broken);
    createReviewNotice()(update("preparing"), context(true, widgets));
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
