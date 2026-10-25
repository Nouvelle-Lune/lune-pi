import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { ToolCatalog } from "../../src/catalog.ts";
import type { RunManager, StartParams } from "../../src/run/run-manager.ts";
import type { Run } from "../../src/run/run.ts";
import { formatStarted, formatStartedBatch } from "../../src/tools/format.ts";
import { createSubagentTools } from "../../src/tools/subagent-tools.ts";
import { createGate } from "../harness/wait.ts";
import { definition, fakeTheme, restoredRun, tempAgentDir } from "./support.ts";

const catalog: ToolCatalog = {
    tools: [{ name: "read", description: "Read a file. It supports images.", source: "native" }],
    errors: [],
};

interface StartCall {
    params: StartParams;
    onProgress?: (text: string) => void;
}

interface ToolShape {
    parameters: unknown;
    renderCall(args: unknown, theme: Theme, context: unknown): Component;
    execute(
        id: string,
        params: unknown,
        signal: undefined,
        onUpdate: (update: { content: Array<{ text: string }> }) => void,
        ctx: unknown,
    ): Promise<{ content: Array<{ text: string }> }>;
}

/** A manager whose `start` is scripted per call; real runs are covered by the integration tests. */
function stubbed(t: TestContext, startFor: (call: StartCall, index: number) => Promise<Run>) {
    const agentDir = tempAgentDir(t);
    const calls: StartCall[] = [];
    const manager = {
        start: (
            params: StartParams,
            _ctx: unknown,
            options?: { onProgress?: (t: string) => void },
        ) => {
            const call = { params, onProgress: options?.onProgress };

            calls.push(call);

            return startFor(call, calls.length - 1);
        },
    } as unknown as RunManager;
    const tools = createSubagentTools({
        manager,
        definitions: [definition("reviewer")],
        models: ["a/one"],
        catalog,
    });
    const byName = (name: string) =>
        tools.find((tool) => tool.name === name) as unknown as ToolShape;
    const run = (id: string, name = id) => restoredRun(agentDir, id, { snapshot: { name } });
    const execute = async (params: unknown) => {
        const updates: string[] = [];
        const result = await byName("subagent_start").execute(
            "c",
            params,
            undefined,
            (update) => updates.push(update.content.map((part) => part.text).join("")),
            {},
        );

        return { text: result.content[0]!.text, updates };
    };

    return { calls, byName, run, execute, tools };
}

type Properties = Record<string, { enum?: string[]; description?: string; items?: unknown }>;

const propertiesOf = (tool: ToolShape) =>
    (tool.parameters as { properties: Properties; required?: string[] }).properties;

// Schema

test("subagent_start takes an optional task and an optional tasks array of run entries", (t) => {
    const { byName } = stubbed(t, () => Promise.reject(new Error("unused")));
    const schema = byName("subagent_start").parameters as { required?: string[] };
    const tasks = propertiesOf(byName("subagent_start"))["tasks"]!;
    const entry = tasks.items as { properties: Properties; required: string[] };

    assert.equal(schema.required, undefined);
    assert.deepEqual(entry.required, ["task"]);
    assert.deepEqual(Object.keys(entry.properties).sort(), [
        "agent",
        "isolation",
        "model",
        "task",
        "thinking",
        "tools",
    ]);
    assert.deepEqual(entry.properties["agent"]!.enum, ["reviewer"]);
    assert.deepEqual(entry.properties["model"]!.enum, ["a/one"]);
    assert.deepEqual(entry.properties["isolation"]!.enum, ["shared", "worktree"]);
    assert.ok(entry.properties["thinking"]!.enum!.includes("high"));
});

test("an entry's tools description points to the top-level tools instead of the catalog", (t) => {
    const { byName } = stubbed(t, () => Promise.reject(new Error("unused")));
    const properties = propertiesOf(byName("subagent_start"));
    const entry = (properties["tasks"]!.items as { properties: Properties }).properties;
    const top = properties["tools"]!.description!;
    const nested = entry["tools"]!.description!;

    assert.match(top, /^- read: Read a file\.$/m);
    assert.doesNotMatch(nested, /^- read:/m);
    assert.match(nested, /top-level tools/);
    assert.ok(nested.length < top.length);
});

test("the schemas of the other three tools do not mention tasks", (t) => {
    const { tools } = stubbed(t, () => Promise.reject(new Error("unused")));

    for (const tool of tools.filter((candidate) => candidate.name !== "subagent_start")) {
        assert.doesNotMatch(JSON.stringify(tool.parameters), /tasks/, tool.name);
    }

    const send = propertiesOf(tools.find((tool) => tool.name === "subagent_send") as never);
    const status = propertiesOf(tools.find((tool) => tool.name === "subagent_status") as never);
    const stop = propertiesOf(tools.find((tool) => tool.name === "subagent_stop") as never);

    assert.deepEqual(Object.keys(send).sort(), ["message", "runId"]);
    assert.deepEqual(Object.keys(status), ["runId"]);
    assert.deepEqual(Object.keys(stop), ["runId"]);
});

// Call-level checks

test("a call with neither task nor tasks fails before anything starts", async (t) => {
    const { calls, execute } = stubbed(t, () => Promise.reject(new Error("unused")));

    await assert.rejects(
        execute({}),
        /^Error: Give task for one run, or tasks for several runs\.$/,
    );
    assert.equal(calls.length, 0);
});

test("a call with both task and tasks fails before anything starts", async (t) => {
    const { calls, execute } = stubbed(t, () => Promise.reject(new Error("unused")));

    await assert.rejects(
        execute({ task: "a", tasks: [{ task: "b" }] }),
        /Give task for one run or tasks for several runs, not both\./,
    );
    assert.equal(calls.length, 0);
});

test("tasks with top-level start values names them and starts nothing", async (t) => {
    const { calls, execute } = stubbed(t, () => Promise.reject(new Error("unused")));

    await assert.rejects(
        execute({ tasks: [{ task: "b" }], agent: "reviewer", isolation: "shared" }),
        /With tasks, set agent, isolation in each entry instead of at the top level\./,
    );
    await assert.rejects(
        execute({ tasks: [{ task: "b" }], model: "a/one", thinking: "low", tools: ["read"] }),
        /With tasks, set model, thinking, tools in each entry/,
    );
    assert.equal(calls.length, 0);
});

test("an empty tasks array fails before anything starts", async (t) => {
    const { calls, execute } = stubbed(t, () => Promise.reject(new Error("unused")));

    await assert.rejects(execute({ tasks: [] }), /tasks has no entries\./);
    assert.equal(calls.length, 0);
});

// Execution

test("every entry starts before any of them settles, each with its own values", async (t) => {
    const gate = createGate();
    const { calls, run, execute } = stubbed(t, async (_call, index) => {
        await gate.opened;

        return run(`r${index}`, `run-${index + 1}`);
    });
    const pending = execute({
        tasks: [
            { task: "one", agent: "reviewer" },
            {
                task: "two",
                model: "a/one",
                thinking: "low",
                tools: ["read"],
                isolation: "worktree",
            },
        ],
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.params, {
        task: "one",
        agent: "reviewer",
        model: undefined,
        thinking: undefined,
        tools: undefined,
        isolation: undefined,
    });
    assert.deepEqual(calls[1]!.params, {
        task: "two",
        agent: undefined,
        model: "a/one",
        thinking: "low",
        tools: ["read"],
        isolation: "worktree",
    });

    gate.open();
    await pending;
});

test("a failing entry does not stop the others and the result lists both outcomes", async (t) => {
    const { run, execute } = stubbed(t, async (call) => {
        if (call.params.task === "bad") {
            throw new Error('No subagent definition named "ghost".');
        }

        return run(call.params.task, call.params.task);
    });

    const { text } = await execute({ tasks: [{ task: "a" }, { task: "bad" }, { task: "c" }] });

    assert.equal(text.split("\n\n")[0], "Started 2 of 3 runs: a (a), c (c). Failed: tasks[1].");
    assert.match(text, /^tasks\[0\]: Started run a \(a\): idle\.$/m);
    assert.match(text, /^tasks\[1\] failed: No subagent definition named "ghost"\.$/m);
    assert.match(text, /^tasks\[2\]: Started run c \(c\): idle\.$/m);
});

test("when every entry fails the call throws with the entry blocks", async (t) => {
    const { execute } = stubbed(t, async (call) => {
        throw new Error(`cannot start ${call.params.task}`);
    });

    await assert.rejects(execute({ tasks: [{ task: "a" }, { task: "b" }] }), (error: Error) => {
        assert.ok(error.message.startsWith("No run started; every entry of tasks failed."));
        assert.match(
            error.message,
            /tasks\[0\] failed: cannot start a\n\ntasks\[1\] failed: cannot start b/,
        );

        return true;
    });
});

test("progress starts with the run count and one line per entry, updated as entries settle", async (t) => {
    const gates = [createGate(), createGate()];
    const { calls, run, execute } = stubbed(t, async (_call, index) => {
        await gates[index]!.opened;

        if (index === 1) {
            throw new Error("nope");
        }

        return run("r0", "run-1");
    });
    const pending = execute({ tasks: [{ task: "a" }, { task: "b" }] });

    await new Promise<void>((resolve) => setImmediate(resolve));
    calls[0]!.onProgress?.("Creating the session");
    gates[0]!.open();
    gates[1]!.open();
    const { updates } = await pending;

    assert.ok(updates.every((update) => update.startsWith("Starting 2 runs\n")));
    assert.ok(
        updates.includes("Starting 2 runs\ntasks[0]: Creating the session\ntasks[1]: Starting"),
    );
    assert.equal(
        updates.at(-1),
        "Starting 2 runs\ntasks[0]: Started run run-1 (r0)\ntasks[1]: Failed",
    );
});

test("progress for a single entry says run in the singular", async (t) => {
    const { run, execute } = stubbed(t, async () => run("r0"));

    const { updates } = await execute({ tasks: [{ task: "a" }] });

    assert.ok(updates.length > 0);
    assert.ok(updates.every((update) => update.startsWith("Starting 1 run\n")));
});

test("a single task is passed to the manager as before and reported with formatStarted", async (t) => {
    const { calls, run, execute } = stubbed(t, async () => started);
    const started = run("r1");

    const { text } = await execute({ task: "solo", agent: "reviewer" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.params.task, "solo");
    assert.equal(calls[0]!.params.agent, "reviewer");
    assert.equal(text, formatStarted(started));
});

// renderCall

test("renderCall with tasks shows the run count and one line per entry", (t) => {
    const { byName } = stubbed(t, () => Promise.reject(new Error("unused")));
    const start = byName("subagent_start");

    const many = start
        .renderCall(
            { tasks: [{ task: "Do\n this", agent: "reviewer" }, { task: "Other" }] },
            fakeTheme(),
            {},
        )
        .render(100);
    const one = start.renderCall({ tasks: [{ task: "Solo" }] }, fakeTheme(), {}).render(100);

    assert.match(many[0]!, /^subagent_start 2 runs\s*$/);
    assert.match(many[1]!, /^ {2}reviewer · Do this\s*$/);
    assert.match(many[2]!, /^ {2}inline · Other\s*$/);
    assert.match(one[0]!, /^subagent_start 1 run\s*$/);
});

test("renderCall tolerates tasks that are still streaming", (t) => {
    const { byName } = stubbed(t, () => Promise.reject(new Error("unused")));
    const start = byName("subagent_start");

    const lines = start
        .renderCall({ tasks: [null, "text", {}, { task: "Go" }, { agent: 4 }] }, fakeTheme(), {})
        .render(100);

    assert.match(lines[0]!, /^subagent_start 5 runs\s*$/);
    assert.match(lines[4]!, /^ {2}inline · Go\s*$/);
    assert.equal(lines.length, 6);
    assert.match(start.renderCall({ tasks: [] }, fakeTheme(), {}).render(100)[0]!, /0 runs/);
});

// formatStartedBatch

test("formatStartedBatch with every entry started summarizes, details each and closes in the plural", (t) => {
    const agentDir = tempAgentDir(t);
    const runs = ["a", "b", "c"].map((id) =>
        restoredRun(agentDir, id, { snapshot: { name: `n-${id}` } }),
    );

    const text = formatStartedBatch(runs.map((run) => ({ run })));
    const blocks = text.split("\n\n");

    assert.equal(blocks[0], "Started 3 runs: n-a (a), n-b (b), n-c (c).");
    assert.match(blocks[1]!, /^tasks\[0\]: Started run n-a \(a\): idle\.\nAgent: inline\n/);
    assert.match(blocks[3]!, /^tasks\[2\]: Started run n-c \(c\): idle\./);
    assert.equal(
        blocks.at(-1),
        "The runs work in the background. A message arrives when each run's turn ends.",
    );
});

test("formatStartedBatch with a failure names the failed indices and keeps the singular closing", (t) => {
    const agentDir = tempAgentDir(t);
    const run = restoredRun(agentDir, "b", { snapshot: { name: "n-b" } });

    const text = formatStartedBatch([{ error: "Bad agent." }, { run }]);
    const blocks = text.split("\n\n");

    assert.equal(blocks[0], "Started 1 of 2 runs: n-b (b). Failed: tasks[0].");
    assert.equal(blocks[1], "tasks[0] failed: Bad agent.");
    assert.match(blocks[2]!, /^tasks\[1\]: Started run n-b \(b\): idle\./);
    assert.equal(
        blocks.at(-1),
        "The run works in the background. A message arrives when its turn ends.",
    );
});
