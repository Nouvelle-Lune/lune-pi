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
import { createControllerHarness } from "../harness/lifecycle-host.ts";

function summaryModel(id: string): Model<string> {
    return {
        id,
        name: id,
        api: "faux",
        provider: "lune-summary",
        baseUrl: "http://localhost:0",
        input: ["text"],
        reasoning: false,
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

test("settings: an explicit null configuration disables Lune without a run or any request", async () => {
    // An explicit null is user-intent to stop intercepting, so returning {} (not a cancel) leaves
    // Pi's native compaction untouched and Lune must not fabricate a run or contact a provider.
    const requests: string[] = [];
    const harness = createControllerHarness({
        configuration: () => null,
        registry: {
            models: [summaryModel("summary-A")],
            streamSimple: (model) => {
                requests.push(model.id);
                return resolvedStream(summaryResponse("must not run"));
            },
        },
    });

    const result = await harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );

    assert.deepEqual(result, {}, "a configure-disabled operation yields to Pi native compaction");
    assert.equal(
        harness.controller.getRun(),
        undefined,
        "disabling must not leave a run record behind",
    );
    assert.deepEqual(requests, [], "no summary (or Jev) work may be started while disabled");
});

test("settings: switching to null after a committed checkpoint retains that run and starts no new work", async () => {
    // Disable mode must preserve the last committed checkpoint so a settings change does not erase useful run state.
    const requests: string[] = [];
    let live: CompactionOptions | null = config();
    const harness = createControllerHarness({
        configuration: () => live,
        registry: {
            models: [summaryModel("summary-A")],
            streamSimple: (model) => {
                requests.push(model.id);
                return resolvedStream(summaryResponse("first checkpoint"));
            },
        },
    });

    const first = await harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );
    assert.ok(first.compaction, "an enabled configuration must produce a checkpoint");
    await harness.emit(
        "session_compact",
        {
            compactionEntry: {
                summary: first.compaction.summary,
                details: first.compaction.details,
            },
        },
        harness.ctx,
    );
    const completed = harness.controller.getRun();
    assert.equal(completed?.stage, "complete");
    assert.ok(completed, "the committed checkpoint must remain observable");
    assert.deepEqual(
        requests,
        ["summary-A", "summary-A"],
        "a split-turn operation summarizes both history and the turn prefix",
    );

    requests.length = 0;
    live = null;
    const second = await harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );

    assert.deepEqual(second, {}, "a disabled attempt must yield to Pi native compaction");
    const after = harness.controller.getRun();
    assert.equal(after?.stage, "complete");
    assert.equal(after?.id, completed.id, "disable mode must retain the completed run identity");
    assert.equal(after?.summary, completed.summary);
    assert.equal(after?.finishedAt, completed.finishedAt);
    assert.deepEqual(requests, [], "the disabled attempt must not start another summary request");
});

test("settings: a throwing configuration getter cancels instead of falling back to native compaction", async () => {
    // A read failure is unrecoverable, not a user-chosen disable: silently yielding to Pi would
    // bypass Lune without consent, so the operation must cancel and surface the error.
    const requests: string[] = [];
    const harness = createControllerHarness({
        configuration: () => {
            throw new Error("settings backend unavailable");
        },
        registry: {
            models: [summaryModel("summary-A")],
            streamSimple: (model) => {
                requests.push(model.id);
                return resolvedStream(summaryResponse("must not run"));
            },
        },
    });

    const result = await harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );

    assert.deepEqual(
        result,
        { cancel: true },
        "a getter failure must cancel, never yield to native",
    );
    const run = harness.controller.getRun();
    assert.equal(run?.stage, "failed");
    assert.match(run?.error?.message ?? "", /settings backend unavailable/);
    assert.deepEqual(requests, [], "a failing getter must not start provider work");
});

test("settings: an invalid non-null configuration is a reported failure, not a disable", async () => {
    // Only explicit null disables interception; invalid active configuration must cancel with its validation error.
    const harness = createControllerHarness({
        configuration: () => config({ policy: policy({ deleteThreshold: 1.01 }) }),
        registry: {
            models: [summaryModel("summary-A")],
            streamSimple: () => resolvedStream(summaryResponse("must not run")),
        },
    });

    const result = await harness.controller.beforeCompact(
        splitEvent(new AbortController().signal),
        harness.ctx,
    );

    assert.deepEqual(result, { cancel: true });
    assert.equal(harness.controller.getRun()?.stage, "failed");
    assert.match(harness.controller.getRun()?.error?.message ?? "", /deleteThreshold/);
});
