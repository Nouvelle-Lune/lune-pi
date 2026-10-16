import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
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

test("host: a distinct summary model receives the summary request and the main model selection is untouched", async (t) => {
    // Summary routing must not alter the user's selected model or its session bookkeeping.
    const host = await startLifecycleHost({
        configuration: () => config(),
        history: longHistory(),
    });
    t.after(() => host.dispose());

    const summaryRequests: string[] = [];
    host.summary.setResponses([
        (_context, _options, _state, model) => {
            summaryRequests.push(model.id);
            return fauxAssistantMessage("## Goal\nseparate-model summary");
        },
    ]);

    const modelChangesBefore = host.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "model_change");
    const thinkingBefore = host.session.thinkingLevel;
    const mainModelBefore = host.session.model?.id;

    const result = await host.session.compact();

    assert.ok(result.summary.includes("separate-model summary"));
    assert.deepEqual(
        summaryRequests,
        ["summary-1"],
        "the configured summary model must receive the request",
    );
    assert.equal(host.summary.state.callCount, 1);
    assert.equal(host.main.state.callCount, 0, "the main model must never serve a summary request");
    assert.equal(host.controller.getRun()?.summaryModel?.id, "summary-1");

    // Selecting a separate summary model must not re-route the main conversation or its bookkeeping.
    assert.equal(host.session.model?.id, mainModelBefore);
    assert.equal(host.session.model?.id, "main-1");
    assert.equal(host.session.thinkingLevel, thinkingBefore);
    const modelChangesAfter = host.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "model_change");
    assert.deepEqual(
        modelChangesAfter,
        modelChangesBefore,
        "no model-change record is written for the summary model",
    );
    assert.ok(!modelChangesAfter.some((entry) => entry.provider === "lune-summary"));
});
