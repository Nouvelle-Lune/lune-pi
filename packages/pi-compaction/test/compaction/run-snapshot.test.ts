import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { CompactionOptions, CompactionPolicy, JevOptions } from "../../src/options.ts";
import { assistantText, assistantToolCall, policy, toolResult, user } from "../harness/fixtures.ts";
import { startLifecycleHost } from "../harness/lifecycle-host.ts";
import { startJevHost, systemOneAnswers } from "../harness/tool-review-host.ts";

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

test("controller.getRun() returns an isolated snapshot: mutating summaryModel/usage/policy cannot reach the run or the checkpoint", async () => {
    // UI consumers may edit their returned view, but must not change private run state or committed metadata.
    const host = await startLifecycleHost({
        configuration: () => config(),
        history: longHistory(),
    });
    try {
        host.summary.setResponses([fauxAssistantMessage("## Goal\nsnapshot checkpoint")]);
        const result = await host.session.compact();

        const first = host.controller.getRun();
        assert.ok(first, "a completed run must be observable");
        assert.equal(first.stage, "complete");
        assert.equal(first.summaryModel?.id, "summary-1");
        assert.ok(first.summaryUsage, "usage must be recorded from the summary response");
        const originalModelId = first.summaryModel!.id;
        const originalInput = first.summaryUsage!.input;
        const originalPolicy = first.policyVersion;

        // The top-level snapshot is frozen, so a caller cannot even attempt to rewrite scalars on it.
        assert.throws(() => {
            (first as { policyVersion?: string }).policyVersion = "HACKED";
        }, TypeError);
        // Mutate every nested value a UI might touch through the returned snapshot.
        (first.summaryModel as { id: string }).id = "HACKED";
        (first.summaryUsage as { input: number }).input = -1;

        // Re-reading the run must observe the private data, not the mutated copy. A shared reference would
        // also have rewritten the checkpoint metadata, which shares the resolved configuration object.
        const second = host.controller.getRun();
        assert.equal(
            second?.summaryModel?.id,
            originalModelId,
            "the run's summary model must not be reached through the snapshot",
        );
        assert.equal(
            second?.summaryUsage?.input,
            originalInput,
            "the run's usage must not be reached through the snapshot",
        );
        assert.equal(second?.policyVersion, originalPolicy);
        const details = (
            result.details as {
                luneCompaction: { summaryModel: { id: string }; policyVersion: string };
            }
        ).luneCompaction;
        assert.equal(
            details.summaryModel.id,
            originalModelId,
            "the checkpoint metadata must not be reached through the snapshot",
        );
        assert.equal(details.policyVersion, originalPolicy);
    } finally {
        host.dispose();
    }
});

const GOAL = "PLEASE_REVIEW_REPORTS";
const RESULT_ONE_BODY = "R1BODY ".repeat(120);
const RESULT_TWO_BODY = "R2BODY ".repeat(120);

/** Two read calls plus surrounding history, arranged so both reads fall inside the summarized region. */
function readHistory(): AgentMessage[] {
    return [
        user(GOAL.padEnd(400, "x")),
        assistantText("a1".padEnd(400, "y")),
        assistantToolCall("r1", "read", { path: "docs/one.md" }),
        toolResult("r1", "read", RESULT_ONE_BODY),
        assistantToolCall("r2", "read", { path: "docs/two.md" }),
        toolResult("r2", "read", RESULT_TWO_BODY),
        user("u2".padEnd(640, "z")),
        assistantText("a2".padEnd(40, "w")),
    ];
}

const JEV_POLICY: CompactionPolicy = policy({
    deletableTools: ["read"],
});

function jevOptions(): JevOptions {
    return {
        enabled: true,
        model: { provider: "registry-jev", id: "jev-latest" },
        concurrency: 2,
    };
}

test("controller.getRun() isolates Jev decisions and usage: mutating the snapshot cannot reach the run or the committed checkpoint", async () => {
    // Nested Jev decisions and usage need the same isolation as the controller's top-level run snapshot.
    const host = await startJevHost({
        messages: readHistory(),
        jev: jevOptions,
        policy: JEV_POLICY,
    });
    try {
        host.simulator.setResponder((pending) => {
            pending.respond(systemOneAnswers(pending.request, 1));
        });
        host.faux.setResponses([fauxAssistantMessage("## Goal\njev snapshot summary")]);
        await host.session.compact();

        const first = host.controller.getRun();
        assert.ok(first, "a completed run must be observable");
        assert.equal(first.stage, "complete");
        assert.ok(first.jev, "a Jev run must expose its decision report");
        assert.ok(first.jev.chunkDecisions.length > 0, "the report must contain chunk decisions");

        const firstDecision = first.jev.chunkDecisions[0]!;
        const originalAction = firstDecision.action;
        assert.ok(
            "probability" in firstDecision,
            "a classified decision must retain its probability",
        );
        const originalProbability = firstDecision.probability;
        const originalRemoved = first.jev.chunkDecisions.filter(
            (decision) => decision.action === "drop",
        ).length;
        const originalUsageCount = first.jev.usage.length;
        const originalSummaryInput = first.summaryUsage?.input;

        // Mutate nested decision/usage data through the returned snapshot.
        (firstDecision as { action: string }).action = "keep";
        (firstDecision as { probability: number }).probability = Number.NaN;
        (first.jev.usage as unknown as unknown[]).length = 0;
        (first.summaryUsage as { input: number }).input = Number.NaN;

        const second = host.controller.getRun();
        assert.equal(
            second?.jev?.chunkDecisions[0]?.action,
            originalAction,
            "the run's decision must not be reached through the snapshot",
        );
        const secondDecision = second?.jev?.chunkDecisions[0];
        assert.ok(secondDecision && "probability" in secondDecision);
        assert.equal(
            secondDecision.probability,
            originalProbability,
            "the run's probability must not become NaN",
        );
        assert.equal(
            second?.jev?.chunkDecisions.filter((decision) => decision.action === "drop").length,
            originalRemoved,
        );
        assert.equal(
            second?.jev?.usage.length,
            originalUsageCount,
            "the run's usage records must remain intact",
        );
        assert.equal(second?.summaryUsage?.input, originalSummaryInput);

        const entry = host.sessionManager
            .getEntries()
            .find((candidate) => candidate.type === "compaction");
        const details = (
            entry as
                | {
                      details?: {
                          luneCompaction?: {
                              jev?: { removedChunks?: number; usage?: readonly unknown[] };
                          };
                      };
                  }
                | undefined
        )?.details?.luneCompaction;
        assert.equal(
            details?.jev?.removedChunks,
            originalRemoved,
            "the committed checkpoint metadata must be unchanged",
        );
        assert.equal(details?.jev?.usage?.length, originalUsageCount);
    } finally {
        await host.dispose();
    }
});
