import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompactionOptions } from "../../src/options.ts";
import { policy, assistantText, user } from "../harness/fixtures.ts";
import { startLifecycleHost } from "../harness/lifecycle-host.ts";

interface Observed {
    reason: string;
    willRetry: boolean;
}

function config(overrides: Partial<CompactionOptions> = {}): CompactionOptions {
    return {
        summaryModel: { provider: "lune-summary", id: "summary-1" },
        summaryThinkingLevel: "off",
        policy: policy(),
        jev: { enabled: false },
        ...overrides,
    };
}

/** Records the automatic trigger reason Pi reports, without steering the compaction itself. */
function observe(before: Observed[], committed: Observed[]): (pi: ExtensionAPI) => void {
    return (pi) => {
        pi.on("session_before_compact", (event) => {
            before.push({ reason: event.reason, willRetry: event.willRetry });
        });
        pi.on("session_compact", (event) => {
            committed.push({ reason: event.reason, willRetry: event.willRetry });
        });
    };
}

/** Settings that place the threshold well below the main model window so a large prompt crosses it. */
function thresholdSettings() {
    return { compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 100 } };
}

test("host: a high-usage main response drives threshold auto-compaction through session.prompt", async (t) => {
    // Pi's normal token threshold must invoke the configured summary path and commit once.
    const before: Observed[] = [];
    const committed: Observed[] = [];
    const host = await startLifecycleHost({
        configuration: () => config(),
        settings: thresholdSettings(),
        mainModel: { id: "main-1", contextWindow: 16_384, maxTokens: 2_048 },
        history: [user("earlier request"), assistantText("earlier answer")],
        observerFactories: [observe(before, committed)],
    });
    t.after(() => host.dispose());

    host.main.setResponses([fauxAssistantMessage("acknowledged")]);
    host.summary.setResponses([fauxAssistantMessage("## Goal\nthreshold checkpoint")]);

    await host.session.prompt("x".repeat(40_000));

    assert.deepEqual(
        before,
        [{ reason: "threshold", willRetry: false }],
        "the threshold trigger must be reported once",
    );
    assert.deepEqual(committed, [{ reason: "threshold", willRetry: false }]);
    assert.equal(
        host.summary.state.callCount,
        1,
        "the configured summary model generates the checkpoint",
    );
    assert.equal(
        host.main.state.callCount,
        1,
        "threshold compaction must not retry the completed turn",
    );
    assert.equal(host.controller.getRun()?.stage, "complete");
    const compaction = host.sessionManager
        .getEntries()
        .find((entry) => entry.type === "compaction");
    assert.ok(compaction, "a compaction entry must be written");
    assert.ok(
        (compaction.details as { luneCompaction?: unknown }).luneCompaction,
        "the checkpoint must carry Lune details",
    );
});

test("host: abortCompaction cancels a pending automatic summary through Pi's auto signal", async (t) => {
    // Automatic compaction has its own Pi-owned signal, which abortCompaction must reach just like manual compact.
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    let requestStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
    const before: Observed[] = [];
    const committed: Observed[] = [];
    const registerControlled = (pi: ExtensionAPI): void => {
        pi.registerProvider("lune-controlled", {
            apiKey: "test-key",
            api: "faux",
            baseUrl: "http://localhost:0",
            models: [
                {
                    id: "controlled-1",
                    name: "controlled-1",
                    api: "faux",
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    reasoning: false,
                    contextWindow: 200_000,
                    maxTokens: 8_192,
                },
            ],
            streamSimple: (_model, _context, options) => {
                requestSignal = options?.signal;
                requestStream = createAssistantMessageEventStream();
                markRequestStarted();
                return requestStream;
            },
        });
    };
    const host = await startLifecycleHost({
        configuration: () =>
            config({ summaryModel: { provider: "lune-controlled", id: "controlled-1" } }),
        settings: thresholdSettings(),
        mainModel: { id: "main-1", contextWindow: 16_384, maxTokens: 2_048 },
        history: [user("earlier request"), assistantText("earlier answer")],
        observerFactories: [observe(before, committed), registerControlled],
    });
    t.after(() => host.dispose());
    host.main.setResponses([fauxAssistantMessage("acknowledged")]);

    const prompt = host.session.prompt("x".repeat(40_000));
    await requestStarted;
    assert.deepEqual(before, [{ reason: "threshold", willRetry: false }]);
    assert.ok(requestSignal, "the automatic summary request must receive Pi's signal");
    const aborted = new Promise<void>((resolve) =>
        requestSignal!.addEventListener("abort", () => resolve(), { once: true }),
    );

    host.session.abortCompaction();
    await aborted;
    const late = fauxAssistantMessage("late automatic summary");
    const lateProviderResult = requestStream!.result();
    requestStream!.push({ type: "done", reason: "stop", message: late });
    requestStream!.end(late);
    await lateProviderResult;
    await prompt;
    assert.equal(requestSignal.aborted, true);
    assert.equal(host.controller.getRun()?.stage, "cancelled");
    assert.deepEqual(committed, [], "an aborted auto-compaction must not emit a commit event");
    assert.ok(!host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    assert.equal(host.controller.getRun()?.stage, "cancelled");
    assert.equal(host.controller.getRun()?.summary, undefined);
    assert.deepEqual(committed, []);
    assert.ok(!host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
});

test("host: a context-overflow error drives overflow auto-compaction and continues the turn", async (t) => {
    // Pi must recover an overflow by compacting with the selected model and retrying the interrupted turn.
    const before: Observed[] = [];
    const committed: Observed[] = [];
    const host = await startLifecycleHost({
        configuration: () => config(),
        settings: thresholdSettings(),
        mainModel: { id: "main-1", contextWindow: 16_384, maxTokens: 2_048 },
        observerFactories: [observe(before, committed)],
    });
    t.after(() => host.dispose());

    host.main.setResponses([
        fauxAssistantMessage([], {
            stopReason: "error",
            errorMessage: "prompt is too long: 200000 tokens > 100000 maximum",
        }),
        fauxAssistantMessage("recovered after overflow"),
    ]);
    host.summary.setResponses([fauxAssistantMessage("## Goal\noverflow checkpoint")]);

    await host.session.prompt("hello");

    assert.deepEqual(
        before,
        [{ reason: "overflow", willRetry: true }],
        "an overflow retry must be reported with willRetry",
    );
    assert.deepEqual(committed, [{ reason: "overflow", willRetry: true }]);
    assert.equal(host.summary.state.callCount, 1);
    assert.equal(
        host.main.state.callCount,
        2,
        "the interrupted turn must be retried once after overflowing",
    );
    assert.equal(host.controller.getRun()?.stage, "complete");
    assert.ok(host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    assert.equal(host.session.getLastAssistantText(), "recovered after overflow");
});
