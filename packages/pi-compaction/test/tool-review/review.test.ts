import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import {
    reviewToolHistory,
    summarizeReview,
    type ChunkDecision,
    type ToolReviewReport,
} from "../../src/tool-review/review.ts";
import type { ResultChunk } from "../../src/tool-review/candidates.ts";
import type { CompactionPolicy } from "../../src/options.ts";
import { assistantText, assistantToolCall, policy, toolResult, user } from "../harness/fixtures.ts";

function setup(
    history: AgentMessage[],
    options: {
        prefix?: AgentMessage[];
        contextWindow?: number;
        policy?: CompactionPolicy;
        classify?: (request: ClassifierContext) => Partial<ClassifierResult>;
    } = {},
) {
    const retained = [user("current request"), assistantText("retained progress")];
    const prefix = options.prefix ?? [];
    const all = [...history, ...prefix, ...retained];
    const entries = all.map((message, index) => ({
        sourceEntry: { id: `e${index}`, type: "message" },
        messages: [message],
    }));
    const event = {
        preparation: {
            messagesToSummarize: history,
            turnPrefixMessages: prefix,
            previousSummary: "EXCLUDED_SUMMARY",
            firstKeptEntryId: `e${history.length + prefix.length}`,
        },
        customInstructions: "EXCLUDED_FOCUS",
        reason: "manual",
    } as unknown as SessionBeforeCompactEvent;
    const classifier = {
        id: "any-classifier",
        provider: "provider",
        contextWindow: options.contextWindow ?? 64_000,
    } as ClassifierModel<string>;
    const captured: ClassifierContext[] = [];
    const registryCalls: { model: unknown; options: unknown }[] = [];
    const ctx = {
        sessionManager: { buildSessionProjection: () => ({ entries, messages: all }) },
        modelRegistry: {
            classify: async (
                model: ClassifierModel<string>,
                request: ClassifierContext,
                requestOptions: unknown,
            ) => {
                registryCalls.push({ model, options: requestOptions });
                captured.push(structuredClone(request));
                return {
                    api: "generic-classifier",
                    provider: "provider",
                    model: "any-classifier",
                    timestamp: 0,
                    stopReason: "stop",
                    answers: { safeToDrop: { type: "bool", probability: 1 } },
                    ...options.classify?.(request),
                } as ClassifierResult;
            },
        },
    } as unknown as ExtensionContext;
    const run = () =>
        reviewToolHistory(
            event,
            ctx,
            options.policy ?? policy({ deletableTools: ["read"] }),
            classifier,
            new AbortController().signal,
            () => undefined,
        );
    return { run, captured, classifier, registryCalls };
}

function history() {
    return [
        user("inspect source"),
        assistantToolCall("r1", "read", { path: "one.ts" }),
        toolResult("r1", "read", "FIRST_BODY"),
        assistantText("understood"),
        assistantToolCall("r2", "read", { path: "two.ts" }),
        toolResult("r2", "read", "SECOND_BODY"),
    ];
}

test("review sends each fragment to the selected classifier through Pi without retries", async () => {
    // Pi's registry owns classifier authentication; the review must not retry a failed request itself.
    const harness = setup(history());
    const actual = await harness.run();
    assert.equal(harness.registryCalls.length, 2);
    for (const call of harness.registryCalls) {
        assert.equal(call.model, harness.classifier);
        const options = call.options as { signal?: unknown; maxRetries?: unknown };
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.maxRetries, 0);
    }
    assert.equal(actual.report.model, "provider/any-classifier");
});

test("review sends one minimal candidate and one safeToDrop question per request", async () => {
    const messages = history();
    const original = structuredClone(messages);
    const harness = setup(messages);
    const actual = await harness.run();
    assert.equal(harness.captured.length, 2);
    for (const request of harness.captured) {
        assert.deepEqual(Object.keys(request.questions), ["safeToDrop"]);
        assert.deepEqual(
            Object.keys(request.state).sort(),
            ["currentRequest", "originatingRequest", "result", "sameTurnOutcome", "toolCall"]
                .filter(
                    (key) =>
                        key !== "sameTurnOutcome" || request.state.sameTurnOutcome !== undefined,
                )
                .sort(),
        );
        assert.equal(request.state.originatingRequest, "inspect source");
        assert.equal(request.state.currentRequest, "current request");
    }
    assert.equal(harness.captured[0]!.state.result, "FIRST_BODY");
    assert.equal(harness.captured[0]!.state.sameTurnOutcome, "understood");
    assert.equal(harness.captured[1]!.state.result, "SECOND_BODY");
    assert.deepEqual(actual.report.removedCalls, ["r1", "r2"]);
    assert.equal(actual.report.requests, 2);
    assert.equal(actual.report.oversizedRequests, 0);
    assert.deepEqual(messages, original);
});

test("review deletes a pair only when all its chunks meet the safeToDrop threshold", async () => {
    // A retained chunk keeps the invocation; approved chunks can still be omitted from its result.
    const messages = [
        user("inspect"),
        assistantToolCall("r", "read", {}),
        toolResult("r", "read", "A".repeat(4_000) + "B".repeat(4_000)),
    ];
    const harness = setup(messages, {
        classify: (request) => ({
            answers: {
                safeToDrop: {
                    type: "bool",
                    probability: String(request.state.result).startsWith("A") ? 0.95 : 0.5,
                },
            },
        }),
    });
    const actual = await harness.run();
    assert.deepEqual(
        actual.report.chunkDecisions.map(({ action }) => action),
        ["drop", "keep"],
    );
    assert.deepEqual(actual.report.removedCalls, []);
    const serialized = JSON.stringify(actual.messagesToSummarize);
    assert.ok(serialized.includes("omitted UTF-16 range 0-4000"));
    assert.ok(serialized.includes("B".repeat(4_000)));
    assert.ok(serialized.includes('"toolCall"'));
});

test("review protects non-permitted, nested, error and media outputs without classifier requests", async () => {
    const messages = [
        assistantToolCall("w", "write", {}),
        toolResult("w", "write", "WRITE_BODY"),
        assistantToolCall("n", "read", {}),
        { ...toolResult("n", "read", "NESTED_BODY"), nestedCalls: { calls: [], complete: false } },
        assistantToolCall("e", "read", {}),
        toolResult("e", "read", "ERROR_BODY", { isError: true }),
        assistantToolCall("i", "read", {}),
        toolResult("i", "read", "MEDIA_BODY", {
            nonText: [{ type: "image", data: "AA", mimeType: "image/png" }],
        }),
    ] as AgentMessage[];
    const harness = setup(messages);
    const actual = await harness.run();
    assert.equal(harness.captured.length, 0);
    assert.deepEqual(actual.messagesToSummarize, messages);
    assert.equal(actual.report.protectedTools.length, 4);
});

test("review preflight overflow uses a placeholder and preserves arguments while other candidates proceed", async () => {
    const messages = history();
    messages[1] = assistantToolCall("r1", "read", {
        path: "one.ts",
        content: "ARGUMENT_ANCHOR" + "x".repeat(40_000),
    });
    const harness = setup(messages, { contextWindow: 4_000 });
    const actual = await harness.run();
    assert.equal(harness.captured.length, 1);
    assert.deepEqual(actual.report.removedCalls, ["r2"]);
    assert.deepEqual(
        actual.report.chunkDecisions.map(({ action }) => action),
        ["placeholder", "drop"],
    );
    assert.equal(actual.report.budgetFallbacks.length, 1);
    assert.equal(actual.report.oversizedRequests, 0);
    const serialized = JSON.stringify(actual.messagesToSummarize);
    assert.ok(serialized.includes("ARGUMENT_ANCHOR"));
    assert.ok(serialized.includes("content not classified"));
    assert.ok(!serialized.includes("FIRST_BODY"));
});

test("provider length rejection keeps the exact failed chunk and continues without retry", async () => {
    const messages = history();
    const harness = setup(messages, {
        classify: (request) =>
            request.state.result === "FIRST_BODY"
                ? {
                      stopReason: "error",
                      answers: {},
                      errorMessage: 'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}',
                  }
                : {},
    });
    const actual = await harness.run();
    assert.equal(harness.captured.length, 2);
    assert.equal(actual.report.oversizedRequests, 1);
    assert.deepEqual(actual.report.removedCalls, ["r2"]);
    assert.deepEqual(
        actual.report.chunkDecisions.map(({ action }) => action),
        ["keep", "drop"],
    );
    const retained = actual.messagesToSummarize.find((message) => message.role === "toolResult");
    assert.deepEqual(retained, messages[2]);
    assert.equal("probability" in actual.report.chunkDecisions[0]!, false);
    assert.deepEqual(actual.report.budgetFallbacks, []);
});

test("empty outputs are kept and malformed answers or unrelated failures remain fatal", async () => {
    const empty = setup([assistantToolCall("r", "read", {}), toolResult("r", "read", "")]);
    const actual = await empty.run();
    assert.equal(empty.captured.length, 0);
    assert.deepEqual(actual.report.removedCalls, []);
    for (const classify of [
        () => ({ answers: { safeToDrop: { type: "bool" as const, probability: 2 } } }),
        () => ({ stopReason: "error" as const, errorMessage: "Unauthorized", answers: {} }),
    ])
        await assert.rejects(
            setup(history(), { classify }).run(),
            /invalid probability|Unauthorized/,
        );
});

test("prefix candidates are rewritten within their own native region", async () => {
    const messages = history();
    const harness = setup([], { prefix: messages });
    const actual = await harness.run();
    assert.deepEqual(actual.messagesToSummarize, []);
    assert.deepEqual(actual.report.removedCalls, ["r1", "r2"]);
    assert.ok(!JSON.stringify(actual.turnPrefixMessages).includes("BODY"));
});

test("a 64k catalog window keeps an overflowing Japanese fragment without preserving approved siblings", async () => {
    const kept = "証拠".repeat(2_000);
    const dropped = "失効".repeat(2_000);
    const messages = [
        user("解析".repeat(10_000)),
        assistantToolCall("r", "read", { path: "報告.md" }),
        toolResult("r", "read", kept + dropped),
        assistantText("完了".repeat(10_000)),
    ];
    const harness = setup(messages, {
        contextWindow: 64_000,
        classify: (request) =>
            request.state.result === kept
                ? { stopReason: "error", answers: {}, errorMessage: "max_tokens_exceeded" }
                : {},
    });
    const actual = await harness.run();
    assert.equal(harness.captured.length, 2);
    assert.equal(harness.captured[0]!.state.originatingRequest, "解析".repeat(1_000));
    assert.equal(harness.captured[0]!.state.sameTurnOutcome, "完了".repeat(1_000));
    assert.deepEqual(
        actual.report.chunkDecisions.map(({ action }) => action),
        ["keep", "drop"],
    );
    assert.equal(actual.report.oversizedRequests, 1);
    assert.equal(actual.report.budgetFallbacks.length, 0);
    assert.deepEqual(actual.report.removedCalls, []);
    assert.ok(actual.messagesToSummarize.includes(messages[1]!));
    const result = actual.messagesToSummarize.find((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.deepEqual(result.content, [
        {
            type: "text",
            text: kept + "\n[pi-compaction omitted UTF-16 range 4000-8000 (4000 code units)]\n",
        },
    ]);
});

test("drop confidence is compared directly, including equality and the inclusive endpoints", async () => {
    for (const scenario of [
        {
            threshold: 0.7,
            probabilities: [0.699, 0.7, 0.701],
            actions: ["keep", "drop", "drop"],
            removed: ["r1", "r2"],
        },
        { threshold: 0, probabilities: [0], actions: ["drop"], removed: ["r0"] },
        { threshold: 1, probabilities: [0.999, 1], actions: ["keep", "drop"], removed: ["r1"] },
    ]) {
        const messages = [
            user("inspect"),
            ...scenario.probabilities.flatMap((value, index) => [
                assistantToolCall("r" + index, "read", {}),
                toolResult("r" + index, "read", String(value)),
            ]),
        ];
        const harness = setup(messages, {
            policy: policy({ deleteThreshold: scenario.threshold }),
            classify: (request) => ({
                answers: {
                    safeToDrop: { type: "bool", probability: Number(request.state.result) },
                },
            }),
        });
        const actual = await harness.run();
        assert.deepEqual(
            actual.report.chunkDecisions.map(({ action }) => action),
            scenario.actions,
        );
        assert.deepEqual(actual.report.removedCalls, scenario.removed);
    }
});

function summaryFixture(
    calls: Record<string, Array<"keep" | "drop" | "placeholder" | "unreviewed">>,
    options: { candidateTools?: number; removedCalls?: string[] } = {},
): ToolReviewReport {
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
                text: `text-${chunkId}`,
            });
            if (action === "placeholder") {
                chunkDecisions.push({
                    chunkId,
                    action: "placeholder",
                    reason: "classifier-context-window",
                });
            } else if (action === "unreviewed") {
                chunkDecisions.push({
                    chunkId,
                    action: "keep",
                    reason: "classifier-context-window",
                });
            } else {
                chunkDecisions.push({
                    chunkId,
                    probability: action === "drop" ? 1 : 0,
                    action,
                });
            }
        });
    }
    return {
        model: "provider/any-classifier",
        pricingKnown: true,
        protectedTools: [],
        candidateTools: options.candidateTools ?? Object.keys(calls).length,
        chunks,
        chunkDecisions,
        removedCalls: options.removedCalls ?? [],
        oversizedRequests: 0,
        requests: chunks.length,
        requestBudget: 1000,
        budgetFallbacks: [],
        usage: [],
        charsBefore: 1000,
        charsAfter: 500,
    };
}

test("summarizeReview scopes dropped fragments to surviving calls", () => {
    // Drops inside a fully removed call belong to the call entry, not the fragment entry.
    const summary = summarizeReview(
        summaryFixture({ r1: ["drop"], r2: ["drop", "drop"] }, { removedCalls: ["r2"] }),
    );
    const expected = { checked: 2, removedCalls: 1, droppedFragments: 1 };
    const actual = {
        checked: summary.checked,
        removedCalls: summary.removedCalls,
        droppedFragments: summary.droppedFragments,
    };
    assert.deepEqual(actual, expected);
});

test("summarizeReview separates placeholders and unreviewed keeps from drops", () => {
    const summary = summarizeReview(
        summaryFixture({ r1: ["keep", "drop", "placeholder", "unreviewed"] }),
    );
    const expected = { droppedFragments: 1, placeholders: 1, unreviewed: 1, removedCalls: 0 };
    const actual = {
        droppedFragments: summary.droppedFragments,
        placeholders: summary.placeholders,
        unreviewed: summary.unreviewed,
        removedCalls: summary.removedCalls,
    };
    assert.deepEqual(actual, expected);
});
