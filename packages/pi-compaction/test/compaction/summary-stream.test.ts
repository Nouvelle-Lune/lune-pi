import test from "node:test";
import assert from "node:assert/strict";
import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Model,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSummaryStream } from "../../src/compaction-controller.ts";
import { ZERO_USAGE } from "../harness/fixtures.ts";

function chatModel(): Model<string> {
    return {
        id: "m",
        name: "m",
        api: "faux",
        provider: "p",
        baseUrl: "http://localhost:0",
        input: ["text"],
        reasoning: false,
        contextWindow: 100_000,
        maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}

function assistantMessage(
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "faux",
        provider: "p",
        model: "m",
        usage: ZERO_USAGE,
        stopReason,
        timestamp: 0,
    };
}

function upstream(message: AssistantMessage): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    stream.end(message);
    return stream;
}

function context(
    streamFor: (
        model: Model<string>,
        options?: { signal?: AbortSignal; maxTokens?: number; reasoning?: string },
    ) => AssistantMessageEventStream,
): ExtensionContext {
    return {
        modelRegistry: {
            streamSimple: (model: Model<string>, _context: unknown, options: unknown) =>
                streamFor(
                    model,
                    options as { signal?: AbortSignal; maxTokens?: number; reasoning?: string },
                ),
        },
    } as unknown as ExtensionContext;
}

function transcript(text: string): TranscriptContext {
    return {
        messages: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }],
    } as unknown as TranscriptContext;
}

function runSummary(
    streamContext: ExtensionContext,
    signal: AbortSignal,
    assertActive: () => void,
): AssistantMessageEventStream {
    const fn = createSummaryStream(streamContext, signal, assertActive);
    return fn(chatModel(), transcript("summary input"), {
        maxTokens: 128,
    }) as AssistantMessageEventStream;
}

test("createSummaryStream checks the session guard before starting a provider request", () => {
    // A retired run must not create a Pi request after its lifecycle guard has failed.
    let requests = 0;
    const fn = createSummaryStream(
        context(() => {
            requests++;
            return upstream(assistantMessage([{ type: "text", text: "unused" }]));
        }),
        new AbortController().signal,
        () => {
            throw new Error("session retired");
        },
    );

    assert.throws(
        () => fn(chatModel(), transcript("input"), { maxTokens: 128 }),
        /session retired/,
    );
    assert.equal(requests, 0);
});

test("createSummaryStream forwards a normal stop response and the Pi cancellation signal", async () => {
    // A valid per-request summary remains the input to native compact, with cancellation tied to Pi's signal.
    const controller = new AbortController();
    const expected = assistantMessage([{ type: "text", text: "the summary" }]);
    let requestSignal: AbortSignal | undefined;
    let requests = 0;
    const result = await runSummary(
        context((_model, options) => {
            requests++;
            requestSignal = options?.signal;
            return upstream(expected);
        }),
        controller.signal,
        () => undefined,
    ).result();

    assert.equal(result, expected);
    assert.equal(requests, 1);
    assert.equal(requestSignal, controller.signal);
});

test("createSummaryStream rejects non-stop and empty responses before native compact combines them", async () => {
    // Split-turn responses must each be usable summaries before Pi can build the next checkpoint.
    const cases: Array<{ message: AssistantMessage; expected: RegExp }> = [
        {
            message: assistantMessage([{ type: "text", text: "partial" }], "length"),
            expected: /Summary length/,
        },
        {
            message: assistantMessage([{ type: "text", text: "  \n " }]),
            expected: /empty text/,
        },
    ];

    for (const entry of cases) {
        const result = await runSummary(
            context(() => upstream(entry.message)),
            new AbortController().signal,
            () => undefined,
        ).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", entry.expected);
    }
});

test("createSummaryStream rechecks the session guard after the provider result", async () => {
    // A late result from a retired session must not be returned to native compact as a checkpoint.
    let checks = 0;
    const result = await runSummary(
        context(() => upstream(assistantMessage([{ type: "text", text: "late" }]))),
        new AbortController().signal,
        () => {
            if (++checks === 2) throw new Error("session retired before checkpoint");
        },
    ).result();

    assert.equal(checks, 2);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /session retired before checkpoint/);
});
