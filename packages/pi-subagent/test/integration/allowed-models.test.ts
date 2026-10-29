import assert from "node:assert/strict";
import { test } from "node:test";

import type { FauxResponseFactory } from "@earendil-works/pi-ai";

import type { ModelRef } from "../../src/models.ts";
import {
    createFixture,
    definition,
    reportResponse,
    waitForTurns,
    type Fixture,
} from "../harness/fixture.ts";

const SECOND = { provider: "faux", id: "faux-2" };
const GONE = { provider: "ghost", id: "gone" };

/** Reports done and records which model the provider was actually asked for. */
function recordModels(seen: string[]): FauxResponseFactory {
    return (_context, _options, _state, model) => {
        seen.push(`${model.provider}/${model.id}`);

        return reportResponse("done", "ok");
    };
}

function managerWith(
    fx: Fixture,
    options: {
        selection?: readonly ModelRef[];
        definitions?: Parameters<Fixture["createManager"]>[0];
    } = {},
) {
    return fx.createManager(
        options.definitions,
        fx.ctx,
        undefined,
        undefined,
        options.selection ? async () => options.selection! : undefined,
    );
}

async function startAndWait(
    fx: Fixture,
    manager: ReturnType<Fixture["createManager"]>,
    params: Parameters<ReturnType<Fixture["createManager"]>["start"]>[0],
) {
    const seen: string[] = [];

    fx.faux.setResponses([recordModels(seen)]);

    const run = await manager.start(params, fx.ctx);

    await waitForTurns(manager, run, 1);

    return { run, seen };
}

test("an explicit model in the saved selection starts even when Pi's scope excludes it", async (t) => {
    const fx = await createFixture(t);
    const manager = managerWith(fx, { selection: [SECOND] });

    fx.state.scopedModels = [{ model: fx.models.first }];

    const { run, seen } = await startAndWait(fx, manager, {
        task: "work",
        model: "faux/faux-2",
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.model, "faux/faux-2");
    assert.equal(run.snapshot?.sources.model, "call");
});

test("an explicit model in Pi's scope but outside the saved selection fails the start", async (t) => {
    const fx = await createFixture(t);
    const manager = managerWith(fx, { selection: [SECOND] });

    fx.state.scopedModels = [{ model: fx.models.first }];

    await assert.rejects(
        manager.start({ task: "work", model: "faux/faux-1" }, fx.ctx),
        /faux\/faux-1 is not in the allowed set: faux\/faux-2\./,
    );
    assert.equal(manager.branchRuns().length, 0);
});

test("a definition's model in the saved selection starts even when Pi's scope excludes it", async (t) => {
    const fx = await createFixture(t);
    const manager = managerWith(fx, {
        selection: [SECOND],
        definitions: [definition({ name: "d", model: "faux/faux-2" })],
    });

    fx.state.scopedModels = [{ model: fx.models.first }];

    const { run, seen } = await startAndWait(fx, manager, { task: "work", agent: "d" });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.sources.model, "definition");
});

test("a definition's model outside the saved selection fails the start", async (t) => {
    const fx = await createFixture(t);
    const manager = managerWith(fx, {
        selection: [SECOND],
        definitions: [definition({ name: "d", model: "faux/faux-1" })],
    });

    fx.state.scopedModels = [{ model: fx.models.first }];

    await assert.rejects(
        manager.start({ task: "work", agent: "d" }, fx.ctx),
        /faux\/faux-1 is not in the allowed set: faux\/faux-2\./,
    );
    assert.equal(manager.branchRuns().length, 0);
});

test("a saved model that is no longer available does not broaden the allowlist to Pi's scope", async (t) => {
    const fx = await createFixture(t);
    const manager = managerWith(fx, { selection: [GONE] });

    fx.state.scopedModels = [{ model: fx.models.first }];

    await assert.rejects(
        manager.start({ task: "work", model: "faux/faux-1" }, fx.ctx),
        /faux\/faux-1 is not in the allowed set; no models are available\./,
    );
    assert.equal(manager.branchRuns().length, 0);
});

test("without a requested model the parent's model is inherited outside the saved selection", async (t) => {
    const fx = await createFixture(t);
    const manager = managerWith(fx, { selection: [SECOND] });

    fx.state.scopedModels = [{ model: fx.models.first }];

    const { run, seen } = await startAndWait(fx, manager, { task: "work" });

    assert.deepEqual(seen, ["faux/faux-1"]);
    assert.equal(run.snapshot?.model, "faux/faux-1");
    assert.equal(run.snapshot?.sources.model, "parent");
});
