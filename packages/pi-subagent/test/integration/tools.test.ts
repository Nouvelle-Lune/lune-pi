import assert from "node:assert/strict";
import { test } from "node:test";

import { fauxToolCall, validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { loadToolCatalog } from "../../src/catalog.ts";
import { createSubagentTools } from "../../src/tools/subagent-tools.ts";
import {
    createFixture,
    definition,
    reportResponse,
    startGated,
    waitForTurns,
    type Fixture,
} from "../harness/fixture.ts";

async function setup(fx: Fixture, definitions = [definition({ name: "reviewer" })]) {
    const manager = fx.createManager(definitions);
    const tools = createSubagentTools({
        manager,
        definitions,
        models: ["faux/faux-1", "faux/faux-2"],
        autoOnly: false,
        catalog: await loadToolCatalog(fx.cwd, fx.agentDir),
    });
    const call = async (name: string, params: Parameters<typeof fauxToolCall>[1]) => {
        const tool = tools.find((candidate) => candidate.name === name) as ToolDefinition;
        const updates: string[] = [];

        // Pi validates a call with the SDK before it reaches the tool, then passes the result on.
        const args = validateToolArguments(tool as unknown as Tool, fauxToolCall(name, params));
        const result = await tool.execute(
            "call-1",
            args,
            undefined,
            (update) => {
                updates.push(
                    update.content.map((part) => ("text" in part ? part.text : "")).join(""),
                );
            },
            fx.ctx as ExtensionToolContext,
        );

        return {
            text: result.content.map((part) => ("text" in part ? part.text : "")).join(""),
            updates,
        };
    };

    return { manager, tools, call };
}

test("the four tools drive a run from start to report, steering and status", async (t) => {
    const fx = await createFixture(t);
    const { manager, tools, call } = await setup(fx);

    assert.deepEqual(
        tools.map((tool) => tool.name),
        ["subagent_start", "subagent_send", "subagent_status", "subagent_stop"],
    );

    fx.faux.setResponses([reportResponse("needs_input", "Stuck.", { question: "Which file?" })]);
    const started = await call("subagent_start", {
        task: "Review a.ts",
        title: "Review a.ts",
        agent: "reviewer",
    });
    const [run] = manager.branchRuns();

    assert.ok(run);
    assert.match(
        started.text,
        new RegExp(
            `^Started run ${run.id}: running\\.\\nTitle: Review a\\.ts\\nAgent: reviewer$`,
            "m",
        ),
    );
    assert.match(started.text, /Isolation: shared/);
    assert.ok(started.updates.length > 0, "start reported no progress");

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    const status = await call("subagent_status", { runId: run.id });

    assert.match(status.text, /Question: Which file\?/);

    fx.faux.setResponses([reportResponse("done", "answered")]);
    const sent = await call("subagent_send", { runId: run.id, message: "a.ts" });
    await waitForTurns(manager, run, 2);

    assert.match(
        sent.text,
        new RegExp(
            `^Run ${run.id} started a new turn with your message\\. A message arrives when ` +
                `the turn ends\\.$`,
            "m",
        ),
    );

    const list = await call("subagent_status", {});

    assert.match(list.text, new RegExp(run.id));
    assert.match(list.text, /answered/);
});

test("subagent_stop interrupts a running run and says so; a second stop reports its state", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);
    const { run } = await startGated(fx, manager, { task: "slow" });

    const stopped = await call("subagent_stop", { runId: run.id });
    const again = await call("subagent_stop", { runId: run.id });

    assert.match(stopped.text, new RegExp(`^Stopped run ${run.id}\\.$`, "m"));
    assert.equal(run.state, "interrupted");
    assert.match(
        again.text,
        new RegExp(`^Run ${run.id} is not running; its state is interrupted\\.$`, "m"),
    );
});

test("subagent_send steers a running run and tells the main agent so", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);
    const { run, gate } = await startGated(fx, manager, { task: "slow" });

    fx.faux.appendResponses([reportResponse("done", "ok")]);
    const sent = await call("subagent_send", { runId: run.id, message: "also B" });

    assert.match(
        sent.text,
        new RegExp(`^Run ${run.id} is running; your message steers its current turn\\.$`, "m"),
    );

    gate.open();
    await waitForTurns(manager, run, 1);
});

test("the tools only reach runs of the current branch", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);
    const base = fx.parent.appendMessage({ role: "user", content: "hi", timestamp: 1 });

    fx.faux.setResponses([reportResponse("done", "ok")]);
    await call("subagent_start", { task: "work" });
    const [away] = manager.branchRuns();

    await waitForTurns(manager, away!, 1);
    fx.parent.branch(base);

    for (const [name, params] of [
        ["subagent_status", { runId: away!.id }],
        ["subagent_send", { runId: away!.id, message: "hi" }],
        ["subagent_stop", { runId: away!.id }],
    ] as const) {
        await assert.rejects(call(name, params), /on the current branch/);
    }

    const list = await call("subagent_status", {});

    assert.match(list.text, /No subagent runs on the current branch\./);
    assert.match(list.text, /1 run belongs to other branches/);
});

test("the subagent_start schema offers agent only when definitions are loaded, and fixed enums for the rest", async (t) => {
    const fx = await createFixture(t);
    const withAgents = await setup(fx, [definition({ name: "a" }), definition({ name: "b" })]);
    const without = await setup(fx, []);
    const schemaOf = (tools: ToolDefinition[]) =>
        (
            tools.find((tool) => tool.name === "subagent_start")!.parameters as unknown as {
                properties: Record<string, { enum?: string[] }>;
            }
        ).properties;
    const withProps = schemaOf(withAgents.tools);
    const withoutProps = schemaOf(without.tools);

    assert.deepEqual(withProps["agent"]?.enum, ["a", "b"]);
    assert.equal(withoutProps["agent"], undefined);
    assert.deepEqual(withProps["model"]?.enum, ["auto", "faux/faux-1", "faux/faux-2"]);
    assert.deepEqual(withoutProps["isolation"]?.enum, ["shared", "worktree"]);
});

test("a start carrying the removed tasks parameter fails validation and starts nothing", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);

    await assert.rejects(
        call("subagent_start", { task: "a", tasks: [{ task: "b" }] }),
        (error: Error) => {
            assert.match(error.message, /^Validation failed for tool "subagent_start":/);
            assert.match(error.message, /tasks/);

            return true;
        },
    );

    assert.equal(manager.branchRuns().length, 0);
});

test("separate concurrent starts each create one run and a failing sibling does not undo them", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);

    fx.faux.setResponses([reportResponse("done", "one"), reportResponse("done", "two")]);
    const outcomes = await Promise.allSettled([
        call("subagent_start", { task: "a", title: "A" }),
        call("subagent_start", { task: "b", tools: ["no_such_tool"] }),
        call("subagent_start", { task: "c", title: "C" }),
    ]);
    const runs = manager.branchRuns();
    const statuses = outcomes.map((outcome) => outcome.status);

    assert.deepEqual(statuses, ["fulfilled", "rejected", "fulfilled"]);
    assert.equal(runs.length, 2);
    const startedText = outcomes
        .flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value.text] : []))
        .join("\n");
    for (const run of runs) {
        assert.match(startedText, new RegExp(`^Started run ${run.id}: `, "m"));
    }
    const rejected = outcomes[1]!;
    assert.ok(rejected.status === "rejected");
    assert.match(String(rejected.reason), /Not available in a run: no_such_tool/);

    for (const run of runs) {
        await waitForTurns(manager, run, 1);
    }
});

test("a named agent start that sets an inline setting fails and starts nothing", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);

    await assert.rejects(
        call("subagent_start", { task: "a", agent: "reviewer", model: "faux/faux-2" }),
        /The agent "reviewer" runs with the model, thinking, tools and isolation of its definition; .*leave out model\./,
    );

    assert.equal(manager.branchRuns().length, 0);
});
