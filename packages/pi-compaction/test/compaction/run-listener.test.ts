import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type ClassifierContext,
    type ClassifierModel,
    type ClassifierResult,
    type Model,
} from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { CompactionController, type CompactionRunUpdate } from "../../src/compaction-controller.ts";
import type { CompactionOptions } from "../../src/options.ts";
import {
    assistantText,
    assistantToolCall,
    policy,
    toolResult,
    user,
    ZERO_USAGE,
} from "../harness/fixtures.ts";

const CLASSIFIER = {
    id: "any-classifier",
    provider: "provider",
    contextWindow: 64_000,
} as ClassifierModel<string>;

const SUMMARY_MODEL = {
    id: "summary-A",
    name: "summary-A",
    api: "faux",
    provider: "lune-summary",
    baseUrl: "http://localhost:0",
    input: ["text"],
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<string>;

function summaryStream() {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "## Goal\nlistener summary" }],
        api: "faux",
        provider: "lune-summary",
        model: "summary-A",
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
}

function config(jevEnabled = true): CompactionOptions {
    return {
        summaryModel: { provider: "lune-summary", id: "summary-A" },
        summaryThinkingLevel: "off",
        policy: policy({ deletableTools: ["read"] }),
        jev: jevEnabled
            ? { enabled: true, model: { provider: "provider", id: "any-classifier" } }
            : { enabled: false },
    };
}

/** Two reviewable reads (two classifier requests) and one protected write, all in the summarized history. */
function reviewEvent(signal: AbortSignal): SessionBeforeCompactEvent {
    return {
        type: "session_before_compact",
        preparation: {
            firstKeptEntryId: "e7",
            messagesToSummarize: HISTORY,
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 100,
            fileOps: {
                read: new Set<string>(),
                edited: new Set<string>(),
                written: new Set<string>(),
            },
            settings: { enabled: true, reserveTokens: 4_096, keepRecentTokens: 100 },
        },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal,
    } as never;
}

const HISTORY: AgentMessage[] = [
    user("inspect"),
    assistantToolCall("r1", "read", {}),
    toolResult("r1", "read", "FIRST_BODY"),
    assistantToolCall("r2", "read", {}),
    toolResult("r2", "read", "SECOND_BODY"),
    assistantToolCall("w", "write", {}),
    toolResult("w", "write", "WRITE_BODY"),
];

interface Harness {
    controller: CompactionController;
    ctx: ExtensionContext;
    updates: (CompactionRunUpdate | undefined)[];
    notifications: { text: string; type?: string }[];
    session: { leafId: string };
    emit: (event: string, ...args: unknown[]) => Promise<void>;
}

function createHarness(options: {
    configuration?: () => CompactionOptions | null;
    classify?: (request: ClassifierContext, signal: AbortSignal) => Promise<ClassifierResult>;
    listener?: (update: CompactionRunUpdate | undefined) => void;
}): Harness {
    const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
    const pi = {
        on: (event: string, handler: (...args: never[]) => unknown) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
            return () => undefined;
        },
        getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const session = { leafId: "leaf-1" };
    const notifications: { text: string; type?: string }[] = [];
    const entries = [...HISTORY, user("current request"), assistantText("retained")].map(
        (message, index) => ({
            sourceEntry: { id: `e${index}`, type: "message" },
            messages: [message],
        }),
    );
    const ctx = {
        hasUI: true,
        ui: { notify: (text: string, type?: string) => notifications.push({ text, type }) },
        sessionManager: {
            getSessionId: () => "session-1",
            getLeafId: () => session.leafId,
            buildSessionProjection: () => ({
                entries,
                messages: entries.flatMap((entry) => entry.messages),
            }),
        },
        modelRegistry: {
            find: () => SUMMARY_MODEL,
            getAvailableOfType: async () => [CLASSIFIER],
            classify:
                options.classify ??
                (async () => ({
                    api: "generic-classifier",
                    provider: "provider",
                    model: "any-classifier",
                    timestamp: 0,
                    stopReason: "stop",
                    answers: { safeToDrop: { type: "bool", probability: 1 } },
                })),
            streamSimple: () => summaryStream(),
        },
    } as unknown as ExtensionContext;
    const updates: (CompactionRunUpdate | undefined)[] = [];
    const controller = new CompactionController(pi, options.configuration ?? (() => config()), {
        onRunChange: (update) => {
            updates.push(update);
            options.listener?.(update);
        },
    });
    return {
        controller,
        ctx,
        updates,
        notifications,
        session,
        emit: async (event, ...args) => {
            for (const handler of handlers.get(event) ?? [])
                await (handler as (...values: unknown[]) => unknown)(...args);
        },
    };
}

function summarize(updates: (CompactionRunUpdate | undefined)[]) {
    return updates.map((update) =>
        update
            ? {
                  stage: update.stage,
                  model: update.reviewModel,
                  candidates: update.candidateTools,
                  protectedTools: update.protectedTools,
                  batches: `${update.completedBatches}/${update.totalBatches}`,
                  hasReport: update.jev !== undefined,
                  error: update.error,
              }
            : undefined,
    );
}

async function commit(
    harness: Harness,
    result: Awaited<ReturnType<Harness["controller"]["beforeCompact"]>>,
) {
    await harness.emit(
        "session_compact",
        {
            compactionEntry: {
                summary: result.compaction!.summary,
                details: result.compaction!.details,
            },
        },
        harness.ctx,
    );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const MODEL = "provider/any-classifier";

test("run listener: a reviewed run reports preparing, the resolved model, each batch, summarizing and complete", async () => {
    const harness = createHarness({});
    const result = await harness.controller.beforeCompact(
        reviewEvent(new AbortController().signal),
        harness.ctx,
    );
    assert.ok(result.compaction);
    // Awaiting Pi's commit is not a visible change.
    assert.equal(harness.updates.length, 6);
    await commit(harness, result);
    const expected = [
        {
            stage: "preparing",
            model: undefined,
            candidates: undefined,
            protectedTools: undefined,
            batches: "0/0",
            hasReport: false,
            error: undefined,
        },
        {
            stage: "preparing",
            model: MODEL,
            candidates: undefined,
            protectedTools: undefined,
            batches: "0/0",
            hasReport: false,
            error: undefined,
        },
        {
            stage: "chunks",
            model: MODEL,
            candidates: 2,
            protectedTools: 1,
            batches: "0/2",
            hasReport: false,
            error: undefined,
        },
        {
            stage: "chunks",
            model: MODEL,
            candidates: 2,
            protectedTools: 1,
            batches: "1/2",
            hasReport: false,
            error: undefined,
        },
        {
            stage: "chunks",
            model: MODEL,
            candidates: 2,
            protectedTools: 1,
            batches: "2/2",
            hasReport: false,
            error: undefined,
        },
        {
            stage: "summarizing",
            model: MODEL,
            candidates: 2,
            protectedTools: 1,
            batches: "2/2",
            hasReport: true,
            error: undefined,
        },
        {
            stage: "complete",
            model: MODEL,
            candidates: 2,
            protectedTools: 1,
            batches: "2/2",
            hasReport: true,
            error: undefined,
        },
    ];
    assert.deepEqual(summarize(harness.updates), expected);
    assert.deepEqual(harness.updates.at(-1)!.jev!.removedCalls, ["r1", "r2"]);
    assert.deepEqual(
        harness.notifications.filter(({ type }) => type === "info"),
        [],
    );
});

test("run listener: a replaced checkpoint ends the run as failed with the reason", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const harness = createHarness({});
    const result = await harness.controller.beforeCompact(
        reviewEvent(new AbortController().signal),
        harness.ctx,
    );
    await harness.emit(
        "session_compact",
        { compactionEntry: { summary: "another handler's summary", details: {} } },
        harness.ctx,
    );
    assert.ok(result.compaction);
    const last = harness.updates.at(-1)!;
    assert.equal(last.stage, "failed");
    assert.match(last.error!, /replaced the generated checkpoint/);
});

test("run listener: a failed commit reports failed with Pi's message and an aborted commit reports cancelled", async (t) => {
    t.mock.method(console, "error", () => undefined);
    for (const scenario of [
        {
            event: { aborted: false, errorMessage: "disk full" },
            stage: "failed",
            error: "disk full",
        },
        { event: { aborted: true }, stage: "cancelled", error: undefined },
    ]) {
        const harness = createHarness({});
        await harness.controller.beforeCompact(
            reviewEvent(new AbortController().signal),
            harness.ctx,
        );
        await harness.emit("session_compact_failed", scenario.event, harness.ctx);
        const last = harness.updates.at(-1)!;
        assert.deepEqual(
            { stage: last.stage, error: last.error },
            { stage: scenario.stage, error: scenario.error },
        );
    }
});

test("run listener: a classifier failure ends the run as failed with the error message", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const harness = createHarness({
        classify: async () => {
            throw new Error("classifier exploded");
        },
    });
    const result = await harness.controller.beforeCompact(
        reviewEvent(new AbortController().signal),
        harness.ctx,
    );
    assert.equal(result.cancel, true);
    const last = harness.updates.at(-1)!;
    assert.equal(last.stage, "failed");
    assert.match(last.error!, /classifier exploded/);
    assert.deepEqual(
        harness.notifications.map(({ type }) => type),
        ["error"],
    );
});

test("run listener: a user abort during the review ends the run as cancelled without an error", async () => {
    const abort = new AbortController();
    const entered = deferred();
    const harness = createHarness({
        classify: (_request, signal) =>
            new Promise((_resolve, reject) => {
                entered.resolve();
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
    });
    const pending = harness.controller.beforeCompact(reviewEvent(abort.signal), harness.ctx);
    await entered.promise;
    abort.abort();
    const result = await pending;
    assert.equal(result.cancel, true);
    const last = harness.updates.at(-1)!;
    assert.equal(last.stage, "cancelled");
    assert.equal(last.error, undefined);
});

test("run listener: a session retired mid-run clears the notice and is not followed by a cancelled update", async () => {
    const entered = deferred();
    const harness = createHarness({
        classify: (_request, signal) =>
            new Promise((_resolve, reject) => {
                entered.resolve();
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
    });
    const pending = harness.controller.beforeCompact(
        reviewEvent(new AbortController().signal),
        harness.ctx,
    );
    await entered.promise;
    const before = harness.updates.length;
    await harness.emit("session_before_switch", {}, harness.ctx);
    await pending;
    const after = harness.updates.slice(before);
    assert.deepEqual(after, [undefined]);
});

test("run listener: a disabled review or a null configuration clears the notice", async () => {
    for (const configuration of [() => config(false), () => null]) {
        const harness = createHarness({ configuration });
        await harness.controller.beforeCompact(
            reviewEvent(new AbortController().signal),
            harness.ctx,
        );
        assert.deepEqual(harness.updates, [undefined]);
    }
});

test("run listener: every session lifecycle event clears the notice", async () => {
    for (const event of [
        "session_start",
        "session_shutdown",
        "session_before_switch",
        "session_before_fork",
        "session_before_tree",
    ]) {
        const harness = createHarness({});
        await harness.emit(event, {}, harness.ctx);
        assert.deepEqual(harness.updates, [undefined], event);
    }
});

test("run listener: a throwing listener is logged and does not fail the compaction", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const harness = createHarness({
        listener: () => {
            throw new Error("listener bug");
        },
    });
    const result = await harness.controller.beforeCompact(
        reviewEvent(new AbortController().signal),
        harness.ctx,
    );
    assert.ok(result.compaction);
    await commit(harness, result);
    assert.ok(warn.mock.callCount() > 0);
    assert.equal(harness.controller.getRun()?.stage, "complete");
});
