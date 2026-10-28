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

/** The fixture's context with a registry that also lists a classifier and answers the ratings. */
function withClassifier(
    fx: Fixture,
    answer: {
        tier?: string;
        reasoning?: string;
        confidence?: number;
        probabilities?: Record<string, number>;
        stopReason?: string;
    },
) {
    const seen: Classification = { requests: [] };
    const rating = (choice: string | undefined, probabilities: Record<string, number> = {}) => ({
        type: "choice",
        choice,
        probabilities,
        confidence: answer.confidence ?? 0.9,
    });
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
                    tier: rating(answer.tier, answer.probabilities),
                    reasoning: rating(answer.reasoning ?? "moderate"),
                },
            };
        },
    };
    const ctx = Object.create(fx.ctx, {
        modelRegistry: { value: registry },
    }) as ExtensionContext;

    return { ctx, seen };
}

const NO_TIERS = { light: null, standard: null, complex: null, deep: null };

const settings = (value: AutoModelSettings) => async (): Promise<AutoModelSettings> => value;

async function startAuto(
    fx: Fixture,
    options: {
        params?: { agent?: string };
        definitions?: Parameters<Fixture["createManager"]>[0];
        settings?: AutoModelSettings;
        ctx?: ExtensionContext;
        model?: string;
        thinking?: "minimal";
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
        {
            task: "work",
            ...options.params,
            ...(options.model ? { model: options.model } : {}),
            ...(options.thinking ? { thinking: options.thinking } : {}),
        },
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

test("auto from a definition with the thinking set and no tier model asks no classifier", async (t) => {
    const fx = await createFixture(t);
    const { ctx, seen: classified } = withClassifier(fx, { tier: "light" });

    const { run, seen } = await startAuto(fx, {
        ctx,
        definitions: [definition({ name: "d", model: "auto", thinking: "low" })],
        params: { agent: "d" },
        settings: { classifier: JUDGE, tiers: NO_TIERS },
    });

    assert.deepEqual(seen, ["faux/faux-1"]);
    assert.equal(run.snapshot?.sources.model, "definition");
    assert.deepEqual(run.snapshot?.autoModel, { by: "nothing-to-rate" });
    assert.equal(run.snapshot?.thinking, "low");
    assert.equal(run.snapshot?.sources.thinking, "definition");
    assert.equal(classified.requests.length, 0);
    assert.equal(
        startValueLines(run)[1],
        "Model: faux/faux-1 (auto from definition: no auto tier has a model and the thinking is set, so the main agent's model)",
    );
});

test("auto with a classifier runs the rated tier's model and thinking and names the agent in its request", async (t) => {
    const fx = await createFixture(t);
    const { ctx, seen: classified } = withClassifier(fx, {
        tier: "complex",
        reasoning: "heavy",
        probabilities: { complex: 0.71, deep: 0.2 },
    });

    const { run, seen } = await startAuto(fx, {
        ctx,
        definitions: [definition({ name: "d", description: "Reads code.", model: "auto" })],
        params: { agent: "d" },
        settings: { classifier: JUDGE, tiers: { ...NO_TIERS, complex: SECOND } },
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.deepEqual(run.snapshot?.autoModel, {
        by: "rating",
        classifier: "cls/judge",
        tier: {
            rated: "complex",
            used: "complex",
            confidence: 0.9,
            probabilities: { complex: 0.71, deep: 0.2 },
        },
        modelFrom: "complex",
        reasoning: {
            rated: "heavy",
            used: "heavy",
            confidence: 0.9,
            probabilities: {},
        },
    });
    assert.equal(run.snapshot?.thinking, "high");
    assert.equal(run.snapshot?.sources.thinking, "auto");
    assert.deepEqual(startValueLines(run).slice(1, 3), [
        "Model: faux/faux-2 (auto from definition: the classifier cls/judge rated the task complex (71%); the complex tier's model)",
        "Thinking: high (auto: the classifier rated the reasoning heavy)",
    ]);
    const request = classified.requests[0] as { state: { task: string; agent: { name: string } } };

    assert.equal(request.state.task, "work");
    assert.equal(request.state.agent.name, "d");
});

test("a tier without a model falls up to the main agent's model, which the start values say", async (t) => {
    const fx = await createFixture(t);
    const { ctx } = withClassifier(fx, { tier: "deep", reasoning: "none" });

    const { run, seen } = await startAuto(fx, {
        ctx,
        model: "auto",
        settings: { classifier: JUDGE, tiers: { ...NO_TIERS, light: SECOND } },
    });

    assert.deepEqual(seen, ["faux/faux-1"]);
    assert.equal(
        run.snapshot?.autoModel?.by === "rating" ? run.snapshot.autoModel.modelFrom : undefined,
        "main",
    );
    assert.equal(
        startValueLines(run)[1],
        "Model: faux/faux-1 (auto from call: the classifier cls/judge rated the task deep; no tier from deep up has a model, so the main agent's model)",
    );
});

test("an unsure rating moves up a tier and the start values say so", async (t) => {
    const fx = await createFixture(t);
    const { ctx } = withClassifier(fx, {
        tier: "light",
        reasoning: "none",
        confidence: 0.4,
        probabilities: { light: 0.4, standard: 0.35 },
    });

    const { run, seen } = await startAuto(fx, {
        ctx,
        model: "auto",
        settings: { classifier: JUDGE, tiers: { ...NO_TIERS, light: FIRST, standard: SECOND } },
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(
        startValueLines(run)[1],
        "Model: faux/faux-2 (auto from call: the classifier cls/judge rated the task light (40%), unsure at 40% confidence, so standard; the standard tier's model)",
    );
});

test("a call's thinking beats the rated thinking while the tier still picks the model", async (t) => {
    const fx = await createFixture(t);
    const { ctx } = withClassifier(fx, { tier: "light", reasoning: "heavy" });
    const manager = fx.createManager(
        [],
        ctx,
        undefined,
        settings({ classifier: JUDGE, tiers: { ...NO_TIERS, light: SECOND } }),
    );

    fx.faux.setResponses([() => reportResponse("done", "ok")]);

    const run = await manager.start({ task: "work", model: "auto", thinking: "minimal" }, ctx);

    await waitForTurns(manager, run, 1);

    assert.equal(run.snapshot?.model, "faux/faux-2");
    assert.equal(run.snapshot?.thinking, "minimal");
    assert.equal(run.snapshot?.sources.thinking, "call");
});

test("a definition's thinking beats the rated thinking while the tier still picks the model", async (t) => {
    const fx = await createFixture(t);
    const { ctx } = withClassifier(fx, { tier: "light", reasoning: "heavy" });

    const { run, seen } = await startAuto(fx, {
        ctx,
        definitions: [definition({ name: "d", model: "auto", thinking: "low" })],
        params: { agent: "d" },
        settings: { classifier: JUDGE, tiers: { ...NO_TIERS, light: SECOND } },
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.thinking, "low");
    assert.equal(run.snapshot?.sources.thinking, "definition");
});

test("an auto run with no explicit thinking and no classifier keeps the parent's thinking", async (t) => {
    const fx = await createFixture(t);

    const { run } = await startAuto(fx, { model: "auto" });

    assert.notEqual(run.snapshot?.sources.thinking, "auto");
});

test("a call's explicit model beats a definition's auto and asks no classifier", async (t) => {
    const fx = await createFixture(t);
    const { ctx, seen: classified } = withClassifier(fx, { tier: "light" });

    const { run, seen } = await startAuto(fx, {
        ctx,
        definitions: [definition({ name: "d", model: "auto" })],
        params: { agent: "d" },
        model: "faux/faux-2",
        settings: { classifier: JUDGE, tiers: NO_TIERS },
    });

    assert.deepEqual(seen, ["faux/faux-2"]);
    assert.equal(run.snapshot?.autoModel, undefined);
    assert.equal(classified.requests.length, 0);
});

test("a failing classifier starts the run with the main agent's model and thinking and records why", async (t) => {
    const fx = await createFixture(t);
    const { ctx } = withClassifier(fx, { tier: "light", stopReason: "error" });

    const { run, seen } = await startAuto(fx, {
        ctx,
        model: "auto",
        settings: { classifier: JUDGE, tiers: { ...NO_TIERS, light: SECOND } },
    });

    assert.deepEqual(seen, ["faux/faux-1"]);
    assert.equal(run.snapshot?.model, "faux/faux-1");
    assert.deepEqual(run.snapshot?.autoModel, {
        by: "classifier-failed",
        classifier: "cls/judge",
        error: "The auto classifier cls/judge failed: quota.",
    });
    assert.equal(run.snapshot?.sources.thinking, "parent");
    assert.equal(
        startValueLines(run)[1],
        "Model: faux/faux-1 (auto from call: the main agent's model. The auto classifier cls/judge failed: quota.)",
    );
    assert.equal(startValueLines(run)[2], `Thinking: ${run.snapshot?.thinking} (from parent)`);
});

test("after a classifier failure the call's and the definition's thinking still apply", async (t) => {
    const fx = await createFixture(t);
    const { ctx } = withClassifier(fx, { tier: "light", stopReason: "error" });
    const settingsValue = { classifier: JUDGE, tiers: { ...NO_TIERS, light: SECOND } };

    const fromDefinition = await startAuto(fx, {
        ctx,
        definitions: [definition({ name: "d", model: "auto", thinking: "low" })],
        params: { agent: "d" },
        settings: settingsValue,
    });
    const fromCall = await startAuto(fx, {
        ctx,
        model: "auto",
        settings: settingsValue,
        thinking: "minimal",
    });

    assert.deepEqual(
        [fromDefinition.run.snapshot?.thinking, fromDefinition.run.snapshot?.sources.thinking],
        ["low", "definition"],
    );
    assert.deepEqual(
        [fromCall.run.snapshot?.thinking, fromCall.run.snapshot?.sources.thinking],
        ["minimal", "call"],
    );
    assert.equal(fromCall.run.snapshot?.autoModel?.by, "classifier-failed");
});

test("a start cancelled during the classification still fails and leaves no run file or entry", async (t) => {
    const fx = await createFixture(t);
    const controller = new AbortController();
    const { ctx } = withClassifier(fx, { tier: "light" });
    const registry = ctx.modelRegistry as unknown as { classify: (...args: unknown[]) => unknown };
    const classify = registry.classify;

    registry.classify = async (...args: unknown[]) => {
        controller.abort();

        return classify(...args);
    };

    const manager = fx.createManager(
        [],
        ctx,
        undefined,
        settings({ classifier: JUDGE, tiers: { ...NO_TIERS, light: SECOND } }),
    );

    await assert.rejects(
        manager.start({ task: "work", model: "auto" }, ctx, { signal: controller.signal }),
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
