import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { autoModelRequest, chooseAutoModel, type AutoModelSettings } from "../../src/auto-model.ts";
import { definition } from "./support.ts";

interface FakeModel {
    provider: string;
    id: string;
    name: string;
    cost: { input: number; output: number };
    reasoning: boolean;
    contextWindow: number;
}

function model(id: string, input: number, extra: Partial<FakeModel> = {}): FakeModel {
    return {
        provider: "prov",
        id,
        name: id.toUpperCase(),
        cost: { input, output: input * 5 },
        reasoning: true,
        contextWindow: 200_000,
        ...extra,
    };
}

const small = model("small", 1, { reasoning: false });
const big = model("big", 3);
const free = model("free", 0);
const CLASSIFIER = { provider: "cls", id: "judge" };

interface Request {
    state: unknown;
    questions: { model: { criteria: Record<string, string> } };
}

interface Calls {
    typed: number;
    classified: Array<{ model: unknown; request: Request }>;
}

function fakeCtx(
    options: {
        available?: FakeModel[];
        scoped?: FakeModel[];
        current?: FakeModel | undefined;
        classifiers?: Array<{ provider: string; id: string; contextWindow: number }>;
        result?: Record<string, unknown>;
        choice?: string;
    } = {},
) {
    const calls: Calls = { typed: 0, classified: [] };
    const available = options.available ?? [small, big, free];
    const ctx = {
        model: "current" in options ? options.current : big,
        scopedModels: (options.scoped ?? []).map((scoped) => ({ model: scoped })),
        modelRegistry: {
            getAvailable: () => available,
            find: (provider: string, id: string) =>
                available.find((entry) => entry.provider === provider && entry.id === id),
            getAvailableOfType: async () => {
                calls.typed += 1;

                return options.classifiers ?? [{ ...CLASSIFIER, contextWindow: 8_000 }];
            },
            classify: async (classifier: unknown, request: Request) => {
                calls.classified.push({ model: classifier, request });

                return {
                    stopReason: "stop",
                    answers: {
                        model: {
                            type: "choice",
                            choice: options.choice ?? "prov/small",
                            probabilities: {},
                            confidence: 0.82,
                        },
                    },
                    ...options.result,
                };
            },
        },
    } as unknown as ExtensionContext;

    return { ctx, calls };
}

const withClassifier = (candidates: AutoModelSettings["candidates"] = []): AutoModelSettings => ({
    classifier: CLASSIFIER,
    candidates,
});
const input = { task: "Find callers of foo", isolation: "shared" as const };

test("without a classifier the main agent's model runs and no classifier is asked", async () => {
    const { ctx, calls } = fakeCtx();

    const actual = await chooseAutoModel({
        ctx,
        settings: { classifier: null, candidates: [] },
        ...input,
    });

    assert.deepEqual(actual, {
        ref: { provider: "prov", id: "big" },
        choice: { by: "no-classifier" },
    });
    assert.equal(calls.typed, 0);
});

test("without a classifier and without a current model the start fails", async () => {
    const { ctx } = fakeCtx({ current: undefined });

    await assert.rejects(
        chooseAutoModel({ ctx, settings: { classifier: null, candidates: [] }, ...input }),
        /main agent has no current model/,
    );
});

test("one allowed candidate is chosen without any classifier call", async () => {
    const { ctx, calls } = fakeCtx();

    const actual = await chooseAutoModel({
        ctx,
        settings: withClassifier([{ provider: "prov", id: "big" }]),
        ...input,
    });

    assert.deepEqual(actual, {
        ref: { provider: "prov", id: "big" },
        choice: { by: "only-candidate", candidates: ["prov/big"] },
    });
    assert.equal(calls.typed, 0);
    assert.equal(calls.classified.length, 0);
});

test("a selected candidate that is not allowed is left out, which can leave a single one", async () => {
    const { ctx, calls } = fakeCtx();

    const actual = await chooseAutoModel({
        ctx,
        settings: withClassifier([
            { provider: "gone", id: "x" },
            { provider: "prov", id: "small" },
        ]),
        ...input,
    });

    assert.equal(actual.choice.by, "only-candidate");
    assert.deepEqual(actual.ref, { provider: "prov", id: "small" });
    assert.equal(calls.classified.length, 0);
});

test("a selection that the scope left entirely fails and names the candidates", async () => {
    const { ctx } = fakeCtx({ scoped: [big] });

    await assert.rejects(
        chooseAutoModel({
            ctx,
            settings: withClassifier([
                { provider: "prov", id: "small" },
                { provider: "gone", id: "x" },
            ]),
            ...input,
        }),
        /None of the auto candidates \(prov\/small, gone\/x\) is in the allowed set: prov\/big\./,
    );
});

test("with no selection the classifier chooses among every allowed model", async () => {
    const { ctx, calls } = fakeCtx({ scoped: [small, big] });

    const actual = await chooseAutoModel({ ctx, settings: withClassifier(), ...input });

    assert.deepEqual(actual, {
        ref: { provider: "prov", id: "small" },
        choice: {
            by: "classifier",
            classifier: "cls/judge",
            confidence: 0.82,
            candidates: ["prov/small", "prov/big"],
        },
    });
    assert.equal(calls.classified.length, 1);
    assert.deepEqual(calls.classified[0]!.model, { ...CLASSIFIER, contextWindow: 8_000 });
    assert.deepEqual(Object.keys(calls.classified[0]!.request.questions.model.criteria), [
        "prov/small",
        "prov/big",
    ]);
});

test("duplicate selections are asked once and keep the selection order", async () => {
    const { ctx, calls } = fakeCtx();

    await chooseAutoModel({
        ctx,
        settings: withClassifier([
            { provider: "prov", id: "big" },
            { provider: "prov", id: "small" },
            { provider: "prov", id: "big" },
        ]),
        ...input,
    });

    assert.deepEqual(Object.keys(calls.classified[0]!.request.questions.model.criteria), [
        "prov/big",
        "prov/small",
    ]);
});

test("with no model available at all an auto run cannot start", async () => {
    const { ctx } = fakeCtx({ available: [] });

    await assert.rejects(
        chooseAutoModel({ ctx, settings: withClassifier(), ...input }),
        /No models are available for an auto run/,
    );
});

test("a classifier that Pi does not list is reported as unavailable", async () => {
    const { ctx } = fakeCtx({ classifiers: [] });

    await assert.rejects(
        chooseAutoModel({ ctx, settings: withClassifier(), ...input }),
        /The auto classifier cls\/judge is unavailable/,
    );
});

test("a classifier result that did not stop normally fails with its error message", async () => {
    const { ctx } = fakeCtx({ result: { stopReason: "error", errorMessage: "quota" } });

    await assert.rejects(
        chooseAutoModel({ ctx, settings: withClassifier(), ...input }),
        /The auto classifier cls\/judge failed: quota\./,
    );
});

test("an answer outside the candidates is not accepted", async () => {
    const { ctx } = fakeCtx({ choice: "prov/other" });

    await assert.rejects(
        chooseAutoModel({ ctx, settings: withClassifier(), ...input }),
        /The auto classifier cls\/judge returned no valid model choice/,
    );
});

test("a result without a choice answer is not accepted", async () => {
    const { ctx } = fakeCtx({ result: { answers: {} } });

    await assert.rejects(
        chooseAutoModel({ ctx, settings: withClassifier(), ...input }),
        /returned no valid model choice/,
    );
});

test("the request carries the task, the tools and the isolation, and no agent without a definition", async () => {
    const { ctx, calls } = fakeCtx();

    await chooseAutoModel({
        ctx,
        settings: withClassifier(),
        task: "Find callers of foo",
        tools: ["read", "grep"],
        isolation: "worktree",
    });

    assert.deepEqual(calls.classified[0]!.request.state, {
        task: "Find callers of foo",
        tools: ["read", "grep"],
        isolation: "worktree",
    });
});

test("the request describes each candidate with price rank among the priced ones only", () => {
    const { ctx } = fakeCtx();

    const request = autoModelRequest(
        { ctx, ...input },
        ["prov/small", "prov/big", "prov/free", "prov/missing"],
        4_000,
    );
    const criteria = request.questions["model"]!.criteria as Record<string, string>;

    assert.match(
        criteria["prov/small"]!,
        /^SMALL \(prov\/small\): it costs \$1 per million input tokens and \$5 per million output tokens, price rank 1 of 2 from the cheapest\./,
    );
    assert.match(
        criteria["prov/small"]!,
        /It has no extended reasoning, with a context window of 200,000 tokens\.$/,
    );
    assert.match(
        criteria["prov/big"]!,
        /price rank 2 of 2 from the cheapest\. It supports extended reasoning/,
    );
    assert.match(criteria["prov/free"]!, /^FREE \(prov\/free\): Pi lists no price for it\. /);
    assert.doesNotMatch(criteria["prov/free"]!, /rank/);
    assert.equal(criteria["prov/missing"], "prov/missing. Pi lists no details for this model.");
});

test("a task over the limit is shortened and says how much was left out", () => {
    const { ctx } = fakeCtx();

    const request = autoModelRequest(
        { ctx, task: "x".repeat(120), isolation: "shared" },
        ["prov/small"],
        100,
    );

    assert.equal(
        (request.state as { task: string }).task,
        `${"x".repeat(100)}\n[20 more characters not shown]`,
    );
});

test("an agent definition adds its name, description and shortened instructions to the state", () => {
    const { ctx } = fakeCtx();

    const request = autoModelRequest(
        {
            ctx,
            ...input,
            definition: definition("reviewer", {
                description: "Reviews diffs.",
                body: "y".repeat(50),
            }),
        },
        ["prov/small"],
        80,
    );

    assert.deepEqual((request.state as { agent: unknown }).agent, {
        name: "reviewer",
        description: "Reviews diffs.",
        instructions: `${"y".repeat(20)}\n[30 more characters not shown]`,
    });
    assert.equal((request.state as { tools: unknown }).tools, "the default tool selection");
});
