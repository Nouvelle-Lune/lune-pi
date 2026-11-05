import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { FauxResponseFactory } from "@earendil-works/pi-ai";

import {
    createFixture,
    definition,
    liveSessionOf,
    reportResponse,
    waitForTurns,
    type Fixture,
} from "../harness/fixture.ts";

/** Reports done and records which model the provider was actually asked for. */
function recordModels(seen: string[]): FauxResponseFactory {
    return (_context, _options, _state, model) => {
        seen.push(`${model.provider}/${model.id}`);

        return reportResponse("done", "ok");
    };
}

async function startOne(
    fx: Fixture,
    definitions: Parameters<Fixture["createManager"]>[0],
    params: Parameters<ReturnType<Fixture["createManager"]>["start"]>[0],
) {
    const manager = fx.createManager(definitions);
    const seen: string[] = [];

    fx.faux.setResponses([recordModels(seen)]);

    const run = await manager.start(params, fx.ctx);

    await waitForTurns(manager, run, 1);

    return { run, seen, manager };
}

test("model: the parent's model is used when neither the call nor a definition names one", async (t) => {
    const fx = await createFixture(t);
    const { run, seen } = await startOne(fx, [definition({ name: "plain" })], {
        task: "work",
        agent: "plain",
    });

    assert.deepEqual(seen, ["faux/faux-1"]);
    assert.equal(run.snapshot?.model, "faux/faux-1");
    assert.equal(run.snapshot?.sources.model, "parent");
});

test("model: a definition's model beats the parent's", async (t) => {
    const fx = await createFixture(t);
    const { run, seen } = await startOne(fx, [definition({ name: "d", model: "faux/faux-2" })], {
        task: "work",
        agent: "d",
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.sources.model, "definition");
});

test("model: an inline call's model beats the parent's", async (t) => {
    const fx = await createFixture(t);
    const { run, seen } = await startOne(fx, [], { task: "work", model: "faux/faux-2" });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.model, "faux/faux-2");
    assert.equal(run.snapshot?.sources.model, "call");
});

test("model: an agent with a model in the call is rejected and starts nothing", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager([definition({ name: "d", model: "faux/faux-2" })]);

    await assert.rejects(
        manager.start({ task: "work", agent: "d", model: "faux/faux-1" }, fx.ctx),
        /leave out model\./,
    );

    assert.equal(manager.branchRuns().length, 0);
});

test("model: a model outside the parent's scope fails the start and leaves no run file", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.state.scopedModels = [{ model: fx.models.first }];

    await assert.rejects(
        manager.start({ task: "work", model: "faux/faux-2" }, fx.ctx),
        /faux\/faux-2 is not in the allowed set: faux\/faux-1\./,
    );

    assert.equal(manager.branchRuns().length, 0);
    assert.ok(!existsSync(join(fx.agentDir, "lune-subagents", "sessions")));
    assert.ok(!fx.parent.getEntries().some((entry) => entry.type === "custom"));
});

test("model: without a configured scope, every available model may be named", async (t) => {
    const fx = await createFixture(t);
    const { seen } = await startOne(fx, [], { task: "work", model: "faux/faux-2" });

    assert.deepEqual(seen, ["faux/faux-2"]);
});

test("thinking: an inline call's level, then a definition's, then the parent's level", async (t) => {
    const fx = await createFixture(t);
    const defs = [definition({ name: "d", thinking: "high" })];
    const inherited = await startOne(fx, [], { task: "work" });
    const fromDefinition = await startOne(fx, defs, { task: "work", agent: "d" });
    const fromCall = await startOne(fx, [], { task: "work", thinking: "low" });

    assert.deepEqual(
        [inherited, fromDefinition, fromCall].map(({ run }) => run.snapshot?.thinking),
        ["medium", "high", "low"],
    );
    assert.deepEqual(
        [inherited, fromDefinition, fromCall].map(({ run }) => run.snapshot?.sources.thinking),
        ["parent", "definition", "call"],
    );
    assert.equal(liveSessionOf(fromCall.run).session.thinkingLevel, "low");
});

test("tools: an inline call's tools, then a definition's; report is always allowed", async (t) => {
    const fx = await createFixture(t);
    const defs = [
        definition({ name: "d", tools: ["find"] }),
        definition({ name: "empty", tools: [] }),
    ];
    const fromDefinition = await startOne(fx, defs, { task: "work", agent: "d" });
    const fromCall = await startOne(fx, defs, { task: "work", tools: ["grep"] });
    const none = await startOne(fx, defs, { task: "work", agent: "empty" });
    const callNone = await startOne(fx, defs, { task: "work", tools: [] });

    assert.deepEqual(fromDefinition.run.snapshot?.tools, ["find", "report"]);
    assert.equal(fromDefinition.run.snapshot?.sources.tools, "definition");
    assert.deepEqual(fromCall.run.snapshot?.tools, ["grep", "report"]);
    assert.equal(fromCall.run.snapshot?.sources.tools, "call");
    assert.deepEqual(none.run.snapshot?.tools, ["report"]);
    assert.deepEqual(callNone.run.snapshot?.tools, ["report"]);
    assert.deepEqual(liveSessionOf(callNone.run).session.getActiveToolNames(), ["report"]);
    assert.deepEqual(liveSessionOf(fromCall.run).session.getActiveToolNames().sort(), [
        "grep",
        "report",
    ]);
});

test("tools: an agent with an empty tools list in the call is rejected and starts nothing", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager([definition({ name: "d", tools: ["find"] })]);

    await assert.rejects(
        manager.start({ task: "work", agent: "d", tools: [] }, fx.ctx),
        /leave out tools\./,
    );

    assert.equal(manager.branchRuns().length, 0);
});

test("tools: without a call or definition selection the defaultTools setting applies, plus report", async (t) => {
    const fx = await createFixture(t);

    mkdirSync(fx.agentDir, { recursive: true });
    writeFileSync(join(fx.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["ls"] }));

    const { run } = await startOne(fx, [], { task: "work" });
    const active = liveSessionOf(run).session.getActiveToolNames().sort();

    assert.deepEqual(active, ["ls", "report"]);
    assert.deepEqual(run.snapshot?.tools.sort(), ["ls", "report"]);
    assert.equal(run.snapshot?.sources.tools, "settings");
});

test("isolation: shared is the default and uses the parent's working directory", async (t) => {
    const fx = await createFixture(t);
    const { run } = await startOne(fx, [], { task: "work" });

    assert.equal(run.snapshot?.isolation, "shared");
    assert.equal(run.snapshot?.sources.isolation, "default");
    assert.equal(run.snapshot?.cwd, fx.cwd);
    assert.equal(run.snapshot?.worktree, undefined);
});
