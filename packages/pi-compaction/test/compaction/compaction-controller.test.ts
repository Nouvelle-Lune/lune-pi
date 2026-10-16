import test from "node:test";
import assert from "node:assert/strict";
import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Model,
} from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { CompactionOptions } from "../../src/options.ts";
import { policy, user, ZERO_USAGE } from "../harness/fixtures.ts";
import { createControllerHarness, hangingStream } from "../harness/lifecycle-host.ts";

function summaryModel(id: string, reasoning = false): Model<string> {
    return {
        id,
        name: id,
        api: "faux",
        provider: "lune-summary",
        baseUrl: "http://localhost:0",
        input: ["text"],
        reasoning,
        contextWindow: 200_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as Model<string>;
}

function summaryResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "faux",
        provider: "lune-summary",
        model: "summary-A",
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

function resolvedStream(message: AssistantMessage): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
}

function config(overrides: Partial<CompactionOptions> = {}): CompactionOptions {
    return {
        summaryModel: { provider: "lune-summary", id: "summary-A" },
        summaryThinkingLevel: "off",
        policy: policy(),
        jev: { enabled: false },
        ...overrides,
    };
}

function splitEvent(signal: AbortSignal): SessionBeforeCompactEvent {
    return {
        type: "session_before_compact",
        preparation: {
            firstKeptEntryId: "keep-1",
            messagesToSummarize: [user("prior history")],
            turnPrefixMessages: [user("current turn prefix")],
            isSplitTurn: true,
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

/** Resolve once the provider request has entered `streamSimple`, so no timing sleep is needed. */
function enteredGate(): { promise: Promise<void>; enter: () => void } {
    let enter!: () => void;
    const promise = new Promise<void>((resolve) => {
        enter = resolve;
    });
    return { promise, enter };
}

test("controller: a pending summary has no plugin timeout and a late result cannot commit after caller cancellation", async (t) => {
    // Pi owns cancellation, so elapsed time alone must leave an in-flight provider request pending.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gate = enteredGate();
    const { stream, resolve } = hangingStream();
    const providerResult = stream.result();
    let requestSignal: AbortSignal | undefined;
    const harness = createControllerHarness({
        configuration: () => config(),
        registry: {
            models: [summaryModel("summary-A")],
            streamSimple: (_model, _context, options) => {
                requestSignal = options?.signal;
                gate.enter();
                return stream;
            },
        },
    });
    const abort = new AbortController();
    const promise = harness.controller.beforeCompact(splitEvent(abort.signal), harness.ctx);
    await gate.promise;
    assert.ok(requestSignal, "the summary request must receive Pi's combined cancellation signal");

    t.mock.timers.tick(120_001);
    assert.equal(
        requestSignal.aborted,
        false,
        "elapsed time must not create a plugin-owned deadline",
    );
    assert.equal(harness.controller.getRun()?.stage, "summarizing");

    const requestAborted = new Promise<void>((resolve) =>
        requestSignal!.addEventListener("abort", () => resolve(), { once: true }),
    );
    abort.abort();
    await requestAborted;
    resolve(summaryResponse("late summary"));
    await providerResult;
    const result = await promise;
    assert.equal(result.cancel, true);
    assert.equal(harness.controller.getRun()?.stage, "cancelled");
    assert.equal(harness.controller.getRun()?.error, undefined);
    assert.equal(
        harness.controller.getRun()?.summary,
        undefined,
        "a late response must not become a checkpoint",
    );
});

test("controller: a generation change cancels a pending operation and a late result is not committed", async () => {
    // A provider response from the previous generation must never revive a retired checkpoint.
    const gate = enteredGate();
    const { stream, resolve } = hangingStream();
    const harness = createControllerHarness({
        configuration: () => config(),
        registry: {
            models: [summaryModel("summary-A")],
            streamSimple: () => {
                gate.enter();
                return stream;
            },
        },
    });
    const promise = harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );
    await gate.promise;
    await harness.emit("session_before_switch");
    // A late provider result must not flip a retired operation back to a committed checkpoint.
    resolve(summaryResponse("late checkpoint"));
    const result = await promise;
    assert.equal(result.cancel, true);
    const run = harness.controller.getRun();
    assert.equal(run?.stage, "cancelled");
    assert.equal(run?.summary, undefined);
});

test("controller: session_shutdown cancels a pending operation", async () => {
    // A provider that settles after Pi shuts down must not revive the cancelled run.
    const gate = enteredGate();
    const pending = hangingStream();
    const harness = createControllerHarness({
        configuration: () => config(),
        registry: {
            models: [summaryModel("summary-A")],
            streamSimple: () => {
                gate.enter();
                return pending.stream;
            },
        },
    });
    const promise = harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );
    await gate.promise;
    await harness.emit("session_shutdown");
    pending.resolve(summaryResponse("late shutdown response"));
    const result = await promise;
    assert.equal(result.cancel, true);
    assert.equal(harness.controller.getRun()?.stage, "cancelled");
});

test("controller: a leaf change discards a late result instead of committing it", async () => {
    // A checkpoint is valid only for the exact branch leaf captured when compaction began.
    const gate = enteredGate();
    const { stream, resolve } = hangingStream();
    const harness = createControllerHarness({
        configuration: () => config(),
        registry: {
            models: [summaryModel("summary-A")],
            streamSimple: () => {
                gate.enter();
                return stream;
            },
        },
    });
    const promise = harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );
    await gate.promise;
    harness.session.leafId = "leaf-2";
    resolve(summaryResponse("checkpoint for another leaf"));
    const result = await promise;
    assert.equal(result.cancel, true);
    const run = harness.controller.getRun();
    assert.equal(run?.stage, "cancelled");
    assert.equal(run?.summary, undefined);
});

test("controller: configuration is frozen once per operation, including across a split-turn's two requests", async () => {
    // Pi clamps saved max to high for this model, while settings edits apply only to the next compact.
    const requests: { model: string; reasoning: unknown }[] = [];
    let reads = 0;
    let live = config({
        summaryModel: { provider: "lune-summary", id: "summary-A" },
        summaryThinkingLevel: "max",
        policy: policy({ deleteThreshold: 0.05 }),
    });
    const harness = createControllerHarness({
        configuration: () => {
            reads++;
            return live;
        },
        registry: {
            models: [summaryModel("summary-A", true), summaryModel("summary-B", true)],
            streamSimple: (model, _context, options) => {
                requests.push({ model: model.id, reasoning: options?.reasoning });
                // Reconfigure the source after the first request has entered, as a host would on reload.
                if (requests.length === 1)
                    live = config({
                        summaryModel: { provider: "lune-summary", id: "summary-B" },
                        summaryThinkingLevel: "medium",
                        policy: policy({ deleteThreshold: 0.1 }),
                    });
                return resolvedStream(summaryResponse("checkpoint"));
            },
        },
    });

    const first = await harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );
    assert.ok(first.compaction, "the split-turn operation must produce a checkpoint");
    assert.equal(requests.length, 2, "a split turn issues a history and a turn-prefix request");
    assert.deepEqual(
        requests.map((request) => request.model),
        ["summary-A", "summary-A"],
        "the frozen model must serve both requests",
    );
    assert.deepEqual(
        requests.map((request) => request.reasoning),
        ["high", "high"],
        "the frozen thinking level must serve both requests",
    );
    assert.equal(reads, 1, "the configuration getter is read once per operation");
    const details = (
        first.compaction!.details as {
            luneCompaction: {
                summaryModel: { id: string };
                summaryThinkingLevel: string;
                policyVersion: string;
            };
        }
    ).luneCompaction;
    assert.equal(details.summaryModel.id, "summary-A");
    assert.equal(details.summaryThinkingLevel, "high");
    assert.equal(details.policyVersion, "lune-jev-v5");

    // Confirm Pi's commit so a second operation can start, then observe the new configuration is read.
    await harness.emit(
        "session_compact",
        {
            compactionEntry: {
                summary: first.compaction!.summary,
                details: first.compaction!.details,
            },
        },
        harness.ctx,
    );
    assert.equal(harness.controller.getRun()?.stage, "complete");

    requests.length = 0;
    const second = await harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );
    assert.ok(second.compaction);
    assert.deepEqual(
        requests.map((request) => request.model),
        ["summary-B", "summary-B"],
        "the next operation reads the new configuration",
    );
    assert.deepEqual(
        requests.map((request) => request.reasoning),
        ["medium", "medium"],
    );
    assert.equal(reads, 2);
    assert.equal(
        (second.compaction!.details as { luneCompaction: { policyVersion: string } }).luneCompaction
            .policyVersion,
        "lune-jev-v5",
    );
});
