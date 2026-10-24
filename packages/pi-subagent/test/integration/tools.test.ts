import assert from "node:assert/strict";
import { test } from "node:test";

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
        catalog: await loadToolCatalog(fx.cwd, fx.agentDir),
    });
    const call = async (name: string, params: Record<string, unknown>) => {
        const tool = tools.find((candidate) => candidate.name === name) as ToolDefinition;
        const updates: string[] = [];
        const result = await tool.execute(
            "call-1",
            params as never,
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
        agent: "reviewer",
        isolation: "shared",
    });
    const [run] = manager.branchRuns();

    assert.ok(run);
    assert.match(started.text, new RegExp(`Started run reviewer \\(${run.id}\\)`));
    assert.match(started.text, /Isolation: shared/);
    assert.ok(started.updates.length > 0, "start reported no progress");

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    const status = await call("subagent_status", { runId: run.id });

    assert.match(status.text, /Question: Which file\?/);

    fx.faux.setResponses([reportResponse("done", "answered")]);
    const sent = await call("subagent_send", { runId: run.id, message: "a.ts" });
    await waitForTurns(manager, run, 2);

    assert.match(sent.text, /started a new turn/);

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

    assert.match(stopped.text, new RegExp(`Stopped run ${run.name} \\(${run.id}\\)`));
    assert.equal(run.state, "interrupted");
    assert.match(again.text, /is not running; its state is interrupted/);
});

test("subagent_send steers a running run and tells the main agent so", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);
    const { run, gate } = await startGated(fx, manager, { task: "slow" });

    fx.faux.appendResponses([reportResponse("done", "ok")]);
    const sent = await call("subagent_send", { runId: run.id, message: "also B" });

    assert.match(sent.text, /steers its current turn/);

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
    assert.deepEqual(withProps["model"]?.enum, ["faux/faux-1", "faux/faux-2"]);
    assert.deepEqual(withoutProps["isolation"]?.enum, ["shared", "worktree"]);
});
