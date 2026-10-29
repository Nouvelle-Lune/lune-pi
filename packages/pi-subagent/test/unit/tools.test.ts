import assert from "node:assert/strict";
import { test } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { ToolCatalog } from "../../src/catalog.ts";
import { SUBAGENT_TOOL_NAMES, createSubagentTools } from "../../src/tools/subagent-tools.ts";
import {
    formatDuration,
    formatPercent,
    ratingText,
    riskText,
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
    options: { definitions?: string[]; models?: string[]; autoOnly?: boolean } = {},
) {
    const session = parentSession(t, tempAgentDir(t));
    const tools = createSubagentTools({
        manager: session.manager(),
        definitions: (options.definitions ?? []).map((name) => definition(name)),
        models: options.models ?? [],
        autoOnly: options.autoOnly ?? false,
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

    assert.deepEqual(withModels["model"]!.enum, ["auto", "a/one", "b/two"]);
    assert.equal("model" in without, false);
});

test("with Auto mode only the start schema has no model, at the top level or in tasks", (t) => {
    const models = ["a/one", "b/two"];
    const on = toolsFor(t, { models, autoOnly: true }).byName("subagent_start");
    const off = toolsFor(t, { models, autoOnly: false }).byName("subagent_start");
    const entry = (tool: { parameters: unknown }) =>
        (
            tool.parameters as {
                properties: { tasks: { items: { properties: Record<string, unknown> } } };
            }
        ).properties.tasks.items.properties;

    assert.equal("model" in properties(on), false);
    assert.equal("model" in entry(on), false);
    assert.equal("model" in properties(off), true);
    assert.equal("model" in entry(off), true);
});

test("with Auto mode only the descriptions name only thinking, tools and isolation as inline settings", (t) => {
    const definitions = ["reviewer"];
    const on = toolsFor(t, { definitions, autoOnly: true }).byName("subagent_start");
    const off = toolsFor(t, { definitions, autoOnly: false }).byName("subagent_start");

    assert.match(on.description, /sets thinking, tools and isolation in the call/);
    assert.match(off.description, /sets model, thinking, tools and isolation in the call/);
    assert.match(
        properties(on)["agent"]!.description,
        /set thinking, tools and isolation in this call/,
    );
    assert.match(
        (on.parameters as { properties: { tasks: { description: string } } }).properties.tasks
            .description,
        /^Independent runs started together instead of task\. Set title, agent, thinking, tools and isolation per entry/,
    );
});

test("thinking and isolation are fixed enums and no top-level parameter is required", (t) => {
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
    assert.equal(schema.required, undefined);
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
        autoOnly: false,
        catalog,
    });
    const status = tools.find((tool) => tool.name === "subagent_status") as unknown as ToolShape;

    const result = await status.execute("c", {});

    assert.match(result.content[0]!.text, /^Run r1: idle/m);
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

test("formatPercent shows a share from 0 to 1 as a rounded whole percentage", () => {
    assert.equal(formatPercent(0.82), "82%");
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatPercent(1), "100%");
    assert.equal(formatPercent(0.124), "12%");
    assert.equal(formatPercent(0.126), "13%");
    assert.equal(formatPercent(0.004), "0%");
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

test("the model and thinking lines of an auto run say who chose them and what that was based on", (t) => {
    const agentDir = tempAgentDir(t);
    const sources = (model: "call" | "definition", thinking: "auto" | "parent" | "call") => ({
        model,
        thinking,
        tools: "settings" as const,
        isolation: "default" as const,
    });
    const thinking = {
        rated: "high" as const,
        used: "high" as const,
        confidence: 0.9,
        probabilities: { high: 0.64 },
    };
    const rating = (tier: object, modelFrom: string) => ({
        by: "rating",
        classifier: "c/j",
        tier,
        modelFrom,
        thinking,
    });
    const cases: Array<[string, Partial<ReturnType<typeof snapshot>>, string, string]> = [
        [
            "rating",
            {
                model: "p/x",
                thinking: "high",
                sources: sources("call", "auto"),
                autoModel: rating(
                    {
                        rated: "complex",
                        used: "complex",
                        confidence: 0.8,
                        probabilities: { complex: 0.71 },
                    },
                    "complex",
                ) as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task complex (71%); the complex tier's model)",
            "Thinking: high (auto: the classifier rated the thinking high (64%))",
        ],
        [
            "unsure",
            {
                model: "p/x",
                thinking: "high",
                sources: sources("call", "auto"),
                autoModel: rating(
                    {
                        rated: "light",
                        used: "standard",
                        confidence: 0.4,
                        probabilities: { light: 0.4 },
                    },
                    "standard",
                ) as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task light (40%), unsure at 40% confidence, so standard; the standard tier's model)",
            "Thinking: high (auto: the classifier rated the thinking high (64%))",
        ],
        [
            "higher tier",
            {
                model: "p/x",
                thinking: "high",
                sources: sources("definition", "auto"),
                autoModel: rating(
                    { rated: "light", used: "light", confidence: 0.9, probabilities: {} },
                    "deep",
                ) as never,
            },
            "Model: p/x (auto from definition: the classifier c/j rated the task light; the light tier has no model, so the deep tier's model)",
            "Thinking: high (auto: the classifier rated the thinking high (64%))",
        ],
        [
            "main",
            {
                model: "p/x",
                thinking: "low",
                sources: sources("call", "call"),
                autoModel: rating(
                    { rated: "deep", used: "deep", confidence: 0.9, probabilities: { deep: 0.9 } },
                    "main",
                ) as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task deep (90%); no tier from deep up has a model, so the main agent's model)",
            "Thinking: low (from call)",
        ],
        [
            "high risk with a floor",
            {
                model: "p/x",
                thinking: "low",
                sources: sources("call", "parent"),
                autoModel: {
                    by: "rating",
                    classifier: "c/j",
                    tier: { rated: "light", used: "light", confidence: 0.9, probabilities: {} },
                    modelFrom: "deep",
                    risk: { probability: 0.72, threshold: 0.4, high: true, floor: "deep" },
                } as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task light, high risk (72%), so at least the deep tier; the deep tier's model)",
            "Thinking: low (from parent)",
        ],
        [
            "high risk without a floor",
            {
                model: "p/x",
                thinking: "low",
                sources: sources("call", "parent"),
                autoModel: {
                    by: "rating",
                    classifier: "c/j",
                    tier: { rated: "deep", used: "deep", confidence: 0.9, probabilities: {} },
                    modelFrom: "deep",
                    risk: { probability: 0.9, threshold: 0.4, high: true },
                } as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task deep, high risk (90%); the deep tier's model)",
            "Thinking: low (from parent)",
        ],
        [
            "not high risk",
            {
                model: "p/x",
                thinking: "low",
                sources: sources("call", "parent"),
                autoModel: {
                    by: "rating",
                    classifier: "c/j",
                    tier: { rated: "light", used: "light", confidence: 0.9, probabilities: {} },
                    modelFrom: "light",
                    risk: { probability: 0.12, threshold: 0.4, high: false },
                } as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task light, not high risk (12%); the light tier's model)",
            "Thinking: low (from parent)",
        ],
        [
            "floor tier without a model goes to main",
            {
                model: "p/x",
                thinking: "low",
                sources: sources("call", "parent"),
                autoModel: {
                    by: "rating",
                    classifier: "c/j",
                    tier: { rated: "light", used: "light", confidence: 0.9, probabilities: {} },
                    modelFrom: "main",
                    risk: { probability: 0.72, threshold: 0.4, high: true, floor: "deep" },
                } as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task light, high risk (72%), so at least the deep tier; no tier from deep up has a model, so the main agent's model)",
            "Thinking: low (from parent)",
        ],
        [
            "rating without a thinking rating",
            {
                model: "p/x",
                thinking: "low",
                sources: sources("call", "parent"),
                autoModel: {
                    by: "rating",
                    classifier: "c/j",
                    tier: { rated: "light", used: "light", confidence: 0.9, probabilities: {} },
                    modelFrom: "light",
                } as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task light; the light tier's model)",
            "Thinking: low (from parent)",
        ],
        [
            "run saved with the earlier reasoning rating",
            {
                model: "p/x",
                thinking: "high",
                sources: sources("call", "auto"),
                autoModel: {
                    by: "rating",
                    classifier: "c/j",
                    tier: { rated: "light", used: "light", confidence: 0.9, probabilities: {} },
                    modelFrom: "light",
                    reasoning: {
                        rated: "heavy",
                        used: "heavy",
                        confidence: 0.9,
                        probabilities: {},
                    },
                } as never,
            },
            "Model: p/x (auto from call: the classifier c/j rated the task light; the light tier's model)",
            "Thinking: high (from auto)",
        ],
        [
            "no classifier",
            {
                model: "p/x",
                sources: sources("call", "parent"),
                autoModel: { by: "no-classifier" },
            },
            "Model: p/x (auto from call: no classifier is selected, so the main agent's model)",
            "Thinking: off (from parent)",
        ],
        [
            "nothing to rate",
            {
                model: "p/x",
                sources: sources("call", "call"),
                autoModel: { by: "nothing-to-rate" },
            },
            "Model: p/x (auto from call: no auto tier has a model and the thinking is set, so the main agent's model)",
            "Thinking: off (from call)",
        ],
        [
            "classifier failed",
            {
                model: "p/x",
                sources: sources("call", "parent"),
                autoModel: {
                    by: "classifier-failed",
                    classifier: "c/j",
                    error: "The auto classifier c/j is unavailable.",
                },
            },
            "Model: p/x (auto from call: the main agent's model. The auto classifier c/j is unavailable.)",
            "Thinking: off (from parent)",
        ],
        [
            "older run shape",
            {
                model: "p/x",
                sources: sources("call", "parent"),
                autoModel: { by: "classifier", classifier: "c/j", confidence: 0.8 } as never,
            },
            "Model: p/x (auto from call)",
            "Thinking: off (from parent)",
        ],
        [
            "explicit",
            { model: "p/x", sources: sources("call", "parent") },
            "Model: p/x (from call)",
            "Thinking: off (from parent)",
        ],
    ];

    for (const [id, overrides, expectedModel, expectedThinking] of cases) {
        const actual = startValueLines(restoredRun(agentDir, id, { snapshot: overrides }));

        assert.deepEqual([id, actual[1], actual[2]], [id, expectedModel, expectedThinking]);
    }
});

test("riskText names the probability, and the floor when it raised the tier", () => {
    assert.equal(
        riskText({ probability: 0.72, threshold: 0.4, high: true, floor: "deep" }),
        "high risk (72%), so at least the deep tier",
    );
    assert.equal(riskText({ probability: 0.72, threshold: 0.4, high: true }), "high risk (72%)");
    assert.equal(
        riskText({ probability: 0.12, threshold: 0.4, high: false }),
        "not high risk (12%)",
    );
});

test("ratingText shows the rated level with its share, and the level used when the classifier was unsure", () => {
    const share = {
        rated: "complex",
        used: "complex",
        confidence: 0.8,
        probabilities: { complex: 0.71 },
    };

    assert.equal(ratingText(share), "complex (71%)");
    assert.equal(ratingText({ ...share, probabilities: {} }), "complex");
    assert.equal(
        ratingText({ ...share, used: "deep", confidence: 0.42 }),
        "complex (71%), unsure at 42% confidence, so deep",
    );
});

test("formatStarted reports the run ID, start values and that a message arrives later", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1");

    const text = formatStarted(run);

    assert.match(text, /^Started run r1: idle\.\nAgent: inline/);
    assert.match(text, /A message arrives when its turn ends\.$/);
});

test("a run's title follows its ID in the started, status and list text", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", { snapshot: { title: "Review the diff" } });

    const started = formatStarted(run);
    const status = formatRunStatus(run);
    const list = formatRunList([run], 0);

    assert.match(started, /^Started run r1: idle\.\nTitle: Review the diff\nAgent: inline\n/);
    assert.match(status, /^Run r1: idle\nTitle: Review the diff\nAgent: inline\n/);
    assert.match(list, /^Run r1: idle\nTitle: Review the diff\nAgent: inline\n/);
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
        "Run r1: idle\nThe run file could not be read: The run file is missing: /x",
    );
    assert.equal(snapshot("x").runId, "x");
});

test("formatRunStatus gives each earlier report in full; formatRunList only a line per report", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", {
        turns: [
            turn({
                earlierReports: [
                    {
                        status: "blocked",
                        summary: "First try summary.",
                        reason: "No key.",
                    },
                    { status: "needs_input", summary: "Second try summary.", question: "Which?" },
                ],
                report: { status: "done", summary: "Final summary." },
            }),
        ],
    });

    const status = formatRunStatus(run);
    const list = formatRunList([run], 0);

    assert.match(
        status,
        /Earlier report in that turn, replaced by a later one: blocked\nReason: No key\.\nSummary:\nFirst try summary\.\n/,
    );
    assert.match(
        status,
        /Earlier report in that turn, replaced by a later one: needs_input\nQuestion: Which\?\nSummary:\nSecond try summary\./,
    );
    assert.ok(status.indexOf("First try summary.") < status.indexOf("Report: done"));
    assert.match(status, /Report: done\nSummary:\nFinal summary\./);
    assert.match(list, /Earlier report in that turn, replaced by a later one: blocked/);
    assert.match(list, /Earlier report in that turn, replaced by a later one: needs_input/);
    assert.doesNotMatch(list, /First try summary|No key|Which\?|Second try summary/);
    assert.match(list, /Final summary\./);
});

test("a turn with one report shows no earlier report line", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", {
        turns: [turn({ report: { status: "done", summary: "Only." } })],
    });

    assert.doesNotMatch(formatRunStatus(run), /Earlier report/);
    assert.doesNotMatch(formatRunList([run], 0), /Earlier report/);
});

test("the start properties follow the order agent, title, task, model, thinking, tools, isolation, then tasks", (t) => {
    const tool = toolsFor(t, { definitions: ["reviewer"], models: ["a/one"] }).byName(
        "subagent_start",
    );
    const schema = tool.parameters as {
        properties: Record<string, { items?: { properties: Record<string, unknown> } }>;
    };
    const order = ["agent", "title", "task", "model", "thinking", "tools", "isolation"];

    assert.deepEqual(Object.keys(schema.properties), [...order, "tasks"]);
    assert.deepEqual(Object.keys(schema.properties["tasks"]!.items!.properties), order);
});

test("with definitions, the model, thinking, tools and isolation descriptions start with Only without agent", (t) => {
    const prefix = "Only without agent. ";
    const withDefinitions = properties(
        toolsFor(t, { definitions: ["reviewer"], models: ["a/one"] }).byName("subagent_start"),
    );
    const entry = (
        toolsFor(t, { definitions: ["reviewer"], models: ["a/one"] }).byName("subagent_start")
            .parameters as {
            properties: {
                tasks: { items: { properties: Record<string, { description: string }> } };
            };
        }
    ).properties.tasks.items.properties;

    for (const field of ["model", "thinking", "tools", "isolation"]) {
        assert.ok(withDefinitions[field]!.description.startsWith(prefix), field);
        assert.ok(entry[field]!.description.startsWith(prefix), `tasks entry ${field}`);
    }
});

test("without definitions, the settings descriptions carry no Only without agent prefix", (t) => {
    const without = properties(toolsFor(t, { models: ["a/one"] }).byName("subagent_start"));

    for (const field of ["model", "thinking", "tools", "isolation"]) {
        assert.doesNotMatch(without[field]!.description, /Only without agent/, field);
    }
});
