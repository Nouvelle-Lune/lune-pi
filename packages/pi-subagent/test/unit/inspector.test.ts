import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { detailRows } from "../../src/inspector/details.ts";
import { TranscriptRenderer, toolSummary } from "../../src/inspector/transcript.ts";
import { markUserMessage } from "../../src/run/guide.ts";
import { Run } from "../../src/run/run.ts";
import {
    assistantMessage,
    fakeTheme,
    restoredRun,
    runHost,
    tempAgentDir,
    turn,
    userMessage,
} from "./support.ts";

const RENDERER_KEY = Symbol.for("@lune_99/pi-core-theme/renderer/v1");
const globals = globalThis as Record<symbol, unknown>;

afterEach(() => {
    delete globals[RENDERER_KEY];
});

function conversation(): AgentMessage[] {
    return [
        userMessage("Review the diff."),
        {
            ...(assistantMessage("Looking now.") as object),
            content: [
                { type: "text", text: "Looking now." },
                { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/a.ts" } },
            ],
        } as unknown as AgentMessage,
        {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "read",
            content: [{ type: "text", text: "FILE BODY" }],
            isError: false,
            timestamp: 3,
        } as unknown as AgentMessage,
        {
            ...(assistantMessage("") as object),
            content: [
                {
                    type: "toolCall",
                    id: "t2",
                    name: "report",
                    arguments: { status: "done", summary: "Looks fine." },
                },
            ],
        } as unknown as AgentMessage,
    ];
}

test("the transcript shows the task, assistant text, tool calls without their output and the report", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", { messages: conversation(), turns: [turn()] });

    const text = new TranscriptRenderer(fakeTheme()).render(run, 80).join("\n");

    assert.match(text, /Review the diff\./);
    assert.match(text, /Looking now\./);
    assert.match(text, /read src\/a\.ts/);
    assert.doesNotMatch(text, /FILE BODY/);
    assert.match(text, /Looks fine\./);
});

test("a message the user wrote through the inspector is shown without its marker", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", {
        messages: [userMessage(markUserMessage("Please also check b.ts."))],
    });

    const text = new TranscriptRenderer(fakeTheme()).render(run, 80).join("\n");

    assert.match(text, /Please also check b\.ts\./);
    assert.doesNotMatch(text, /\[From the user\]/);
});

test("with Core Theme published the transcript still draws plain rows and never asks for a card", (t) => {
    let calls = 0;

    globals[RENDERER_KEY] = {
        version: 1,
        renderActivity: () => {
            calls += 1;

            return { render: () => ["CARD"], invalidate() {} };
        },
    };

    const run = restoredRun(tempAgentDir(t), "r1", { messages: conversation(), turns: [turn()] });

    const rows = new TranscriptRenderer(fakeTheme()).render(run, 80);

    assert.equal(calls, 0);
    assert.ok(rows.includes("● read src/a.ts"), rows.join("\n"));
    assert.ok(!rows.includes("CARD"));
    assert.match(rows.join("\n"), /Looks fine\./);
});

test("toolSummary prefers command, path or pattern and clips long values", () => {
    const call = (args: Record<string, unknown>) =>
        ({ type: "toolCall", id: "x", name: "n", arguments: args }) as never;

    assert.equal(toolSummary(call({ command: "ls -la", path: "p" })), "ls -la");
    assert.equal(toolSummary(call({ pattern: "TODO" })), "TODO");
    assert.equal(toolSummary(call({ other: 1 })), '{"other":1}');
    assert.equal(toolSummary(call({ command: "x".repeat(200) })).length, 80);
});

test("the details view shows start values, workspace, usage and the task", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", {
        snapshot: {
            definition: { name: "reviewer", body: "Be strict.", file: "/d/reviewer.md" },
            isolation: "worktree",
            worktree: { repoRoot: "/repo", path: "/wt", baseCommit: "abc123" },
            task: "Review it.",
        },
        messages: [assistantMessage("x", { input: 2000, output: 100, cost: 0.25 })],
        turns: [turn({ state: "failed", error: "boom", stoppedBy: "user" })],
    });

    const text = detailRows(run, fakeTheme(), 100).join("\n");

    assert.match(text, /r1 \(r1\) · failed/);
    assert.match(text, /Worktree: \/wt\nBase commit: abc123/);
    assert.match(text, /Input 2\.0k · output 100/);
    assert.match(text, /Total 2\.1k tokens · \$0\.250/);
    assert.match(text, /Not included in the main session's totals\./);
    assert.match(text, /failed · unreported · 4\.2s/);
    assert.match(text, /Stopped by: user/);
    assert.match(text, /Error: boom/);
    assert.match(text, /Definition body\nBe strict\./);
    assert.match(text, /Task\nReview it\./);
});

test("the details view of an unreadable run stops after the load error", (t) => {
    const agentDir = tempAgentDir(t);
    const run = Run.restore(
        {
            id: "gone",
            file: `${agentDir}/missing.jsonl`,
            spawnEntryId: "s",
            parentSessionId: "p",
            readOnly: true,
        },
        runHost(agentDir),
    );

    const text = detailRows(run, fakeTheme(), 100).join("\n");

    assert.match(text, /Inherited from session p through \/fork or \/clone\./);
    assert.match(text, /The run file could not be read: The run file is missing/);
    assert.doesNotMatch(text, /Usage/);
});
