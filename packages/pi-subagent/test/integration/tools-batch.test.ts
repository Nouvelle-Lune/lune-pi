import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { loadToolCatalog } from "../../src/catalog.ts";
import { RUN_ENTRY_TYPE } from "../../src/run/types.ts";
import { createSubagentTools } from "../../src/tools/subagent-tools.ts";
import {
    createFixture,
    definition,
    reportResponse,
    waitForTurns,
    type Fixture,
} from "../harness/fixture.ts";

async function setup(fx: Fixture) {
    const definitions = [definition({ name: "reviewer" })];
    const manager = fx.createManager(definitions);
    const tools = createSubagentTools({
        manager,
        definitions,
        models: ["faux/faux-1", "faux/faux-2"],
        catalog: await loadToolCatalog(fx.cwd, fx.agentDir),
    });
    const start = tools.find((tool) => tool.name === "subagent_start") as ToolDefinition;
    const call = async (params: Record<string, unknown>) => {
        const updates: string[] = [];
        const result = await start.execute(
            "call-1",
            params as never,
            undefined,
            (update) =>
                updates.push(
                    update.content.map((part) => ("text" in part ? part.text : "")).join(""),
                ),
            fx.ctx as ExtensionToolContext,
        );

        return {
            text: result.content.map((part) => ("text" in part ? part.text : "")).join(""),
            updates,
        };
    };

    return { manager, call };
}

function runFiles(fx: Fixture): string[] {
    const dir = join(fx.agentDir, "lune-subagents", "sessions", fx.parent.getSessionId());

    return existsSync(dir) ? readdirSync(dir) : [];
}

function spawnEntryCount(fx: Fixture): number {
    return fx.parent
        .getEntries()
        .filter(
            (entry) =>
                entry.type === "custom" &&
                (entry as { customType?: string }).customType === RUN_ENTRY_TYPE,
        ).length;
}

test("tasks starts every entry as its own run, named run-1, run-2 in entry order", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);

    fx.faux.setResponses([
        reportResponse("done", "one"),
        reportResponse("done", "two"),
        reportResponse("done", "three"),
    ]);
    const { text, updates } = await call({
        tasks: [{ task: "a" }, { task: "b" }, { task: "c", isolation: "shared" }],
    });
    const runs = manager.branchRuns();

    assert.equal(runs.length, 3);
    const ids = ["run-1", "run-2", "run-3"].map(
        (name) => runs.find((run) => run.name === name)!.id,
    );

    assert.deepEqual(runs.map((run) => run.name).sort(), ["run-1", "run-2", "run-3"]);
    assert.equal(text.split("\n\n")[0], `Started 3 runs: ${ids.join(", ")}.`);
    assert.match(text, new RegExp(`^tasks\\[2\\]: Started run ${ids[2]}: `, "m"));
    assert.match(
        text,
        /The runs work in the background\. A message arrives when each run's turn ends\.$/,
    );
    assert.ok(updates[0]!.startsWith("Starting 3 runs\ntasks[0]: "));
    assert.match(
        updates.at(-1)!,
        /^Starting 3 runs\ntasks\[0\]: Started run [0-9a-f]{8}\ntasks\[1\]: Started run/,
    );

    for (const run of runs) {
        await waitForTurns(manager, run, 1);
    }
});

test("an entry with an unknown agent fails alone; the others stay started and no file is left for it", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const { text, updates } = await call({
        tasks: [
            { task: "a", agent: "ghost" },
            { task: "b", agent: "reviewer" },
        ],
    });
    const [run] = manager.branchRuns();

    assert.equal(manager.branchRuns().length, 1);
    assert.equal(text.split("\n\n")[0], `Started 1 of 2 runs: ${run!.id}. Failed: tasks[0].`);
    assert.match(
        text,
        /^tasks\[0\] failed: No subagent definition named "ghost"\. Loaded: reviewer\.$/m,
    );
    assert.match(text, new RegExp(`^tasks\\[1\\]: Started run ${run!.id}`, "m"));
    assert.match(updates.at(-1)!, /tasks\[0\]: Failed\ntasks\[1\]: Started run [0-9a-f]{8}/);
    assert.equal(spawnEntryCount(fx), 1);
    assert.deepEqual(runFiles(fx), [`${run!.id}.jsonl`]);

    await waitForTurns(manager, run!, 1);
});

test("an entry with a tool the run does not have fails alone and removes its own run file", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const { text } = await call({
        tasks: [{ task: "a", tools: ["read", "no_such_tool"] }, { task: "b" }],
    });
    const [run] = manager.branchRuns();

    assert.equal(manager.branchRuns().length, 1);
    assert.match(text, /^tasks\[0\] failed: .*Not available in a run: no_such_tool/m);
    assert.equal(spawnEntryCount(fx), 1);
    assert.deepEqual(runFiles(fx), [`${run!.id}.jsonl`]);

    await waitForTurns(manager, run!, 1);
});

test("when every entry fails the call throws and nothing is recorded", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);

    await assert.rejects(
        call({
            tasks: [
                { task: "a", agent: "ghost" },
                { task: "b", tools: ["no_such_tool"] },
            ],
        }),
        (error: Error) => {
            assert.ok(error.message.startsWith("No run started; every entry of tasks failed."));
            assert.match(error.message, /tasks\[0\] failed: No subagent definition named "ghost"/);
            assert.match(error.message, /tasks\[1\] failed: .*no_such_tool/);

            return true;
        },
    );
    assert.equal(manager.branchRuns().length, 0);
    assert.equal(spawnEntryCount(fx), 0);
    assert.deepEqual(runFiles(fx), []);
});

test("a call-level error starts no run through the real manager", async (t) => {
    const fx = await createFixture(t);
    const { manager, call } = await setup(fx);

    await assert.rejects(call({ task: "a", tasks: [{ task: "b" }] }), /not both/);
    await assert.rejects(
        call({ tasks: [{ task: "b" }], model: "faux/faux-1" }),
        /With tasks, set model/,
    );
    await assert.rejects(call({ tasks: [] }), /tasks has no entries/);
    await assert.rejects(call({}), /Give task for one run, or tasks for several runs/);

    assert.equal(manager.branchRuns().length, 0);
    assert.deepEqual(runFiles(fx), []);
});
