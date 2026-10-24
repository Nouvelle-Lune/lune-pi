import assert from "node:assert/strict";
import { test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { ToolCatalog } from "../../src/catalog.ts";
import { SUBAGENT_TOOL_NAMES, createSubagentTools } from "../../src/tools/subagent-tools.ts";
import {
    formatDuration,
    formatRunList,
    formatRunStatus,
    formatStarted,
    formatTokens,
    formatUsage,
    startValueLines,
    workspaceLines,
} from "../../src/tools/format.ts";
import {
    definition,
    fakeTheme,
    parentSession,
    restoredRun,
    snapshot,
    tempAgentDir,
    turn,
    userMessage,
    assistantMessage,
} from "./support.ts";

const catalog: ToolCatalog = {
    tools: [
        { name: "read", description: "Read a file. It supports images.", source: "native" },
        { name: "bash", description: "Run a shell command", source: "native" },
        { name: "report", description: "Report.", source: "native" },
        { name: "mcp", description: "x".repeat(300), source: "builtin" },
    ],
    errors: [],
};

function toolsFor(
    t: Parameters<typeof parentSession>[0],
    options: { definitions?: string[]; models?: string[] } = {},
) {
    const session = parentSession(t, tempAgentDir(t));
    const tools = createSubagentTools({
        manager: session.manager(),
        definitions: (options.definitions ?? []).map((name) => definition(name)),
        models: options.models ?? [],
        catalog,
    });

    return { session, tools, byName: (name: string) => tools.find((tool) => tool.name === name)! };
}

interface ToolShape {
    renderCall(args: unknown, theme: Theme, context: unknown): Component;
    renderResult(
        result: unknown,
        options: { expanded: boolean },
        theme: Theme,
        context: { isError: boolean },
    ): Component;
    execute(id: string, params: unknown): Promise<{ content: Array<{ text: string }> }>;
}

function properties(tool: {
    parameters: unknown;
}): Record<string, { enum: string[]; description: string }> {
    return (
        tool.parameters as { properties: Record<string, { enum: string[]; description: string }> }
    ).properties;
}

const lines = (component: Component, width = 100) => component.render(width);

test("the four tools are declared by name", (t) => {
    const { tools } = toolsFor(t);

    assert.deepEqual(
        tools.map((tool) => tool.name),
        [...SUBAGENT_TOOL_NAMES],
    );
});

test("the agent enum lists the loaded definitions and is absent when there are none", (t) => {
    const withDefinitions = properties(
        toolsFor(t, { definitions: ["reviewer", "explorer"] }).byName("subagent_start"),
    );
    const without = properties(toolsFor(t).byName("subagent_start"));

    assert.deepEqual(withDefinitions["agent"]!.enum, ["reviewer", "explorer"]);
    assert.equal("agent" in without, false);
});

test("the model enum lists the allowed models and is absent when the list is empty", (t) => {
    const withModels = properties(
        toolsFor(t, { models: ["a/one", "b/two"] }).byName("subagent_start"),
    );
    const without = properties(toolsFor(t).byName("subagent_start"));

    assert.deepEqual(withModels["model"]!.enum, ["a/one", "b/two"]);
    assert.equal("model" in without, false);
});

test("thinking and isolation are fixed enums and task is the only required parameter", (t) => {
    const tool = toolsFor(t).byName("subagent_start");
    const schema = tool.parameters as { required?: string[] };

    assert.deepEqual(properties(tool)["isolation"]!.enum, ["shared", "worktree"]);
    assert.deepEqual(properties(tool)["thinking"]!.enum, [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]);
    assert.deepEqual(schema.required, ["task"]);
});

test("the tools description lists the catalog without report, clips long text and names MCP", (t) => {
    const description: string = properties(toolsFor(t).byName("subagent_start"))["tools"]!
        .description;

    assert.match(description, /^- read: Read a file\.$/m);
    assert.match(description, /^- bash: Run a shell command$/m);
    assert.doesNotMatch(description, /^- report:/m);
    assert.match(description, /^- mcp: x+…$/m);
    assert.match(description, /^- mcp__<server>__<tool>: /m);
    assert.match(description, /always gets report/);
});

test("renderCall shows the tool name and a one-line preview of its arguments", (t) => {
    const theme = fakeTheme();
    const { byName } = toolsFor(t);
    const start = byName("subagent_start") as unknown as ToolShape;
    const status = byName("subagent_status") as unknown as ToolShape;

    const inline = lines(start.renderCall({ task: "Do\n  this thing" }, theme, {}));
    const named = lines(start.renderCall({ agent: "reviewer", task: "Go" }, theme, {}));
    const streaming = lines(start.renderCall({}, theme, {}));
    const all = lines(status.renderCall({}, theme, {}));

    assert.match(inline[0]!, /^subagent_start inline · Do this thing\s*$/);
    assert.match(named[0]!, /^subagent_start reviewer · Go\s*$/);
    assert.match(streaming[0]!, /^subagent_start inline\s*$/);
    assert.match(all[0]!, /^subagent_status all runs\s*$/);
});

test("renderResult shows the first line, or all of it expanded, coloured by error state", (t) => {
    const theme = fakeTheme({ tag: true });
    const status = toolsFor(t).byName("subagent_status") as unknown as ToolShape;
    const result = { content: [{ type: "text", text: "first\nsecond" }] };

    const collapsed = lines(
        status.renderResult(result, { expanded: false }, theme, { isError: false }),
    );
    const expanded = lines(
        status.renderResult(result, { expanded: true }, theme, { isError: true }),
    );

    assert.match(collapsed[0]!, /^<toolOutput:first>/);
    assert.equal(collapsed.length, 1);
    assert.match(expanded.join("\n"), /<error:first/);
    assert.match(expanded.join("\n"), /second/);
});

test("subagent_status and subagent_stop reject an unknown run ID", async (t) => {
    const { byName } = toolsFor(t);

    await assert.rejects(
        (byName("subagent_status") as unknown as ToolShape).execute("c", { runId: "nope" }),
        /No subagent run "nope" on the current branch\. There are no runs here\./,
    );
    await assert.rejects(
        (byName("subagent_stop") as unknown as ToolShape).execute("c", { runId: "nope" }),
        /nope/,
    );
});

test("subagent_status without a runId lists the runs of the branch", async (t) => {
    const session = parentSession(t, tempAgentDir(t));

    session.spawn("r1", { snapshot: { name: "reviewer" }, turns: [turn()] });

    const tools = createSubagentTools({
        manager: session.manager(),
        definitions: [],
        models: [],
        catalog,
    });
    const status = tools.find((tool) => tool.name === "subagent_status") as unknown as ToolShape;

    const result = await status.execute("c", {});

    assert.match(result.content[0]!.text, /Run reviewer \(r1\): idle/);
});

test("formatTokens, formatDuration and formatUsage use compact units", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1500), "1.5k");
    assert.equal(formatTokens(2_500_000), "2.5M");
    assert.equal(formatDuration(4200), "4.2s");
    assert.equal(formatDuration(64_000), "1m 4s");
    assert.equal(formatDuration(3_720_000), "1h 2m");
    assert.equal(
        formatUsage({
            input: 1500,
            output: 20,
            cacheRead: 0,
            cacheWrite: 3,
            total: 0,
            cost: 0.1234,
        }),
        "1.5k input · 20 output · 0 cache read · 3 cache write · $0.123",
    );
});

test("start values name each value with where it came from, and the workspace lists a worktree", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", {
        snapshot: {
            definition: { name: "reviewer", body: "", file: "/d.md" },
            isolation: "worktree",
            cwd: "/wt/sub",
            worktree: { repoRoot: "/repo", path: "/wt", baseCommit: "abc123" },
            tools: ["read", "report"],
        },
    });

    assert.deepEqual(startValueLines(run), [
        "Agent: reviewer",
        "Model: test/model (from parent)",
        "Thinking: off (from parent)",
        "Tools: read, report (from settings)",
    ]);
    assert.deepEqual(workspaceLines(run), [
        "Isolation: worktree",
        "Working directory: /wt/sub",
        "Worktree: /wt",
        "Base commit: abc123",
    ]);
});

test("formatStarted reports the run ID, start values and that a message arrives later", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1");

    const text = formatStarted(run);

    assert.match(text, /^Started run r1 \(r1\): idle\.\nAgent: inline/);
    assert.match(text, /A message arrives when its turn ends\.$/);
});

test("formatRunStatus gives the whole report; formatRunList only a clipped preview", (t) => {
    const summary = `${"word ".repeat(80)}END`;
    const run = restoredRun(tempAgentDir(t), "r1", {
        messages: [
            userMessage("task"),
            assistantMessage("x", { input: 1200, output: 30, cost: 0.5 }),
        ],
        turns: [
            turn({
                report: { status: "blocked", summary, reason: "No access." },
                stoppedBy: "user",
            }),
        ],
    });

    const status = formatRunStatus(run);
    const list = formatRunList([run], 2);

    assert.match(status, /Turns: 1\nUsage: 1\.2k input · 30 output/);
    assert.match(status, /Report: blocked\nReason: No access\.\nSummary:\n/);
    assert.ok(status.includes("END"));
    assert.match(status, /Stopped by: user/);
    assert.match(status, /Task:\nDo the task\./);
    assert.ok(!list.includes("END"));
    assert.match(list, /Summary: word word .*…/);
    assert.match(list, /2 runs belong to other branches and are not listed\./);
    assert.match(list, /Call subagent_status with a runId/);
});

test("an unreported last turn is shown as having no task status", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", {
        turns: [turn({ state: "failed", error: "boom" })],
    });

    const status = formatRunStatus(run);
    const list = formatRunList([run], 0);

    assert.match(status, /Error: boom\nUnreported: the turn ended without a report/);
    assert.match(status, /The run left no message\./);
    assert.match(list, /Last message: none/);
});

test("an empty list says there are no runs here", () => {
    assert.equal(formatRunList([], 0), "No subagent runs on the current branch.");
});

test("a run whose file cannot be read shows the load error and nothing else", (t) => {
    const agentDir = tempAgentDir(t);
    const run = restoredRun(agentDir, "r1");

    run.loadError = "The run file is missing: /x";
    run.snapshot = undefined;

    assert.equal(
        formatRunStatus(run),
        "Run r1 (r1): idle\nThe run file could not be read: The run file is missing: /x",
    );
    assert.equal(snapshot("x").runId, "x");
});
