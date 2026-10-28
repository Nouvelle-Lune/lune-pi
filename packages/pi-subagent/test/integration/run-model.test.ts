import assert from "node:assert/strict";
import { test } from "node:test";

import { createFixture, liveSessionOf, startGated } from "../harness/fixture.ts";

test("a live run reports the model and thinking level of its session", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const { run, gate } = await startGated(fx, manager, {
        task: "work",
        model: "faux/faux-1",
        thinking: "low",
    });

    t.after(() => gate.open());

    assert.equal(run.isLive, true);
    assert.equal(run.model, "faux/faux-1");
    assert.equal(run.thinkingLevel, "low");
});

test("a live run follows its session after the model or level changes, not the start values", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const { run, gate } = await startGated(fx, manager, {
        task: "work",
        model: "faux/faux-1",
        thinking: "low",
    });

    t.after(() => gate.open());

    const { session } = liveSessionOf(run);

    await session.setModel(fx.models.second);
    session.setThinkingLevel("high");

    assert.equal(run.snapshot?.model, "faux/faux-1");
    assert.equal(run.model, "faux/faux-2");
    assert.equal(run.thinkingLevel, session.thinkingLevel);
    assert.equal(run.thinkingLevel, "high");
});

test("a run restored after the parent stopped reports the snapshot values", async (t) => {
    const fx = await createFixture(t);
    const first = fx.createManager();
    const { run, gate } = await startGated(fx, first, {
        task: "work",
        model: "faux/faux-2",
        thinking: "minimal",
    });

    gate.open();
    await first.shutdown();

    const second = fx.createManager();

    second.restore();

    const restored = second.branchRun(run.id);

    assert.equal(restored.isLive, false);
    assert.equal(restored.model, "faux/faux-2");
    assert.equal(restored.thinkingLevel, "minimal");
});
