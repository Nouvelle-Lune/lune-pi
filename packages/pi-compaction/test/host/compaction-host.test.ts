import test from "node:test";
import assert from "node:assert/strict";
import {
    createAssistantMessageEventStream,
    fauxAssistantMessage,
    type AssistantMessage,
    type Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompactionOptions } from "../../src/options.ts";
import { assistantText, assistantToolCall, policy, toolResult, user } from "../harness/fixtures.ts";
import { startLifecycleHost } from "../harness/lifecycle-host.ts";

function config(overrides: Partial<CompactionOptions> = {}): CompactionOptions {
    return {
        summaryModel: { provider: "lune-summary", id: "summary-1" },
        summaryThinkingLevel: "off",
        policy: policy(),
        jev: { enabled: false },
        ...overrides,
    };
}

/** Enough history that the default keep-recent budget cuts before the read call. */
function longHistory(): AgentMessage[] {
    return [
        user("u1".padEnd(400, "x")),
        assistantText("a1".padEnd(400, "y")),
        assistantToolCall("r1", "read", { path: "report.md" }, "checking the report"),
        toolResult("r1", "read", "REPORT BODY".padEnd(400, "z")),
        user("u2".padEnd(640, "q")),
        assistantText("a2".padEnd(40, "w")),
    ];
}

interface PhysicalSummaryRequest {
    id: string;
    maxTokens: number | undefined;
    signal: AbortSignal | undefined;
}

function registerPhysicalSummaryProvider(
    pi: ExtensionAPI,
    onRequest: (request: PhysicalSummaryRequest) => void,
    responseText = "summary routed through Pi",
    failure?: Error,
): void {
    pi.registerProvider("lune-physical-summary", {
        apiKey: "test-key",
        api: "faux",
        baseUrl: "http://localhost:0",
        models: [
            {
                id: "physical-summary",
                name: "Physical summary",
                api: "faux",
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
                contextWindow: 200_000,
                maxTokens: 8_192,
            },
        ],
        streamSimple: (model, _context, options) => {
            onRequest({ id: model.id, maxTokens: options?.maxTokens, signal: options?.signal });
            if (failure) throw failure;
            const message = fauxAssistantMessage(responseText);
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
            return stream;
        },
    });
}

test("host: manual compact selects the summary model, records usage and file operations, then commits", async (t) => {
    // A manual compact must use the selected model and attach result metadata to Pi's checkpoint.
    const host = await startLifecycleHost({
        configuration: () => config(),
        history: longHistory(),
    });
    t.after(() => host.dispose());
    const seen: { model: string; prompt: string }[] = [];
    host.summary.setResponses([
        (context, _options, _state, model) => {
            seen.push({ model: model.id, prompt: JSON.stringify(context) });
            return fauxAssistantMessage("## Goal\nfirst summary");
        },
    ]);
    const result = await host.session.compact();
    assert.ok(result.summary.includes("first summary"));
    assert.ok((result.details as { readFiles: string[] }).readFiles.includes("report.md"));
    assert.equal(
        seen[0]!.model,
        "summary-1",
        "the selected summary model must receive the request",
    );
    const run = host.controller.getRun();
    assert.equal(run?.stage, "complete");
    assert.equal(run?.summaryModel?.id, "summary-1");
    assert.ok(run?.summaryUsage, "usage must be recorded from the summary response");
    assert.ok(host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
});

test("host: a virtual summary model uses Pi's direct route and commits from its physical target", async (t) => {
    // Pi virtual entries expose unknown zero limits until routing selects a physical model.
    const routeReasons: string[] = [];
    const routeTargets: string[] = [];
    const summaryRequests: PhysicalSummaryRequest[] = [];
    const registerVirtual = (pi: ExtensionAPI): void => {
        registerPhysicalSummaryProvider(pi, (request) => summaryRequests.push(request));
        pi.registerVirtualModel({
            provider: "lune-summary-router",
            id: "virtual-summary",
            name: "Virtual summary",
            route: (request, ctx) => {
                routeReasons.push(request.reason);
                const model = ctx.modelRegistry.find("lune-physical-summary", "physical-summary");
                if (!model) throw new Error("The virtual route target is not registered");
                routeTargets.push(`${model.provider}/${model.id}`);
                return { model, thinkingLevel: request.thinkingLevel };
            },
        });
    };
    const host = await startLifecycleHost({
        configuration: () =>
            config({ summaryModel: { provider: "lune-summary-router", id: "virtual-summary" } }),
        history: longHistory(),
        observerFactories: [registerVirtual],
    });
    t.after(() => host.dispose());

    const virtual = host.context().modelRegistry.find("lune-summary-router", "virtual-summary");
    assert.ok(virtual);
    assert.equal(virtual.api, "pi-virtual");
    assert.equal(virtual.contextWindow, 0);
    assert.equal(virtual.maxTokens, 0);

    const result = await host.session.compact();

    assert.match(result.summary, /summary routed through Pi/);
    assert.ok(routeReasons.length > 0);
    assert.ok(routeReasons.every((reason) => reason === "direct"));
    assert.ok(routeTargets.every((target) => target === "lune-physical-summary/physical-summary"));
    assert.ok(summaryRequests.length > 0);
    assert.ok(
        summaryRequests.every(
            (request) => request.id === "physical-summary" && (request.maxTokens ?? 0) > 0,
        ),
        "the routed physical model must receive the sized request",
    );
    assert.equal(host.summary.state.callCount, 0);
    assert.equal(host.main.state.callCount, 0);
    assert.equal(host.controller.getRun()?.summaryModel?.id, "virtual-summary");
    assert.ok(host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
});

test("host: a failed virtual direct route cancels compact without committing a checkpoint", async (t) => {
    // Pi routing failures must remain visible and must never fall through to another summary provider.
    const routeReasons: string[] = [];
    const registerVirtual = (pi: ExtensionAPI): void => {
        pi.registerVirtualModel({
            provider: "lune-summary-router",
            id: "virtual-summary",
            name: "Virtual summary",
            route: (request) => {
                routeReasons.push(request.reason);
                throw new Error("virtual summary route failed");
            },
        });
    };
    const host = await startLifecycleHost({
        configuration: () =>
            config({ summaryModel: { provider: "lune-summary-router", id: "virtual-summary" } }),
        history: longHistory(),
        observerFactories: [registerVirtual],
    });
    t.after(() => host.dispose());
    host.summary.setResponses([fauxAssistantMessage("must not be used")]);

    await assert.rejects(host.session.compact(), /cancelled/i);

    assert.deepEqual(routeReasons, ["direct"]);
    assert.equal(host.summary.state.callCount, 0);
    assert.equal(host.main.state.callCount, 0);
    assert.equal(host.controller.getRun()?.stage, "failed");
    assert.match(host.controller.getRun()?.error?.message ?? "", /virtual summary route failed/);
    assert.ok(!host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
});

test("host: abortCompaction during a pending virtual route prevents a late physical request", async (t) => {
    // A route that resolves after Pi aborts compaction must not start the physical summary request.
    let markRouteStarted!: () => void;
    const routeStarted = new Promise<void>((resolve) => {
        markRouteStarted = resolve;
    });
    let releaseRoute!: () => void;
    const routeGate = new Promise<void>((resolve) => {
        releaseRoute = resolve;
    });
    let markRouteReturned!: () => void;
    const routeReturned = new Promise<void>((resolve) => {
        markRouteReturned = resolve;
    });
    let routeSignal: AbortSignal | undefined;
    let physicalRequests = 0;
    const registerVirtual = (pi: ExtensionAPI): void => {
        registerPhysicalSummaryProvider(pi, () => physicalRequests++, "late routed response");
        pi.registerVirtualModel({
            provider: "lune-summary-router",
            id: "virtual-summary",
            name: "Virtual summary",
            route: async (request, ctx) => {
                routeSignal = request.signal;
                markRouteStarted();
                await routeGate;
                const model = ctx.modelRegistry.find("lune-physical-summary", "physical-summary");
                if (!model) throw new Error("The virtual route target is not registered");
                markRouteReturned();
                return { model, thinkingLevel: request.thinkingLevel };
            },
        });
    };
    const host = await startLifecycleHost({
        configuration: () =>
            config({ summaryModel: { provider: "lune-summary-router", id: "virtual-summary" } }),
        history: longHistory(),
        observerFactories: [registerVirtual],
    });
    t.after(() => host.dispose());

    const operation = host.session.compact();
    await routeStarted;
    assert.ok(routeSignal, "Pi must pass its active compaction signal into model routing");
    const aborted = new Promise<void>((resolve) =>
        routeSignal!.addEventListener("abort", () => resolve(), { once: true }),
    );

    host.session.abortCompaction();
    await aborted;
    releaseRoute();
    await routeReturned;
    await assert.rejects(operation, /cancelled/i);
    assert.equal(routeSignal.aborted, true);
    assert.equal(host.controller.getRun()?.stage, "cancelled");
    assert.ok(!host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
    assert.equal(physicalRequests, 0);
    assert.equal(host.summary.state.callCount, 0);
    assert.ok(!host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
});

test("host: a previous summary is supplied for the update prompt and the run awaits commit", async (t) => {
    // Incremental compaction must receive the prior checkpoint and remain pending until Pi commits the next one.
    const host = await startLifecycleHost({
        configuration: () => config(),
        history: longHistory(),
    });
    t.after(() => host.dispose());
    const seen: string[] = [];
    host.summary.setResponses([
        (context) => {
            seen.push(JSON.stringify(context));
            return fauxAssistantMessage("## Goal\nupdated summary");
        },
    ]);
    const event = {
        preparation: {
            messagesToSummarize: longHistory(),
            turnPrefixMessages: [],
            isSplitTurn: false,
            firstKeptEntryId: "keep",
            tokensBefore: 1234,
            previousSummary: "PRIOR_CHECKPOINT_XYZ",
            fileOps: {
                read: new Set<string>(),
                edited: new Set<string>(),
                written: new Set<string>(),
            },
            settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 },
        },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
    } as never;
    const result = await host.controller.beforeCompact(event, host.context());
    assert.ok(result.compaction, "the handler must return the generated checkpoint");
    assert.match(
        seen[0]!,
        /PRIOR_CHECKPOINT_XYZ/,
        "the previous checkpoint must be supplied for the update prompt",
    );
    assert.equal(host.controller.getRun()?.stage, "awaiting-commit");

    // A second request while a checkpoint awaits Pi's commit must be refused, not run concurrently.
    const second = await host.controller.beforeCompact(event, host.context());
    assert.equal(second.cancel, true);
});

test("host: a split turn summarizes the turn prefix separately", async (t) => {
    // Pi's split-turn prefix must be summarized with the split-turn context marker.
    const messages = [user("u1".padEnd(400, "x")), assistantText("a1".padEnd(400, "y"))];
    const host = await startLifecycleHost({ configuration: () => config(), history: messages });
    t.after(() => host.dispose());
    host.summary.setResponses([fauxAssistantMessage("prefix checkpoint")]);
    const result = await host.session.compact();
    assert.match(result.summary, /Turn Context \(split turn\)/);
    assert.ok(result.summary.includes("prefix checkpoint"));
    assert.equal(
        host.summary.state.callCount,
        1,
        "a split turn with no history issues one turn-prefix request",
    );
});

test("host: a failed summary cancels the compaction and writes no checkpoint", async (t) => {
    // An unavailable selected model must fail the Lune operation without committing an empty result.
    const host = await startLifecycleHost({
        configuration: () => config({ summaryModel: { provider: "lune-summary", id: "missing" } }),
        history: longHistory(),
    });
    t.after(() => host.dispose());
    await assert.rejects(host.session.compact(), /cancelled/);
    assert.ok(
        !host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
        "a failed operation must not commit",
    );
    assert.equal(host.controller.getRun()?.stage, "failed");
    assert.match(host.controller.getRun()?.error?.message ?? "", /not registered/);
});

test("host: an invalid Jev policy returns a cancel result and is reported as a failure", async (t) => {
    // Active settings with an invalid policy must cancel instead of yielding to Pi's native path.
    const host = await startLifecycleHost({
        configuration: () => config({ policy: policy({ deleteThreshold: 1.01 }) }),
        history: longHistory(),
    });
    t.after(() => host.dispose());
    const event = {
        preparation: {
            messagesToSummarize: longHistory(),
            turnPrefixMessages: [],
            firstKeptEntryId: "x",
            tokensBefore: 0,
            isSplitTurn: false,
            fileOps: { read: new Set(), edited: new Set(), written: new Set() },
            settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
        },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
    } as never;
    const result = await host.controller.beforeCompact(event, host.context());
    assert.equal(result.cancel, true);
    assert.equal(host.controller.getRun()?.stage, "failed");
    assert.match(host.controller.getRun()?.error?.message ?? "", /deleteThreshold/);
});

test("host: abortCompaction cancels a pending summary request and prevents a late checkpoint", async (t) => {
    // Pi's session signal owns manual cancellation; a provider response arriving afterward cannot revive the run.
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    let requestStream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
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
        history: longHistory(),
        observerFactories: [registerControlled],
    });
    t.after(() => host.dispose());

    const operation = host.session.compact();
    await requestStarted;
    assert.ok(requestSignal, "the Pi-backed summary call must receive its cancellation signal");
    const aborted = new Promise<void>((resolve) =>
        requestSignal!.addEventListener("abort", () => resolve(), { once: true }),
    );

    host.session.abortCompaction();
    await aborted;
    const late = usageMessage("late provider result", controlledUsage(10, 2));
    const lateProviderResult = requestStream!.result();
    requestStream!.push({ type: "done", reason: "stop", message: late });
    requestStream!.end(late);
    await lateProviderResult;
    await assert.rejects(operation, /cancelled/i);
    assert.equal(requestSignal.aborted, true);
    assert.equal(host.controller.getRun()?.stage, "cancelled");
    assert.equal(host.controller.getRun()?.summary, undefined);
    assert.ok(!host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
});

test("host: a physical summary provider failure cancels compact without committing a checkpoint", async (t) => {
    // Pi provider errors must remain visible and cannot produce an empty or partial checkpoint.
    const requests: PhysicalSummaryRequest[] = [];
    const providerFailure = new Error("physical summary provider failed");
    const registerProvider = (pi: ExtensionAPI): void => {
        registerPhysicalSummaryProvider(
            pi,
            (request) => requests.push(request),
            "unused",
            providerFailure,
        );
    };
    const host = await startLifecycleHost({
        configuration: () =>
            config({ summaryModel: { provider: "lune-physical-summary", id: "physical-summary" } }),
        history: longHistory(),
        observerFactories: [registerProvider],
    });
    t.after(() => host.dispose());

    await assert.rejects(host.session.compact(), /cancelled/i);

    assert.equal(requests.length, 1);
    assert.equal(host.controller.getRun()?.stage, "failed");
    assert.match(
        host.controller.getRun()?.error?.message ?? "",
        /physical summary provider failed/,
    );
    assert.ok(!host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
});

test("host: summary responses that call a tool cannot become a checkpoint", async (t) => {
    // Summary output is inert text and must not introduce executable tool calls into the transcript.
    const host = await startLifecycleHost({
        configuration: () => config(),
        history: longHistory(),
    });
    t.after(() => host.dispose());
    const bad: AssistantMessage = fauxAssistantMessage([
        { type: "text", text: "ok" },
        { type: "toolCall", id: "t", name: "read", arguments: {} },
    ]);
    host.summary.setResponses([bad]);
    await assert.rejects(host.session.compact(), /cancelled/);
    assert.ok(!host.sessionManager.getEntries().some((entry) => entry.type === "compaction"));
});

function promptText(context: unknown): string {
    for (const message of (context as { messages: Array<{ role: string; content: unknown }> })
        .messages) {
        if (message.role !== "user") continue;
        if (typeof message.content === "string") return message.content;
        if (Array.isArray(message.content))
            return message.content.map((block) => (block as { text?: string }).text ?? "").join("");
    }
    return "";
}

function usageMessage(text: string, usage: Usage): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "faux",
        provider: "lune-controlled",
        model: "controlled-1",
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

function controlledUsage(input: number, output: number): Usage {
    return {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

test("host: a real history plus turn-prefix split turn merges two summaries, previous summary, focus, file ops and usage", async (t) => {
    // Split-turn output must combine history and prefix while preserving request-specific focus and metadata.
    const prompts: string[] = [];
    const queue: AssistantMessage[] = [];
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
            streamSimple: (_model, context) => {
                prompts.push(promptText(context));
                const message = queue.shift();
                if (!message)
                    throw new Error("Controlled summary provider exhausted its scripted responses");
                const stream = createAssistantMessageEventStream();
                stream.push({ type: "done", reason: "stop", message });
                stream.end(message);
                return stream;
            },
        });
    };

    // Compact once so the next operation carries a native previous summary.
    const firstHistory: AgentMessage[] = [
        user("h1".padEnd(400, "x")),
        assistantText("a1"),
        user("h2".padEnd(400, "y")),
        assistantText("a2"),
    ];
    const host = await startLifecycleHost({
        configuration: () =>
            config({ summaryModel: { provider: "lune-controlled", id: "controlled-1" } }),
        history: firstHistory,
        observerFactories: [registerControlled],
    });
    t.after(() => host.dispose());

    queue.push(usageMessage("prior summary", controlledUsage(1, 1)));
    const first = await host.session.compact();
    assert.ok(first.summary.includes("prior summary"));
    assert.equal(prompts.length, 1, "an end-of-turn cut issues a single history summary");

    // Append one turn with a read call and a large trailing turn so the cut splits it.
    host.sessionManager.appendMessage(user("t1".padEnd(400, "p")) as never);
    host.sessionManager.appendMessage(
        assistantToolCall("read-1", "read", { path: "src/a.ts" }) as never,
    );
    host.sessionManager.appendMessage(toolResult("read-1", "read", "BODY") as never);
    host.sessionManager.appendMessage(assistantText("a3") as never);
    host.sessionManager.appendMessage(user("t2".padEnd(400, "q")) as never);
    host.sessionManager.appendMessage(assistantText("a4".padEnd(400, "r")) as never);

    prompts.length = 0;
    queue.push(usageMessage("history checkpoint", controlledUsage(100, 10)));
    queue.push(usageMessage("prefix checkpoint", controlledUsage(200, 20)));
    const second = await host.session.compact("FOCUS_XYZ");

    assert.equal(prompts.length, 2, "a split turn issues a history and a turn-prefix request");
    assert.match(
        prompts[0]!,
        /<previous-summary>[\s\S]*prior summary/,
        "the history request must merge the previous summary",
    );
    assert.match(
        prompts[0]!,
        /Additional focus: FOCUS_XYZ/,
        "custom instructions must reach the history prompt",
    );
    assert.doesNotMatch(
        prompts[1]!,
        /Additional focus/,
        "custom instructions belong to the history summary only",
    );
    assert.match(prompts[1]!, /# Instructions/);
    assert.ok(second.summary.includes("history checkpoint"));
    assert.match(second.summary, /Turn Context \(split turn\)/);
    assert.ok(second.summary.includes("prefix checkpoint"));
    assert.ok(
        (second.details as { readFiles: string[] }).readFiles.includes("src/a.ts"),
        "file operations from the summarized history are recorded",
    );
    assert.equal(second.usage?.totalTokens, 330, "usage aggregates both summary requests");
    assert.equal(second.usage?.input, 300);
    assert.equal(second.usage?.output, 30);
});
