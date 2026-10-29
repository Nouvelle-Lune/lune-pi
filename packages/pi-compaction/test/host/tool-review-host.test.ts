import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { assistantText, assistantToolCall, policy, toolResult, user } from "../harness/fixtures.ts";
import type { JevOptions } from "../../src/options.ts";
import { toolReviewRecord } from "../../src/ui/review-notice.ts";
import { plainTheme, recordWidgets } from "../harness/widget-ui.ts";
import {
    startJevHost,
    type JevHost,
    systemOneAnswers,
    type PendingSystemOneRequest,
    type SystemOneRequest,
} from "../harness/tool-review-host.ts";

const GOAL = "PLEASE_REVIEW_REPORTS";
const RESULT_ONE_BODY = "R1BODY ".repeat(700);
const RESULT_TWO_BODY = "R2BODY ".repeat(700);

/** Metadata must remain in session history without inflating classifier state. */
function readResult(id: string, path: string, text: string, timestamp: number): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text }],
        details: { path, bytes: text.length, marker: `DETAILS_MARKER_${id}` },
        nestedCalls: { calls: [], complete: true },
        isError: false,
        timestamp,
    };
}

/** Two read calls plus surrounding history, arranged so both reads fall inside the summarized region. */
function readHistory(): AgentMessage[] {
    return [
        user(GOAL.padEnd(400, "x")),
        assistantText("a1".padEnd(400, "y")),
        assistantToolCall("r1", "read", { path: "docs/one.md" }),
        readResult("r1", "docs/one.md", RESULT_ONE_BODY, 1_700_000_100_000),
        assistantToolCall("r2", "read", { path: "docs/two.md" }),
        readResult("r2", "docs/two.md", RESULT_TWO_BODY, 1_700_000_200_000),
        user("u2".padEnd(640, "z")),
        assistantText("a2".padEnd(40, "w")),
    ];
}

/** Binds a TUI context whose notifications and widgets are recorded instead of drawn. */
async function bindRecordedUi(host: Awaited<ReturnType<typeof startJevHost>>) {
    const notifications: { text: string; type?: string }[] = [];
    const widgets = recordWidgets();
    const ui = host.captureContext().ui;
    await host.session.bindExtensions({
        mode: "tui",
        uiContext: {
            ...ui,
            notify: (text, type) => notifications.push({ text, type }),
            setWidget: widgets.setWidget,
        } as typeof ui,
    });
    return { notifications, widgets };
}

const REVIEW_TYPE = "lune-compaction-review";

/** Progress was shown during the run, then the widget was cleared and nothing was announced. */
function assertProgressShownThenCleared(
    widgets: ReturnType<typeof recordWidgets>,
    notifications: { text: string; type?: string }[],
): void {
    assert.deepEqual(
        notifications.filter(({ type }) => type === "info"),
        [],
    );
    const mounts = widgets.calls.filter((call) => call.content !== undefined);
    assert.equal(mounts.length, 1, "the progress row is mounted once and then updated in place");
    assert.deepEqual(mounts[0]!.options, { placement: "aboveEditor" });
    for (const call of widgets.calls) assert.equal(call.key, REVIEW_TYPE);
    assert.equal(widgets.calls.at(-1)!.content, undefined, "the widget is cleared after the run");
    assert.equal(widgets.component(), undefined, "nothing stays pinned");
}

/** The entry is appended synchronously inside session_compact, so it is saved when compact() returns. */
function savedReviewEntries(host: Awaited<ReturnType<typeof startJevHost>>) {
    const entries = host.sessionManager.getEntries();
    const reviews = entries.filter(
        (entry) => entry.type === "custom" && entry.customType === REVIEW_TYPE,
    );
    return { entries, reviews };
}

/** Renders a saved entry through the renderer the extension registered with Pi. */
function renderSavedEntry(
    host: Awaited<ReturnType<typeof startJevHost>>,
    entry: unknown,
    expanded = false,
    width = 100,
): string {
    const renderer = host.session.extensionRunner.getEntryRenderer(REVIEW_TYPE);
    assert.ok(renderer, "the extension registers a renderer for the review entry");
    const component = renderer(entry as never, { expanded } as never, plainTheme());
    assert.ok(component);
    return component.render(width).join("\n");
}

function assertEntryAfterCompaction(
    host: Awaited<ReturnType<typeof startJevHost>>,
    saved: Awaited<ReturnType<typeof savedReviewEntries>>,
    report: NonNullable<ReturnType<JevHost["controller"]["getRun"]>>["jev"],
): string {
    assert.ok(report);
    assert.equal(saved.reviews.length, 1);
    const review = saved.reviews[0]!;
    const compactionIndex = saved.entries.findIndex((entry) => entry.type === "compaction");
    assert.ok(compactionIndex >= 0);
    assert.equal(
        saved.entries.indexOf(review),
        compactionIndex + 1,
        "the entry directly follows the summary",
    );
    const expected = toolReviewRecord(report);
    const actual = review.type === "custom" ? review.data : undefined;
    assert.deepEqual(actual, expected);
    return renderSavedEntry(host, review);
}

const JEV_POLICY = policy({
    deletableTools: ["read"],
});

/** A classifier supplied by a registered Pi provider. */
function jevOptions(): JevOptions {
    return {
        enabled: true,
        model: { provider: "registry-jev", id: "jev-latest" },
    };
}

test(
    "host: a codemode result with complete, permitted and successful nested calls is classified and removed",
    { timeout: 10000 },
    async () => {
        const messages = readHistory();
        const codemode: ToolResultMessage = {
            role: "toolResult",
            toolCallId: "cm",
            toolName: "codemode",
            content: [{ type: "text", text: "CODEMODE_BODY" }],
            nestedCalls: {
                complete: true,
                calls: [{ id: "cm-1", name: "read", status: "ok" }],
            },
            isError: false,
            timestamp: 1_700_000_300_000,
        };
        messages.splice(2, 0, assistantToolCall("cm", "codemode", { script: "read()" }), codemode);
        const host = await startJevHost({
            messages,
            jev: jevOptions,
            policy: policy({ deletableTools: ["read", "codemode"] }),
            contextWindow: 64_000,
        });
        try {
            host.simulator.setResponder((pending) =>
                pending.respond(systemOneAnswers(pending.request, 1)),
            );
            host.faux.setResponses([fauxAssistantMessage("## Goal\ncodemode summary")]);
            await host.session.compact();
            const sent = JSON.stringify(host.simulator.requests);
            assert.ok(sent.includes("CODEMODE_BODY"));
            const report = host.controller.getRun()?.jev;
            assert.deepEqual(report?.protectedTools, []);
            assert.deepEqual(report?.removedCalls, ["cm", "r1", "r2"]);
        } finally {
            await host.dispose();
        }
    },
);

test(
    "host: native System One sends one minimal safeToDrop request per chunk and commits pair removal",
    { timeout: 10000 },
    async () => {
        // Exercise the real registry, wire-level bool conversion, pruning and checkpoint commit.
        const messages = readHistory();
        const original = structuredClone(messages);
        const host = await startJevHost({
            messages,
            jev: jevOptions,
            policy: JEV_POLICY,
            contextWindow: 64_000,
        });
        try {
            host.simulator.setResponder((pending) =>
                pending.respond(systemOneAnswers(pending.request, 1)),
            );
            host.faux.setResponses([fauxAssistantMessage("## Goal\nminimal host summary")]);
            const result = await host.session.compact();
            assert.match(result.summary, /minimal host summary/);
            const requests = host.simulator.requests;
            assert.equal(requests.length, 4);
            for (const request of requests) {
                assert.match(request.url, /\/systemone$/u);
                assert.equal(request.authorization, "Bearer fake-test-key");
                assert.equal(request.model, "jev-latest");
                assert.deepEqual(Object.keys(request.questions), ["safeToDrop"]);
                assert.equal(request.questions.safeToDrop!.type, "noul");
                assert.deepEqual(Object.keys(request.state).sort(), [
                    "currentRequest",
                    "originatingRequest",
                    "result",
                    "toolCall",
                ]);
            }
            assert.equal(host.registryJevCalls(), requests.length);
            const sent = JSON.stringify(requests);
            assert.ok(sent.includes(GOAL));
            assert.ok(sent.includes("docs/one.md") && sent.includes("docs/two.md"));
            assert.ok(sent.includes("R1BODY") && sent.includes("R2BODY"));
            assert.ok(!sent.includes("DETAILS_MARKER"));
            assert.ok(!sent.includes("retainedProgress"));
            assert.deepEqual(messages, original);
            const run = host.controller.getRun();
            assert.equal(run?.stage, "complete");
            assert.equal(run?.jev?.requests, 4);
            assert.deepEqual(run?.jev?.removedCalls, ["r1", "r2"]);
            assert.equal(
                run?.jev?.chunkDecisions.every((decision) => decision.action === "drop"),
                true,
            );
            assert.ok(
                host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
            );
        } finally {
            await host.dispose();
        }
    },
);

test(
    "host: an HTTP error from Jev strictly cancels with no checkpoint and no summary request",
    { timeout: 10000 },
    async () => {
        // A Jev transport failure leaves deletion decisions unknown, so summary and checkpoint work must stop.
        const host = await startJevHost({
            messages: readHistory(),
            jev: jevOptions,
            policy: JEV_POLICY,
        });
        try {
            host.simulator.setResponder((pending) => {
                pending.fail(500, "boom");
            });
            host.faux.setResponses([fauxAssistantMessage("must not be used")]);

            await assert.rejects(host.session.compact(), /cancelled/i);
            assert.ok(
                host.simulator.requests.length >= 1,
                "the failure must come from a real request, not from a misconfigured budget",
            );
            assert.ok(
                host.registryJevCalls() > 0,
                "the failure must originate from the configured Pi classifier",
            );
            assert.equal(
                host.faux.state.callCount,
                0,
                "no summary model request may run after a Jev failure",
            );
            assert.ok(
                !host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
                "no checkpoint may be committed",
            );
            assert.equal(host.controller.getRun()?.stage, "failed");
            assert.match(
                host.controller.getRun()?.error?.message ?? "",
                /500/,
                "the recorded failure must be the simulated HTTP 500, not a generic cancel",
            );
        } finally {
            await host.dispose();
        }
    },
);

test(
    "host: abortCompaction cancels a pending Jev request and prevents a checkpoint",
    { timeout: 10000 },
    async () => {
        // Jev shares Pi's compaction signal, so an explicit user cancel must terminate classification before summary work.
        const host = await startJevHost({
            messages: readHistory(),
            jev: jevOptions,
            policy: JEV_POLICY,
        });
        try {
            let markRequestStarted!: () => void;
            const requestStarted = new Promise<void>((resolve) => {
                markRequestStarted = resolve;
            });
            let pendingRequest: PendingSystemOneRequest | undefined;
            host.simulator.setResponder((pending) => {
                pendingRequest = pending;
                markRequestStarted();
            });
            host.faux.setResponses([fauxAssistantMessage("must not be used")]);

            const operation = host.session.compact();
            await requestStarted;
            assert.ok(
                pendingRequest,
                "a real Jev HTTP request must be pending before cancellation",
            );
            host.session.abortCompaction();

            await pendingRequest.aborted;
            await assert.rejects(operation, /cancelled/i);
            assert.equal(
                host.faux.state.callCount,
                0,
                "summary work must not start after Jev is cancelled",
            );
            assert.ok(
                !host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
            );
            assert.equal(host.controller.getRun()?.stage, "cancelled");
        } finally {
            await host.dispose();
        }
    },
);

test("host: a missing or invalid Jev answer strictly cancels", { timeout: 10000 }, async () => {
    // Missing or out-of-range probabilities are protocol failures and cannot authorize a checkpoint.
    const replies = [
        () => ({ answers: {} }), // no answers at all
        (request: SystemOneRequest) => ({
            answers: Object.fromEntries(
                Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 2 }]),
            ),
        }), // out-of-range probability
    ];
    for (const reply of replies) {
        const host = await startJevHost({
            messages: readHistory(),
            jev: jevOptions,
            policy: JEV_POLICY,
        });
        try {
            host.simulator.setResponder((pending) => {
                pending.respond(reply(pending.request));
            });
            host.faux.setResponses([fauxAssistantMessage("must not be used")]);
            await assert.rejects(host.session.compact(), /cancelled/i);
            assert.ok(
                host.simulator.requests.length >= 1,
                "a real request must have been made before the answer was rejected",
            );
            assert.equal(host.faux.state.callCount, 0);
            assert.ok(
                !host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
            );
            assert.equal(host.controller.getRun()?.stage, "failed");
            assert.match(
                host.controller.getRun()?.error?.message ?? "",
                /did not return an answer|invalid probability/,
                "the recorded failure must be the answer-protocol rejection, not a generic cancel",
            );
        } finally {
            await host.dispose();
        }
    }
});

test(
    "host: a batch failure cancels siblings and a late response cannot update state",
    { timeout: 10000 },
    async () => {
        // Parallel requests must share cancellation, and a late sibling response cannot revive failed decisions.
        const host = await startJevHost({
            messages: readHistory(),
            jev: jevOptions,
            policy: JEV_POLICY,
        });
        try {
            const pendings: PendingSystemOneRequest[] = [];
            let release!: () => void;
            const twoPending = new Promise<void>((resolve) => {
                release = resolve;
            });
            host.simulator.setResponder((pending) => {
                pendings.push(pending);
                if (pendings.length >= 2) release();
            });
            host.faux.setResponses([fauxAssistantMessage("must not be used")]);

            const compacting = host.session.compact();
            compacting.catch(() => undefined); // the rejection is asserted after the pending batches are released
            // Race the arrival of the second batch against compact settling: if it ends first, the fixture would
            // otherwise wait forever on a request that can no longer arrive.
            const settled = compacting.then(
                () => "settled" as const,
                () => "settled" as const,
            );
            const outcome = await Promise.race([twoPending.then(() => "two" as const), settled]);
            assert.equal(
                outcome,
                "two",
                "compact settled before two batches were observably in flight",
            );
            assert.ok(pendings.length >= 2, "two concurrent batches must be in flight");
            pendings[0]!.fail(500, "first batch failed");
            await pendings[1]!.aborted; // the sibling fetch must be cancelled, not left running
            // A late answer arriving after cancellation must never resurrect the run.
            pendings[1]!.respond(systemOneAnswers(pendings[1]!.request, 0));

            await assert.rejects(compacting, /cancelled/i);
            assert.equal(host.faux.state.callCount, 0);
            assert.ok(
                !host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
            );
            assert.equal(host.controller.getRun()?.stage, "failed");
        } finally {
            await host.dispose();
        }
    },
);

test(
    "host: an unexpected responder exception fails the test after cleanup instead of passing as a network failure",
    { timeout: 10000 },
    async () => {
        // Simulator bugs must remain distinguishable from transport failures after every host is cleaned up.
        const modes: [string, () => never | Promise<never>][] = [
            [
                "synchronously",
                () => {
                    throw new Error("fixture exploded synchronously");
                },
            ],
            [
                "asynchronously",
                async () => {
                    throw new Error("fixture exploded asynchronously");
                },
            ],
        ];
        for (const [label, responder] of modes) {
            const host = await startJevHost({
                messages: readHistory(),
                jev: jevOptions,
                policy: JEV_POLICY,
            });
            try {
                host.simulator.setResponder(responder);
                host.faux.setResponses([fauxAssistantMessage("must not be used")]);
                await assert.rejects(host.session.compact(), /cancelled/i, label);
            } finally {
                // dispose releases the session and temp directory first, then surfaces the captured fixture error.
                await assert.rejects(
                    host.dispose(),
                    (error: unknown) =>
                        error instanceof AggregateError && /fixture exploded/.test(error.message),
                    label,
                );
            }
        }
    },
);

test(
    "host: a tool call with non-JSON arguments strictly cancels before any classification",
    { timeout: 10000 },
    async () => {
        // Lossy JSON serialization would corrupt classifier input, so invalid arguments must fail before network work.
        const messages: AgentMessage[] = [
            user(GOAL.padEnd(400, "x")),
            assistantText("a1".padEnd(400, "y")),
            // `undefined` is erased by JSON.stringify, so it must be rejected instead of silently corrupted.
            assistantToolCall("bad", "read", { path: "a.ts", missing: undefined }),
            toolResult("bad", "read", "body"),
            user("u2".padEnd(640, "z")),
            assistantText("a2".padEnd(40, "w")),
        ];
        const host = await startJevHost({ messages, jev: jevOptions, policy: JEV_POLICY });
        try {
            host.simulator.setResponder((pending) => {
                pending.respond(systemOneAnswers(pending.request, 0));
            });
            host.faux.setResponses([fauxAssistantMessage("must not be used")]);
            await assert.rejects(host.session.compact(), /cancelled/i);
            assert.equal(
                host.simulator.requests.length,
                0,
                "invalid arguments must fail before any Jev request",
            );
            assert.equal(host.faux.state.callCount, 0);
            assert.ok(
                !host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
            );
            assert.match(host.controller.getRun()?.error?.message ?? "", /non-JSON value/);
        } finally {
            await host.dispose();
        }
    },
);

test(
    "host: a tool call with non-plain object arguments strictly cancels",
    { timeout: 10000 },
    async () => {
        // Class instances are outside the stable JSON contract and must not be silently serialized for Jev.
        class NotJson {
            readonly value = 1;
        }
        const messages: AgentMessage[] = [
            user(GOAL.padEnd(400, "x")),
            assistantText("a1".padEnd(400, "y")),
            assistantToolCall("bad", "read", { nested: new NotJson() }),
            toolResult("bad", "read", "body"),
            user("u2".padEnd(640, "z")),
            assistantText("a2".padEnd(40, "w")),
        ];
        const host = await startJevHost({ messages, jev: jevOptions, policy: JEV_POLICY });
        try {
            host.simulator.setResponder((pending) => {
                pending.respond(systemOneAnswers(pending.request, 0));
            });
            host.faux.setResponses([fauxAssistantMessage("must not be used")]);
            await assert.rejects(host.session.compact(), /cancelled/i);
            assert.equal(host.simulator.requests.length, 0);
            assert.match(host.controller.getRun()?.error?.message ?? "", /plain JSON objects/);
        } finally {
            await host.dispose();
        }
    },
);

test(
    "host: an oversized required context uses a placeholder while other calls are classified and a checkpoint commits",
    { timeout: 10000 },
    async () => {
        const messages = readHistory();
        messages[2] = assistantToolCall("r1", "read", {
            path: "docs/one.md",
            content: "LONG_ARGUMENT_ANCHOR" + "x".repeat(40_000),
        });
        messages[3] = readResult(
            "r1",
            "docs/one.md",
            "UNCLASSIFIABLE_TOOL_BODY".padEnd(47, "x"),
            1_700_000_100_000,
        );
        const original = structuredClone(messages);
        const host = await startJevHost({
            messages,
            jev: jevOptions,
            policy: JEV_POLICY,
            contextWindow: 7_000,
        });
        try {
            host.simulator.setResponder((pending) =>
                pending.respond(systemOneAnswers(pending.request, 1)),
            );
            let summaryInput = "";
            host.faux.setResponses([
                (context) => {
                    summaryInput = JSON.stringify(context);
                    return fauxAssistantMessage("## Goal\nbudget recovery checkpoint");
                },
            ]);
            const result = await host.session.compact();
            assert.match(result.summary, /budget recovery checkpoint/);
            const run = host.controller.getRun();
            assert.equal(run?.stage, "complete");
            assert.ok(run?.jev);
            assert.equal(run.jev.requestBudget, 6_300);
            assert.equal(run.jev.budgetFallbacks.length, 1);
            assert.equal(run.jev.budgetFallbacks[0]!.stage, "chunks");
            assert.equal(run.jev.budgetFallbacks[0]!.action, "placeholder");
            assert.deepEqual(run.jev.removedCalls, ["r2"]);
            assert.ok(
                host.simulator.requests.every(
                    (request) => Object.keys(request.questions).join() === "safeToDrop",
                ),
            );
            assert.equal(host.registryJevCalls(), host.simulator.requests.length);
            assert.ok(summaryInput.includes("placeholder"));
            assert.ok(summaryInput.includes("content not classified"));
            assert.ok(summaryInput.includes("LONG_ARGUMENT_ANCHOR"));
            assert.ok(!summaryInput.includes("UNCLASSIFIABLE_TOOL_BODY"));
            assert.ok(!summaryInput.includes("R2BODY"));
            const details = result.details as {
                luneCompaction: {
                    jev: {
                        placeholderChunks: number;
                        budgetFallbacks: unknown[];
                        removedCalls: number;
                    };
                };
            };
            assert.equal(details.luneCompaction.jev.placeholderChunks, 1);
            assert.equal(details.luneCompaction.jev.budgetFallbacks.length, 1);
            assert.equal(details.luneCompaction.jev.removedCalls, 1);
            assert.equal(
                host.sessionManager.getEntries().filter((entry) => entry.type === "compaction")
                    .length,
                1,
            );
            assert.deepEqual(messages, original);
        } finally {
            await host.dispose();
        }
    },
);

test(
    "host: fallback preserves failed input, commits a checkpoint and saves the review as an entry after clearing its progress row",
    { timeout: 10000 },
    async (t) => {
        // Native transport and UI must distinguish preflight placeholders from provider-limit preservation.
        initTheme("dark", false);
        const loggedErrors = t.mock.method(console, "error", () => undefined);
        for (const mode of ["preflight", "provider"] as const) {
            const messages = readHistory();
            messages[3] = readResult("r1", "docs/one.md", "FAILED_REQUEST_BODY", 1_700_000_100_000);
            if (mode === "preflight")
                messages[2] = assistantToolCall("r1", "read", {
                    path: "docs/one.md",
                    content: "ARGUMENT_ANCHOR" + "x".repeat(40_000),
                });
            const host = await startJevHost({
                messages,
                jev: jevOptions,
                policy: JEV_POLICY,
                contextWindow: mode === "preflight" ? 7_000 : 64_000,
            });
            try {
                const { notifications, widgets } = await bindRecordedUi(host);
                host.simulator.setResponder((pending) => {
                    if (
                        mode === "provider" &&
                        pending.request.state.result === "FAILED_REQUEST_BODY"
                    )
                        pending.fail(
                            400,
                            '{"error":{"message":"HTTP 400: max_tokens_exceeded","code":400}}',
                        );
                    else pending.respond(systemOneAnswers(pending.request, 1));
                });
                let summaryInput = "";
                host.faux.setResponses([
                    (context) => {
                        summaryInput = JSON.stringify(context);
                        return fauxAssistantMessage("## Goal\nfallback checkpoint");
                    },
                ]);
                const result = await host.session.compact();
                assert.match(result.summary, /fallback checkpoint/);
                const report = host.controller.getRun()?.jev;
                assert.ok(report);
                assert.equal(host.controller.getRun()?.stage, "complete");
                assert.deepEqual(report.removedCalls, ["r2"]);
                assert.equal(report.budgetFallbacks.length, mode === "preflight" ? 1 : 0);
                assert.equal(report.oversizedRequests, mode === "provider" ? 1 : 0);
                assert.equal(host.registryJevCalls(), mode === "preflight" ? 2 : 3);
                assert.equal(summaryInput.includes("FAILED_REQUEST_BODY"), mode === "provider");
                assert.equal(summaryInput.includes("content not classified"), mode === "preflight");
                assert.ok(!summaryInput.includes("R2BODY"));
                assert.equal(loggedErrors.mock.calls.length, 0);
                assertProgressShownThenCleared(widgets, notifications);
                const rendered = assertEntryAfterCompaction(host, savedReviewEntries(host), report);
                assert.ok(rendered.includes("Tool review"));
                const removed = report.removedCalls.length;
                assert.ok(rendered.includes(`−${removed} ${removed === 1 ? "call" : "calls"}`));
                assert.equal(
                    host.sessionManager.getEntries().filter((entry) => entry.type === "compaction")
                        .length,
                    1,
                );
            } finally {
                await host.dispose();
            }
        }
    },
);

test(
    "host: the saved review entry reports fragment removal even when every tool output remains",
    { timeout: 10000 },
    async () => {
        for (const partial of [false, true]) {
            const host = await startJevHost({
                messages: readHistory(),
                jev: jevOptions,
                policy: JEV_POLICY,
            });
            try {
                const { notifications, widgets } = await bindRecordedUi(host);
                host.simulator.setResponder((pending) => {
                    const body = String(pending.request.state.result);
                    pending.respond(
                        systemOneAnswers(
                            pending.request,
                            partial && body.startsWith("R1BODY") && body.length === 4000 ? 1 : 0,
                        ),
                    );
                });
                host.faux.setResponses([fauxAssistantMessage("## Goal\nreview complete")]);
                await host.session.compact();
                assertProgressShownThenCleared(widgets, notifications);
                const rendered = assertEntryAfterCompaction(
                    host,
                    savedReviewEntries(host),
                    host.controller.getRun()?.jev,
                );
                assert.ok(rendered.includes("Tool review"));
                assert.ok(rendered.includes(partial ? "−1 fragment" : "nothing removed"));
                assert.deepEqual(host.controller.getRun()?.jev?.removedCalls, []);
                assert.equal(host.controller.getRun()?.stage, "complete");
            } finally {
                await host.dispose();
            }
        }
    },
);

test(
    "host: the review entry is saved immediately after the compaction entry, before a prompt queued for compaction_end",
    { timeout: 10000 },
    async () => {
        const host = await startJevHost({
            messages: readHistory(),
            jev: jevOptions,
            policy: JEV_POLICY,
        });
        try {
            await bindRecordedUi(host);
            host.simulator.setResponder((pending) =>
                pending.respond(systemOneAnswers(pending.request, 1)),
            );
            host.faux.setResponses([fauxAssistantMessage("## Goal\nordered summary")]);
            // Pi's flushCompactionQueue submits queued prompts from a compaction_end subscriber.
            host.session.subscribe((event) => {
                if (event.type === "compaction_end")
                    host.sessionManager.appendMessage(user("QUEUED_PROMPT") as never);
            });
            await host.session.compact();
            const entries = host.sessionManager.getEntries();
            const start = entries.findIndex((entry) => entry.type === "compaction");
            assert.ok(start >= 0);
            const actual = entries.slice(start).map((entry) => {
                if (entry.type === "custom") return `custom:${entry.customType}`;
                if (entry.type === "message") return `message:${entry.message.role}`;
                return entry.type;
            });
            const expected = ["compaction", `custom:${REVIEW_TYPE}`, "message:user"];
            assert.deepEqual(actual, expected);
            const last = entries.at(-1);
            assert.ok(last?.type === "message");
            assert.match(JSON.stringify(last.message), /QUEUED_PROMPT/);
        } finally {
            await host.dispose();
        }
    },
);
