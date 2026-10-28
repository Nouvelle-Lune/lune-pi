import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AutoModelSettings } from "../../src/auto-model.ts";
import { startValueLines } from "../../src/tools/format.ts";
import {
    createFixture,
    definition,
    reportResponse,
    waitForTurns,
    type Fixture,
} from "../harness/fixture.ts";

const FIRST = { provider: "faux", id: "faux-1" };
const SECOND = { provider: "faux", id: "faux-2" };
const JUDGE = { provider: "cls", id: "judge" };

interface Classification {
    requests: unknown[];
}

/** The fixture's context with a registry that also lists a classifier and answers `choice`. */
function withClassifier(fx: Fixture, answer: { choice?: string; stopReason?: string }) {
    const seen: Classification = { requests: [] };
    const registry = {
        ...fx.ctx.modelRegistry,
        find: (provider: string, id: string) => fx.runtime.getModel(provider, id),
        getAvailableOfType: async () => [{ ...JUDGE, contextWindow: 8_000 }],
        classify: async (_model: unknown, request: unknown) => {
            seen.requests.push(request);

            return {
                stopReason: answer.stopReason ?? "stop",
                errorMessage: "quota",
                answers: {
                    model: {
                        type: "choice",
                        choice: answer.choice,
                        probabilities: {},
                        confidence: 0.9,
                    },
                },
            };
        },
    };
    const ctx = Object.create(fx.ctx, {
        modelRegistry: { value: registry },
    }) as ExtensionContext;

    return { ctx, seen };
}

const settings = (value: AutoModelSettings) => async (): Promise<AutoModelSettings> => value;

async function startAuto(
    fx: Fixture,
    options: {
        params?: { agent?: string };
        definitions?: Parameters<Fixture["createManager"]>[0];
        settings?: AutoModelSettings;
        ctx?: ExtensionContext;
        model?: string;
    },
) {
    const ctx = options.ctx ?? fx.ctx;
    const manager = fx.createManager(
        options.definitions,
        ctx,
        undefined,
        options.settings && settings(options.settings),
    );
    const seen: string[] = [];
    const progress: string[] = [];

    fx.faux.setResponses([
        (_context, _options, _state, model) => {
            seen.push(`${model.provider}/${model.id}`);

            return reportResponse("done", "ok");
        },
    ]);

    const run = await manager.start(
        { task: "work", ...options.params, ...(options.model ? { model: options.model } : {}) },
        ctx,
        { onProgress: (text) => progress.push(text) },
    );

    await waitForTurns(manager, run, 1);

    return { run, seen, progress, manager };
}

test("auto from the call without settings runs the main agent's model and records why", async (t) => {
    const fx = await createFixture(t);

    const { run, seen, progress } = await startAuto(fx, { model: "auto" });

    assert.deepEqual(seen, ["faux/faux-1"]);
    assert.equal(progress[0], "Choosing a model");
    assert.equal(run.snapshot?.model, "faux/faux-1");
    assert.equal(run.snapshot?.sources.model, "call");
    assert.deepEqual(run.snapshot?.autoModel, { by: "no-classifier" });
    assert.equal(
        startValueLines(run)[1],
        "Model: faux/faux-1 (auto from call: no classifier is selected, so the main agent's model)",
    );
});

test("an explicit model records no auto choice and reports no model choosing", async (t) => {
    const fx = await createFixture(t);

    const { run, progress } = await startAuto(fx, { model: "faux/faux-2" });

    assert.equal(run.snapshot?.autoModel, undefined);
    assert.ok(!progress.includes("Choosing a model"));
});

test("auto from a definition with a single allowed candidate takes it without a classifier call", async (t) => {
    const fx = await createFixture(t);
    const { ctx, seen: classified } = withClassifier(fx, { choice: "faux/faux-1" });

    const { run, seen } = await startAuto(fx, {
        ctx,
        definitions: [definition({ name: "d", model: "auto" })],
        params: { agent: "d" },
        settings: { classifier: JUDGE, candidates: [SECOND] },
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.sources.model, "definition");
    assert.deepEqual(run.snapshot?.autoModel, {
        by: "only-candidate",
        candidates: ["faux/faux-2"],
    });
    assert.equal(classified.requests.length, 0);
    assert.equal(
        startValueLines(run)[1],
        "Model: faux/faux-2 (auto from definition: the only allowed candidate)",
    );
});

test("auto with a classifier runs the model it chose and names the agent in its request", async (t) => {
    const fx = await createFixture(t);
    const { ctx, seen: classified } = withClassifier(fx, { choice: "faux/faux-2" });

    const { run, seen } = await startAuto(fx, {
        ctx,
        definitions: [definition({ name: "d", description: "Reads code.", model: "auto" })],
        params: { agent: "d" },
        settings: { classifier: JUDGE, candidates: [FIRST, SECOND] },
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.deepEqual(run.snapshot?.autoModel, {
        by: "classifier",
        classifier: "cls/judge",
        confidence: 0.9,
        candidates: ["faux/faux-1", "faux/faux-2"],
    });
    assert.equal(
        startValueLines(run)[1],
        "Model: faux/faux-2 (auto from definition: the classifier cls/judge chose it from 2 candidates with 90% confidence)",
    );
    const request = classified.requests[0] as { state: { task: string; agent: { name: string } } };

    assert.equal(request.state.task, "work");
    assert.equal(request.state.agent.name, "d");
});

test("a call's explicit model beats a definition's auto and asks no classifier", async (t) => {
    const fx = await createFixture(t);
    const { ctx, seen: classified } = withClassifier(fx, { choice: "faux/faux-1" });

    const { run, seen } = await startAuto(fx, {
        ctx,
        definitions: [definition({ name: "d", model: "auto" })],
        params: { agent: "d" },
        model: "faux/faux-2",
        settings: { classifier: JUDGE, candidates: [] },
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.autoModel, undefined);
    assert.equal(classified.requests.length, 0);
});

test("a failing classifier fails the start and leaves no run file or entry", async (t) => {
    const fx = await createFixture(t);
    const { ctx } = withClassifier(fx, { stopReason: "error" });
    const manager = fx.createManager(
        [],
        ctx,
        undefined,
        settings({ classifier: JUDGE, candidates: [] }),
    );

    await assert.rejects(
        manager.start({ task: "work", model: "auto" }, ctx),
        /The auto classifier cls\/judge failed: quota\./,
    );

    assert.equal(manager.branchRuns().length, 0);
    assert.ok(!existsSync(join(fx.agentDir, "lune-subagents", "sessions")));
    assert.ok(!fx.parent.getEntries().some((entry) => entry.type === "custom"));
});

test("applyDefinitionEdit changes the start values of a loaded definition but keeps its name and description", async (t) => {
    const fx = await createFixture(t);
    const original = definition({
        name: "d",
        description: "Loaded description.",
        file: "/agents/d.md",
        model: "faux/faux-1",
        thinking: "low",
    });
    const manager = fx.createManager([original]);

    manager.applyDefinitionEdit("/agents/d.md", {
        ...original,
        name: "renamed",
        description: "Edited description.",
        file: "/agents/renamed.md",
        model: "faux/faux-2",
        thinking: "high",
    });

    const seen: string[] = [];

    fx.faux.setResponses([
        (_context, _options, _state, model) => {
            seen.push(`${model.provider}/${model.id}`);

            return reportResponse("done", "ok");
        },
    ]);

    const run = await manager.start({ task: "work", agent: "d" }, fx.ctx);

    await waitForTurns(manager, run, 1);

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.name, "d");
    assert.equal(run.snapshot?.definition?.name, "d");
    assert.equal(run.snapshot?.thinking, "high");
});

test("applyDefinitionEdit for a file that no definition was loaded from changes nothing", async (t) => {
    const fx = await createFixture(t);
    const original = definition({ name: "d", file: "/agents/d.md", model: "faux/faux-1" });
    const manager = fx.createManager([original]);

    manager.applyDefinitionEdit("/agents/other.md", { ...original, model: "faux/faux-2" });

    const seen: string[] = [];

    fx.faux.setResponses([
        (_context, _options, _state, model) => {
            seen.push(`${model.provider}/${model.id}`);

            return reportResponse("done", "ok");
        },
    ]);

    const run = await manager.start({ task: "work", agent: "d" }, fx.ctx);

    await waitForTurns(manager, run, 1);

    assert.deepEqual(seen, ["faux/faux-1"]);
});
