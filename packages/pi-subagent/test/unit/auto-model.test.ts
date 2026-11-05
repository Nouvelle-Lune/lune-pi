import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    autoModelRequest,
    chooseAutoModel,
    DEFAULT_AUTO_MODEL_SETTINGS,
    type AutoModelSettings,
} from "../../src/auto-model.ts";
import { AUTO_TIERS, type AutoTier } from "../../src/run/types.ts";
import { definition } from "./support.ts";

interface FakeModel {
    provider: string;
    id: string;
    name: string;
    cost: { input: number; output: number };
    reasoning: boolean;
    contextWindow: number;
    thinkingLevelMap?: Record<string, string | null>;
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

// Pi's levels per model: small [off], big and free [off..high], xbig adds xhigh, nolow lacks
// minimal and low, and xmax adds xhigh and max.
const small = model("small", 1, { reasoning: false });
const big = model("big", 3);
const free = model("free", 0);
const xbig = model("xbig", 5, { thinkingLevelMap: { xhigh: "xhigh" } });
const nolow = model("nolow", 2, { thinkingLevelMap: { minimal: null, low: null } });
const xmax = model("xmax", 6, { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
const ALL = [small, big, free, xbig, nolow, xmax];
const BASE_LEVELS = ["off", "minimal", "low", "medium", "high"];
const CLASSIFIER = { provider: "cls", id: "judge" };

interface Request {
    state: Record<string, unknown>;
    questions: Record<string, { criteria: Record<string, string> }>;
}

interface Calls {
    typed: number;
    classified: Array<{ model: unknown; request: Request }>;
}

interface Answer {
    choice: string;
    confidence: number;
    probabilities?: Record<string, number>;
}

function fakeCtx(
    options: {
        available?: FakeModel[];
        scoped?: FakeModel[];
        current?: FakeModel | undefined;
        classifiers?: Array<{ provider: string; id: string; contextWindow: number; api?: string }>;
        result?: Record<string, unknown>;
        tier?: Answer;
        thinking?: Answer;
        /** The high-risk probability the classifier answers; low by default. */
        risk?: number;
        /** Replaces the whole risk answer, for answers that are not valid. */
        riskAnswer?: unknown;
        typedError?: Error;
        classifyError?: Error;
        /** Runs at each classify call with its 1-based number. */
        onClassify?: (call: number) => void;
        /** Makes the classify call with this 1-based number throw. */
        failCall?: number;
        /** Replaces the result of the classify call with this 1-based number. */
        resultOfCall?: Record<number, Record<string, unknown>>;
    } = {},
) {
    const calls: Calls = { typed: 0, classified: [] };
    const available = options.available ?? [small, big, free];
    const answer = (value: Answer) => ({
        type: "choice",
        choice: value.choice,
        confidence: value.confidence,
        probabilities: value.probabilities ?? {},
    });
    const ctx = {
        model: "current" in options ? options.current : big,
        scopedModels: (options.scoped ?? []).map((scoped) => ({ model: scoped })),
        modelRegistry: {
            getAvailable: () => available,
            find: (provider: string, id: string) =>
                available.find((entry) => entry.provider === provider && entry.id === id),
            getAvailableOfType: async () => {
                calls.typed += 1;

                if (options.typedError) throw options.typedError;

                return (
                    options.classifiers ?? [
                        { ...CLASSIFIER, contextWindow: 8_000, api: "typesafe-system-one" },
                    ]
                );
            },
            classify: async (classifier: unknown, request: Request) => {
                calls.classified.push({ model: classifier, request });

                const call = calls.classified.length;

                options.onClassify?.(call);

                if (options.classifyError) throw options.classifyError;
                if (options.failCall === call) throw new Error("second request failed");

                // Only the asked questions are answered.
                const answers: Record<string, unknown> = {};

                if ("tier" in request.questions)
                    answers.tier = answer(options.tier ?? { choice: "light", confidence: 0.9 });
                if ("risk" in request.questions)
                    answers.risk =
                        "riskAnswer" in options
                            ? options.riskAnswer
                            : {
                                  type: "bool",
                                  probability: options.risk ?? 0.05,
                              };
                if ("thinking" in request.questions)
                    answers.thinking = answer(
                        options.thinking ?? { choice: "low", confidence: 0.9 },
                    );

                return {
                    stopReason: "stop",
                    answers,
                    ...options.result,
                    ...options.resultOfCall?.[call],
                };
            },
        },
    } as unknown as ExtensionContext;

    return { ctx, calls };
}

const SMALL = { provider: "prov", id: "small" };
const BIG = { provider: "prov", id: "big" };
const FREE = { provider: "prov", id: "free" };
const XBIG = { provider: "prov", id: "xbig" };
const NOLOW = { provider: "prov", id: "nolow" };
const XMAX = { provider: "prov", id: "xmax" };

const withTiers = (
    tiers: Partial<AutoModelSettings["tiers"]> = {},
    risk: Partial<Pick<AutoModelSettings, "riskFloor" | "riskThreshold">> = {},
): AutoModelSettings => ({
    ...DEFAULT_AUTO_MODEL_SETTINGS,
    classifier: CLASSIFIER,
    tiers: { ...DEFAULT_AUTO_MODEL_SETTINGS.tiers, ...tiers },
    ...risk,
});
const input = { task: "Find callers of foo", isolation: "shared" as const, thinkingSet: false };

test("without a classifier the main agent's model runs, with no thinking and no classifier asked", async () => {
    const { ctx, calls } = fakeCtx();

    const actual = await chooseAutoModel({
        ctx,
        settings: DEFAULT_AUTO_MODEL_SETTINGS,
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
        chooseAutoModel({ ctx, settings: DEFAULT_AUTO_MODEL_SETTINGS, ...input }),
        /main agent has no current model/,
    );
});

test("with no tier model and the thinking set nothing is rated and no classifier is asked", async () => {
    const { ctx, calls } = fakeCtx();

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers(),
        ...input,
        thinkingSet: true,
    });

    assert.deepEqual(actual, {
        ref: { provider: "prov", id: "big" },
        choice: { by: "nothing-to-rate" },
    });
    assert.equal(calls.typed, 0);
    assert.equal(calls.classified.length, 0);
});

test("with no tier model the main agent's model is the only one reachable, so one request rates its thinking", async () => {
    const { ctx, calls } = fakeCtx({ thinking: { choice: "high", confidence: 0.9 } });

    const actual = await chooseAutoModel({ ctx, settings: withTiers(), ...input });

    assert.equal(calls.classified.length, 1);
    assert.deepEqual(Object.keys(calls.classified[0]!.request.questions), [
        "tier",
        "risk",
        "thinking",
    ]);
    assert.deepEqual(actual.ref, { provider: "prov", id: "big" });
    assert.equal(actual.choice.by === "rating" ? actual.choice.modelFrom : undefined, "main");
    assert.equal(actual.thinking, "high");
});

test("a tier with a model runs it, and the ratings keep their shares as finite numbers only", async () => {
    const { ctx, calls } = fakeCtx({
        tier: {
            choice: "light",
            confidence: 0.82,
            probabilities: {
                light: 0.82,
                standard: 0.12,
                complex: Number.NaN,
                deep: Number.POSITIVE_INFINITY,
                other: 0.06,
            },
        },
        thinking: { choice: "low", confidence: 0.7, probabilities: { low: 0.7, off: 0.3 } },
    });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: FREE, deep: BIG }),
        ...input,
    });

    assert.deepEqual(actual, {
        ref: FREE,
        choice: {
            by: "rating",
            classifier: "cls/judge",
            tier: {
                rated: "light",
                used: "light",
                confidence: 0.82,
                probabilities: { light: 0.82, standard: 0.12 },
            },
            modelFrom: "light",
            thinking: {
                rated: "low",
                used: "low",
                confidence: 0.7,
                probabilities: { low: 0.7, off: 0.3 },
            },
            risk: { probability: 0.05, threshold: 0.4, high: false },
        },
        thinking: "low",
    });
    assert.equal(calls.classified.length, 1);
    assert.deepEqual(calls.classified[0]!.model, {
        ...CLASSIFIER,
        contextWindow: 8_000,
        api: "typesafe-system-one",
    });
});

test("the thinking options are the levels Pi says the model supports, in order", async () => {
    const cases: Array<[string, typeof big, string[]]> = [
        ["a model that cannot reason has one level", small, ["off"]],
        ["a model with no map has the base levels", big, BASE_LEVELS],
        ["a map entry adds xhigh", xbig, [...BASE_LEVELS, "xhigh"]],
        ["map entries add xhigh and max", xmax, [...BASE_LEVELS, "xhigh", "max"]],
        ["a null map entry removes a level", nolow, ["off", "medium", "high"]],
    ];

    for (const [name, chosen, expected] of cases) {
        const { ctx, calls } = fakeCtx({ available: ALL });
        const ref = { provider: chosen.provider, id: chosen.id };

        await chooseAutoModel({
            ctx,
            settings: withTiers({ light: ref, deep: ref }),
            ...input,
        });

        const questions = calls.classified[0]!.request.questions;
        const actual = "thinking" in questions ? Object.keys(questions.thinking!.criteria) : [];

        // A single level needs no question.
        assert.deepEqual(actual, expected.length > 1 ? expected : [], name);
        assert.equal(calls.classified.length, 1, name);
    }
});

test("a model with one level gets no thinking question and no thinking", async () => {
    const { ctx, calls } = fakeCtx({ available: ALL });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL, deep: SMALL }),
        ...input,
    });

    assert.deepEqual(Object.keys(calls.classified[0]!.request.questions), ["tier", "risk"]);
    assert.equal(actual.thinking, undefined);
    assert.ok(actual.choice.by === "rating");
    assert.equal("thinking" in actual.choice, false);
});

test("models with the same levels share one request, and the tier question has every tier", async () => {
    const { ctx, calls } = fakeCtx({ available: ALL });

    await chooseAutoModel({
        ctx,
        settings: withTiers({ light: BIG, standard: FREE, deep: BIG }),
        ...input,
    });

    const { questions } = calls.classified[0]!.request;

    assert.equal(calls.classified.length, 1);
    assert.deepEqual(Object.keys(questions.tier!.criteria), [...AUTO_TIERS]);
    assert.deepEqual(Object.keys(questions.thinking!.criteria), BASE_LEVELS);
});

test("models with different levels get a tier request first and then a thinking request for the chosen model", async () => {
    const { ctx, calls } = fakeCtx({
        available: ALL,
        tier: { choice: "light", confidence: 0.9 },
        thinking: { choice: "xhigh", confidence: 0.9 },
    });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: XBIG, deep: BIG }),
        ...input,
    });

    assert.equal(calls.classified.length, 2);
    assert.deepEqual(Object.keys(calls.classified[0]!.request.questions), ["tier", "risk"]);
    assert.deepEqual(Object.keys(calls.classified[1]!.request.questions), ["thinking"]);
    assert.deepEqual(Object.keys(calls.classified[1]!.request.questions.thinking!.criteria), [
        ...BASE_LEVELS,
        "xhigh",
    ]);
    assert.deepEqual(actual.ref, XBIG);
    assert.equal(actual.thinking, "xhigh");
    assert.equal(
        actual.choice.by === "rating" ? actual.choice.thinking?.rated : undefined,
        "xhigh",
    );
});

test("the second request asks about the levels of the model the tier led to, not the other models", async () => {
    const { ctx, calls } = fakeCtx({
        available: ALL,
        tier: { choice: "deep", confidence: 0.9 },
        thinking: { choice: "medium", confidence: 0.9 },
    });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: XBIG, deep: NOLOW }),
        ...input,
    });

    assert.deepEqual(Object.keys(calls.classified[1]!.request.questions.thinking!.criteria), [
        "off",
        "medium",
        "high",
    ]);
    assert.equal(actual.thinking, "medium");
});

test("a chosen model with one level needs no second request", async () => {
    const { ctx, calls } = fakeCtx({ available: ALL, tier: { choice: "light", confidence: 0.9 } });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL, deep: BIG }),
        ...input,
    });

    assert.equal(calls.classified.length, 1);
    assert.deepEqual(actual.ref, SMALL);
    assert.equal(actual.thinking, undefined);
});

test("the main agent's model counts toward the shared levels only while the deep tier has no model", async () => {
    // The main agent's model is small ([off]); the tiers use big (the base levels).
    const withoutDeep = fakeCtx({ available: ALL, current: small });
    const withDeep = fakeCtx({ available: ALL, current: small });
    const asked = ({ calls }: { calls: Calls }) =>
        calls.classified.map((call) => Object.keys(call.request.questions));

    await chooseAutoModel({
        ctx: withoutDeep.ctx,
        settings: withTiers({ light: BIG }),
        ...input,
    });
    await chooseAutoModel({
        ctx: withDeep.ctx,
        settings: withTiers({ light: BIG, deep: BIG }),
        ...input,
    });

    // Without a deep model a task can fall to main, whose levels differ: ask the tier first.
    assert.deepEqual(asked(withoutDeep), [["tier", "risk"], ["thinking"]]);
    // With one, main is out of reach and big's levels are shared.
    assert.deepEqual(asked(withDeep), [["tier", "risk", "thinking"]]);
});

test("a tier model outside the allowed set is ignored when the shared levels are computed", async () => {
    const { ctx, calls } = fakeCtx({
        available: ALL,
        scoped: [big],
        tier: { choice: "deep", confidence: 0.9 },
    });

    await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL, deep: BIG }),
        ...input,
    });

    assert.equal(calls.classified.length, 1);
    assert.deepEqual(Object.keys(calls.classified[0]!.request.questions), [
        "tier",
        "risk",
        "thinking",
    ]);
});

test("a confidence under one half moves a rating up one level and a confidence of one half does not", async () => {
    const unsure = fakeCtx({
        tier: { choice: "light", confidence: 0.4 },
        thinking: { choice: "off", confidence: 0.49 },
    });
    const sure = fakeCtx({
        tier: { choice: "light", confidence: 0.5 },
        thinking: { choice: "off", confidence: 0.5 },
    });
    const settings = withTiers({ light: BIG, standard: FREE, deep: BIG });

    const moved = await chooseAutoModel({ ctx: unsure.ctx, settings, ...input });
    const kept = await chooseAutoModel({ ctx: sure.ctx, settings, ...input });

    assert.ok(moved.choice.by === "rating" && kept.choice.by === "rating");
    assert.deepEqual(
        [moved.choice.tier.rated, moved.choice.tier.used, moved.choice.thinking?.used],
        ["light", "standard", "minimal"],
    );
    assert.deepEqual(moved.ref, FREE);
    assert.equal(moved.thinking, "minimal");
    assert.deepEqual(
        [kept.choice.tier.rated, kept.choice.tier.used, kept.choice.thinking?.used],
        ["light", "light", "off"],
    );
    assert.deepEqual(kept.ref, BIG);
    assert.equal(kept.thinking, "off");
});

test("an unsure thinking rating moves to the next supported level and stops at the last", async () => {
    const skip = fakeCtx({
        available: ALL,
        thinking: { choice: "off", confidence: 0.1 },
    });
    const cap = fakeCtx({
        available: ALL,
        tier: { choice: "deep", confidence: 0.1 },
        thinking: { choice: "high", confidence: 0.1 },
    });

    // nolow supports [off, medium, high]: the level above off is medium, not the missing minimal.
    const skipped = await chooseAutoModel({
        ctx: skip.ctx,
        settings: withTiers({ light: NOLOW, deep: NOLOW }),
        ...input,
    });
    const capped = await chooseAutoModel({
        ctx: cap.ctx,
        settings: withTiers({ light: NOLOW, deep: NOLOW }),
        ...input,
    });

    assert.equal(skipped.thinking, "medium");
    assert.equal(capped.thinking, "high");
    assert.ok(capped.choice.by === "rating");
    assert.deepEqual(
        [capped.choice.tier.used, capped.choice.thinking?.rated, capped.choice.thinking?.used],
        ["deep", "high", "high"],
    );
});

test("an unsure thinking rating of the last level stays on it, also in the second request", async () => {
    const { ctx } = fakeCtx({
        available: ALL,
        tier: { choice: "light", confidence: 0.9 },
        thinking: { choice: "max", confidence: 0.1 },
    });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: XMAX, deep: BIG }),
        ...input,
    });

    assert.equal(actual.thinking, "max");
});

test("the model comes from the used tier, else the next tier up that has one, else the main agent", async () => {
    const cases: Array<{
        rated: AutoTier;
        tiers: Partial<AutoModelSettings["tiers"]>;
        modelFrom: AutoTier | "main";
        ref: { provider: string; id: string };
    }> = [
        {
            rated: "standard",
            tiers: { standard: SMALL, deep: FREE },
            modelFrom: "standard",
            ref: SMALL,
        },
        { rated: "light", tiers: { complex: SMALL, deep: FREE }, modelFrom: "complex", ref: SMALL },
        { rated: "complex", tiers: { light: SMALL }, modelFrom: "main", ref: BIG },
        { rated: "deep", tiers: { light: SMALL, deep: FREE }, modelFrom: "deep", ref: FREE },
    ];

    for (const { rated, tiers, modelFrom, ref } of cases) {
        const { ctx } = fakeCtx({ tier: { choice: rated, confidence: 0.9 } });

        const actual = await chooseAutoModel({ ctx, settings: withTiers(tiers), ...input });

        assert.equal(
            actual.choice.by === "rating" ? actual.choice.modelFrom : undefined,
            modelFrom,
        );
        assert.deepEqual(actual.ref, ref);
    }
});

test("a tier model outside the allowed set fails the start and names the tier and the allowed models", async () => {
    const { ctx } = fakeCtx({ scoped: [big], tier: { choice: "light", confidence: 0.9 } });

    await assert.rejects(
        chooseAutoModel({ ctx, settings: withTiers({ light: SMALL }), ...input }),
        /The light auto tier uses prov\/small, which is not in the allowed set: prov\/big\./,
    );
});

test("a tier model that is not used is not checked against the allowed set", async () => {
    const { ctx } = fakeCtx({ scoped: [big], tier: { choice: "deep", confidence: 0.9 } });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL, deep: BIG }),
        ...input,
    });

    assert.deepEqual(actual.ref, BIG);
});

test("an explicit thinking level sends no thinking question and no thinking, but still picks the model", async () => {
    const { ctx, calls } = fakeCtx({ available: ALL });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL, deep: BIG }),
        ...input,
        thinkingSet: true,
    });

    assert.deepEqual(actual.ref, SMALL);
    assert.equal(actual.thinking, undefined);
    assert.equal(calls.classified.length, 1);
    assert.deepEqual(Object.keys(calls.classified[0]!.request.questions), ["tier", "risk"]);
    assert.ok(actual.choice.by === "rating");
    assert.equal("thinking" in actual.choice, false);
});

/** The start still gets the main agent's model, with the failure recorded and no thinking. */
async function failedChoice(ctx: ExtensionContext, extra: Partial<typeof input> = {}) {
    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL }),
        ...input,
        ...extra,
    });

    assert.deepEqual(actual.ref, { provider: "prov", id: "big" });
    assert.equal(actual.thinking, undefined);
    assert.ok(actual.choice.by === "classifier-failed");

    return actual.choice;
}

test("a classifier that Pi does not list falls back to the main agent's model and says it is unavailable", async () => {
    const { ctx } = fakeCtx({ classifiers: [] });

    const actual = await failedChoice(ctx);

    assert.equal(actual.classifier, "cls/judge");
    assert.match(actual.error, /^The classifier cls\/judge is unavailable\./);
});

test("a registry that cannot list the classifiers falls back with its error", async () => {
    const { ctx } = fakeCtx({ typedError: new Error("registry down") });

    const actual = await failedChoice(ctx);

    assert.deepEqual([actual.classifier, actual.error], ["cls/judge", "registry down"]);
});

test("a classify call that throws falls back with its error", async () => {
    const { ctx } = fakeCtx({ classifyError: new Error("network") });

    const actual = await failedChoice(ctx);

    assert.deepEqual([actual.classifier, actual.error], ["cls/judge", "network"]);
});

test("a classifier result that did not stop normally falls back with its error message", async () => {
    const { ctx } = fakeCtx({ result: { stopReason: "error", errorMessage: "quota" } });

    const actual = await failedChoice(ctx);

    assert.equal(actual.error, "The auto classifier cls/judge failed: quota.");
});

test("a tier answer outside the levels falls back", async () => {
    const { ctx } = fakeCtx({ tier: { choice: "huge", confidence: 0.9 } });

    const actual = await failedChoice(ctx);

    assert.equal(actual.error, "The auto classifier cls/judge gave no valid tier.");
});

test("a thinking answer outside the supported levels falls back", async () => {
    const { ctx } = fakeCtx({ thinking: { choice: "xhigh", confidence: 0.9 } });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: BIG, deep: BIG }),
        ...input,
    });

    assert.ok(actual.choice.by === "classifier-failed");
    assert.equal(
        actual.choice.error,
        "The auto classifier cls/judge gave no valid thinking level.",
    );
    assert.deepEqual(actual.ref, BIG);
    assert.equal(actual.thinking, undefined);
});

test("a failed or invalid second request falls back to the main agent's model and no thinking", async () => {
    const settings = withTiers({ light: XBIG, deep: BIG });
    const failing = fakeCtx({ available: ALL, failCall: 2 });
    const invalid = fakeCtx({
        available: ALL,
        thinking: { choice: "max", confidence: 0.9 },
    });
    const stopped = fakeCtx({
        available: ALL,
        resultOfCall: { 2: { stopReason: "error", errorMessage: "quota" } },
    });

    const results = [
        await chooseAutoModel({ ctx: failing.ctx, settings, ...input }),
        await chooseAutoModel({ ctx: invalid.ctx, settings, ...input }),
        await chooseAutoModel({ ctx: stopped.ctx, settings, ...input }),
    ];

    assert.deepEqual(
        results.map((result) => result.choice.by === "classifier-failed" && result.choice.error),
        [
            "second request failed",
            "The auto classifier cls/judge gave no valid thinking level.",
            "The auto classifier cls/judge failed: quota.",
        ],
    );

    for (const result of results) {
        assert.deepEqual(result.ref, BIG);
        assert.equal(result.thinking, undefined);
    }

    assert.equal(failing.calls.classified.length, 2);
});

test("a start cancelled during the second request rethrows instead of falling back", async () => {
    const controller = new AbortController();
    const { ctx, calls } = fakeCtx({
        available: ALL,
        onClassify: (call) => {
            if (call === 2) controller.abort();
        },
        failCall: 2,
    });

    await assert.rejects(
        chooseAutoModel({
            ctx,
            settings: withTiers({ light: XBIG, deep: BIG }),
            ...input,
            signal: controller.signal,
        }),
    );
    assert.equal(calls.classified.length, 2);
});

test("a result without answers falls back", async () => {
    const { ctx } = fakeCtx({ result: { answers: {} } });

    const actual = await failedChoice(ctx);

    assert.match(actual.error, /gave no valid tier/);
});

test("a failed classifier falls back even when the start set the thinking", async () => {
    const { ctx } = fakeCtx({ classifiers: [] });

    const actual = await failedChoice(ctx, { thinkingSet: true });

    assert.equal(actual.classifier, "cls/judge");
});

test("a start cancelled before the request rethrows and asks nothing", async () => {
    const { ctx, calls } = fakeCtx();
    const controller = new AbortController();

    controller.abort();

    await assert.rejects(
        chooseAutoModel({
            ctx,
            settings: withTiers({ light: SMALL }),
            ...input,
            signal: controller.signal,
        }),
    );
    assert.equal(calls.classified.length, 0);
});

test("a start cancelled during the classify call rethrows instead of falling back", async () => {
    const controller = new AbortController();
    const { ctx } = fakeCtx({
        onClassify: () => controller.abort(),
        classifyError: new Error("aborted"),
    });

    await assert.rejects(
        chooseAutoModel({
            ctx,
            settings: withTiers({ light: SMALL }),
            ...input,
            signal: controller.signal,
        }),
        /aborted/,
    );
});

test("a start cancelled while the classify call still succeeds rethrows", async () => {
    const controller = new AbortController();
    const { ctx } = fakeCtx({ onClassify: () => controller.abort() });

    await assert.rejects(
        chooseAutoModel({
            ctx,
            settings: withTiers({ light: SMALL }),
            ...input,
            signal: controller.signal,
        }),
    );
});

test("the request carries the task, access, tools and workspace, and no agent without a definition", async () => {
    const { ctx, calls } = fakeCtx();

    await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL }),
        task: "Find callers of foo",
        tools: ["read", "grep"],
        isolation: "worktree",
        thinkingSet: false,
    });

    assert.deepEqual(calls.classified[0]!.request.state, {
        task: "Find callers of foo",
        access: "read-only",
        tools: ["read", "grep"],
        workspace: "its own Git worktree",
    });
});

/** Questions of a realistic size; the budget counts whatever questions the request carries. */
const QUESTIONS = {
    tier: { type: "choice", instructions: "Rate it.", criteria: { light: "x".repeat(2_000) } },
} as unknown as Parameters<typeof autoModelRequest>[2];

const classifierOf = (contextWindow: number, api = "typesafe-system-one") =>
    ({ provider: "cls", id: "judge", api, contextWindow }) as unknown as Parameters<
        typeof autoModelRequest
    >[1];
const requestOf = (
    request: Parameters<typeof autoModelRequest>[0],
    classifier: Parameters<typeof autoModelRequest>[1],
) => autoModelRequest(request, classifier, QUESTIONS);

/** The JSON size of a request in UTF-8 bytes, which is what the classifier's window must hold. */
const bytesOf = (request: unknown) => Buffer.byteLength(JSON.stringify(request));

/** The documented limit, written out independently of the implementation. */
const limitOf = (contextWindow: number, api = "typesafe-system-one") =>
    Math.min(32_768, Math.floor((contextWindow - 512) / (api === "llama-cpp-classify" ? 2 : 1)));

const taskOf = (request: { state: unknown }) => (request.state as { task: string }).task;
/** A surrogate half without its partner. */
const hasLoneSurrogate = (text: string) =>
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
const NOTE = /\n\[(\d+) characters not shown\]\n/;

test("the access text follows the edit and command tools", () => {
    const access = (tools: string[]) =>
        requestOf({ ...input, tools }, classifierOf(8_192)).state as { access: string };

    assert.equal(access(["read", "edit", "bash"]).access, "can edit files and run commands");
    assert.equal(access(["write"]).access, "can edit files");
    assert.equal(access(["read", "bash"]).access, "can run commands");
    assert.equal(access(["read", "grep"]).access, "read-only");
    assert.equal(access([]).access, "read-only");
});

test("without a tool selection the request names the default tools and has no access", () => {
    const request = requestOf(input, classifierOf(8_192));

    assert.deepEqual(request.state, {
        task: "Find callers of foo",
        tools: "the default tool selection",
        workspace: "the user's working directory",
    });
});

test("an agent definition adds its name, description and instructions to the state", () => {
    const request = requestOf(
        {
            ...input,
            definition: definition("reviewer", {
                description: "Reviews diffs.",
                body: "You review.",
            }),
        },
        classifierOf(8_192),
    );

    assert.deepEqual((request.state as { agent: unknown }).agent, {
        name: "reviewer",
        description: "Reviews diffs.",
        instructions: "You review.",
    });
    assert.equal((request.state as { tools: unknown }).tools, "the default tool selection");
});

test("a short task and short instructions are sent whole", () => {
    const request = requestOf(
        { ...input, definition: definition("reviewer", { body: "Review the diff." }) },
        classifierOf(8_192),
    );

    assert.equal(taskOf(request), "Find callers of foo");
    assert.equal(
        (request.state as { agent: { instructions: string } }).agent.instructions,
        "Review the diff.",
    );
});

test("the request never has more JSON bytes than the classifier's limit, whatever the text", () => {
    const texts: Record<string, string> = {
        ascii: "Refactor the module. ".repeat(6_000),
        cjk: "请重构这个模块并补充测试。".repeat(6_000),
        emoji: "👍🏽🚀".repeat(20_000),
        escapes: 'say "hi" \\ path\nnext line\t'.repeat(6_000),
    };
    const windows: Array<[number, string]> = [
        [262_144, "typesafe-system-one"],
        [16_384, "typesafe-system-one"],
        [4_096, "typesafe-system-one"],
        [8_192, "llama-cpp-classify"],
    ];

    for (const [window, api] of windows) {
        for (const [name, task] of Object.entries(texts)) {
            const request = requestOf(
                {
                    ...input,
                    task,
                    definition: definition("reviewer", { body: `${name} `.repeat(8_000) }),
                },
                classifierOf(window, api),
            );

            const actual = bytesOf(request);

            assert.ok(
                actual <= limitOf(window, api),
                `${name} at ${window} ${api}: ${actual} bytes over ${limitOf(window, api)}`,
            );
            assert.ok(taskOf(request).length > 0);
        }
    }
});

test("a very large window is capped at 32 KB", () => {
    const task = "word ".repeat(30_000);

    const huge = requestOf({ ...input, task }, classifierOf(10_000_000));
    const large = requestOf({ ...input, task }, classifierOf(262_144));

    assert.ok(bytesOf(huge) <= 32_768);
    assert.ok(bytesOf(huge) > 32_768 - 512);
    assert.equal(taskOf(huge), taskOf(large));
});

test("the llama.cpp API gets half the room of another API with the same window", () => {
    const task = "word ".repeat(10_000);
    const classifier = (api: string) => classifierOf(16_384, api);

    const other = requestOf({ ...input, task }, classifier("typesafe-system-one"));
    const llama = requestOf({ ...input, task }, classifier("llama-cpp-classify"));

    assert.ok(bytesOf(llama) <= limitOf(16_384, "llama-cpp-classify"));
    assert.ok(bytesOf(other) <= limitOf(16_384));
    assert.ok(taskOf(llama).length > taskOf(other).length * 0.4);
    assert.ok(taskOf(llama).length < taskOf(other).length * 0.6);
});

test("a cut task keeps its start and its end around a note that counts the code points left out", () => {
    const original = `START-GOAL ${"😀 filler 中文 ".repeat(8_000)} END-DELIVER`;

    const task = taskOf(requestOf({ ...input, task: original }, classifierOf(16_384)));
    const note = NOTE.exec(task);

    assert.ok(note, "the note is present");
    assert.ok(task.startsWith("START-GOAL "));
    assert.ok(task.endsWith(" END-DELIVER"));
    assert.ok(!hasLoneSurrogate(task), "no lone surrogate");

    const kept = [...task].length - [...note[0]].length;
    const expected = [...original].length;
    const actual = kept + Number(note[1]);

    assert.equal(actual, expected);
});

test("a cut keeps about three quarters of the text from the start", () => {
    const original = `${"a".repeat(30_000)}${"b".repeat(30_000)}`;

    const task = taskOf(requestOf({ ...input, task: original }, classifierOf(16_384)));
    const [start, end] = task.split(NOTE.exec(task)![0]);
    const share = start!.length / (start!.length + end!.length);

    assert.ok(share > 0.72 && share < 0.78, `start share was ${share}`);
});

test("cutting never splits a surrogate pair, at every cut position", () => {
    for (let offset = 0; offset < 4; offset++) {
        const original = `${"x".repeat(offset)}${"😀".repeat(20_000)}`;

        const task = taskOf(requestOf({ ...input, task: original }, classifierOf(4_096)));

        assert.ok(!hasLoneSurrogate(task), `offset ${offset}`);
        assert.ok(NOTE.test(task));
    }
});

test("the instructions get at most a quarter of the room when the task is long", () => {
    const window = 16_384;
    const room = limitOf(window) - bytesOf(fixedRequest(window));

    const request = requestOf(
        {
            ...input,
            task: "t".repeat(100_000),
            definition: definition("reviewer", { body: "i".repeat(100_000) }),
        },
        classifierOf(window),
    );
    const instructions = (request.state as { agent: { instructions: string } }).agent.instructions;

    assert.ok(instructions.length <= Math.floor(room / 4), `${instructions.length} of ${room}`);
    assert.ok(instructions.length > room / 4 - 100);
    assert.ok(bytesOf(request) <= limitOf(window));
});

test("the instructions get more than a quarter of the room when the task is short", () => {
    const window = 16_384;
    const room = limitOf(window) - bytesOf(fixedRequest(window));
    const task = "short task";

    const request = requestOf(
        {
            ...input,
            task,
            definition: definition("reviewer", { body: "i".repeat(100_000) }),
        },
        classifierOf(window),
    );
    const instructions = (request.state as { agent: { instructions: string } }).agent.instructions;

    assert.equal(taskOf(request), task);
    assert.ok(instructions.length > room / 2, `${instructions.length} of ${room}`);
    assert.ok(bytesOf(request) <= limitOf(window));
});

/** The request without a task and instructions, whose size the room is measured against. */
function fixedRequest(window: number) {
    return requestOf(
        { ...input, task: "", definition: definition("reviewer", { body: "" }) },
        classifierOf(window),
    );
}

test("a window with too little room fails when the text does not fit, and not when it does", () => {
    // The fixed part of the request leaves under 1,024 bytes of room at this window.
    const small = classifierOf(6_000, "llama-cpp-classify");

    assert.throws(
        () => requestOf({ ...input, task: "long ".repeat(2_000) }, small),
        /The auto classifier cls\/judge has a context window of 6000 tokens, too small for this task/,
    );
    assert.equal(taskOf(requestOf(input, small)), "Find callers of foo");
});

test("the classifier from the registry sets the request limit of an auto start", async () => {
    const task = "word ".repeat(10_000);
    const { ctx, calls } = fakeCtx();

    await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL }),
        ...input,
        task,
    });

    assert.ok(bytesOf(calls.classified[0]!.request) <= limitOf(8_000));
    assert.ok(taskOf(calls.classified[0]!.request).length < task.length);
});

test("a classifier window that is too small falls back without any classify call", async () => {
    const { ctx, calls } = fakeCtx({
        classifiers: [{ ...CLASSIFIER, contextWindow: 4_096, api: "llama-cpp-classify" }],
    });

    const actual = await failedChoice(ctx, { task: "long ".repeat(2_000) });

    assert.match(
        actual.error,
        /The auto classifier cls\/judge has a context window of 4096 tokens, too small for this task/,
    );
    assert.equal(calls.classified.length, 0);
});

// High-risk routing. The fake classifier's answers stand in for its judgment: these tests cover
// what the code does with the answers, not whether the classifier judges a task correctly.

const ROUTED = { light: SMALL, standard: FREE, complex: BIG, deep: XBIG };

/** The routing of one task with the given tier and risk answers; the thinking is set. */
async function routed(options: {
    task?: string;
    tier: AutoTier;
    risk: number;
    tiers?: Partial<AutoModelSettings["tiers"]>;
    riskFloor?: AutoModelSettings["riskFloor"];
    riskThreshold?: number;
}) {
    const { ctx, calls } = fakeCtx({
        available: ALL,
        tier: { choice: options.tier, confidence: 0.9 },
        risk: options.risk,
    });
    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers(options.tiers ?? ROUTED, {
            ...("riskFloor" in options ? { riskFloor: options.riskFloor } : {}),
            ...(options.riskThreshold === undefined
                ? {}
                : { riskThreshold: options.riskThreshold }),
        }),
        ...input,
        ...(options.task === undefined ? {} : { task: options.task }),
        thinkingSet: true,
    });

    assert.ok(actual.choice.by === "rating");

    return { actual, choice: actual.choice, calls };
}

test("the first request asks a yes/no risk question next to the tier, and the thinking-only request does not", async () => {
    const { ctx, calls } = fakeCtx({ available: ALL, tier: { choice: "light", confidence: 0.9 } });

    await chooseAutoModel({
        ctx,
        settings: withTiers({ light: XBIG, deep: BIG }),
        ...input,
    });

    const [first, second] = calls.classified.map((call) => call.request.questions);

    assert.deepEqual(Object.keys(first!), ["tier", "risk"]);
    assert.equal((first!.risk as unknown as { type: string }).type, "bool");
    assert.deepEqual(Object.keys(second!), ["thinking"]);
});

test("a risk probability below the threshold is not high, at it and above it is", async () => {
    const below = await routed({ tier: "light", risk: 0.39 });
    const at = await routed({ tier: "light", risk: 0.4 });
    const above = await routed({ tier: "light", risk: 0.41 });

    assert.deepEqual(below.choice.risk, { probability: 0.39, threshold: 0.4, high: false });
    assert.deepEqual(at.choice.risk, {
        probability: 0.4,
        threshold: 0.4,
        high: true,
        floor: "deep",
    });
    assert.equal(above.choice.risk?.high, true);
    assert.deepEqual(below.actual.ref, SMALL);
    assert.deepEqual(at.actual.ref, XBIG);
    assert.deepEqual(above.actual.ref, XBIG);
});

test("the threshold comes from the settings", async () => {
    const strict = await routed({ tier: "light", risk: 0.6, riskThreshold: 0.7 });
    const loose = await routed({ tier: "light", risk: 0.2, riskThreshold: 0.1 });

    assert.equal(strict.choice.risk?.high, false);
    assert.equal(strict.choice.risk?.threshold, 0.7);
    assert.deepEqual(strict.actual.ref, SMALL);
    assert.equal(loose.choice.risk?.high, true);
    assert.deepEqual(loose.actual.ref, XBIG);
});

test("a high-risk light task gets the floor tier's model and keeps its rated tier", async () => {
    const { actual, choice } = await routed({ tier: "light", risk: 0.9 });

    assert.deepEqual(actual.ref, XBIG);
    assert.equal(choice.modelFrom, "deep");
    assert.deepEqual([choice.tier.rated, choice.tier.used], ["light", "light"]);
    assert.equal(choice.risk?.floor, "deep");
});

test("the floor can be any tier above the rated one", async () => {
    const { actual, choice } = await routed({ tier: "light", risk: 0.9, riskFloor: "complex" });

    assert.deepEqual(actual.ref, BIG);
    assert.equal(choice.modelFrom, "complex");
    assert.equal(choice.risk?.floor, "complex");
});

test("with the floor off a high-risk task keeps the model of its rated tier and records no floor", async () => {
    const { actual, choice } = await routed({ tier: "light", risk: 0.9, riskFloor: null });

    assert.deepEqual(actual.ref, SMALL);
    assert.equal(choice.modelFrom, "light");
    assert.equal(choice.risk?.high, true);
    assert.equal("floor" in choice.risk!, false);
});

test("a tier at or above the floor is not changed and records no floor", async () => {
    const cases: Array<[AutoTier, AutoModelSettings["riskFloor"], typeof BIG]> = [
        ["complex", "standard", BIG],
        ["standard", "standard", FREE],
        ["deep", "deep", XBIG],
    ];

    for (const [tier, riskFloor, ref] of cases) {
        const { actual, choice } = await routed({ tier, risk: 0.9, riskFloor });

        assert.deepEqual(actual.ref, ref, `${tier} with floor ${riskFloor}`);
        assert.equal(choice.modelFrom, tier);
        assert.equal("floor" in choice.risk!, false, `${tier} with floor ${riskFloor}`);
    }
});

test("a floor tier without a model goes up to the next tier that has one, else to the main agent", async () => {
    const up = await routed({
        tier: "light",
        risk: 0.9,
        riskFloor: "complex",
        tiers: { light: SMALL, deep: XBIG },
    });
    const toMain = await routed({
        tier: "light",
        risk: 0.9,
        riskFloor: "deep",
        tiers: { light: SMALL },
    });

    assert.deepEqual([up.choice.modelFrom, up.actual.ref], ["deep", XBIG]);
    assert.equal(up.choice.risk?.floor, "complex");
    assert.deepEqual([toMain.choice.modelFrom, toMain.actual.ref], ["main", BIG]);
    assert.equal(toMain.choice.risk?.floor, "deep");
});

test("a floor model outside the allowed set fails the start like any tier model", async () => {
    const { ctx } = fakeCtx({
        available: ALL,
        scoped: [small, big],
        tier: { choice: "light", confidence: 0.9 },
        risk: 0.9,
    });

    await assert.rejects(
        chooseAutoModel({
            ctx,
            settings: withTiers({ light: SMALL, deep: XBIG }),
            ...input,
            thinkingSet: true,
        }),
        /The deep auto tier uses prov\/xbig, which is not in the allowed set/,
    );
});

test("the risk never changes the thinking", async () => {
    const run = async (risk: number) => {
        const { ctx } = fakeCtx({
            available: ALL,
            tier: { choice: "light", confidence: 0.9 },
            thinking: { choice: "medium", confidence: 0.9 },
            risk,
        });

        return chooseAutoModel({
            ctx,
            settings: withTiers({ light: FREE, deep: BIG }),
            ...input,
        });
    };

    const calm = await run(0.05);
    const risky = await run(0.95);

    assert.equal(calm.thinking, "medium");
    assert.equal(risky.thinking, "medium");
    assert.ok(calm.choice.by === "rating" && risky.choice.by === "rating");
    assert.deepEqual(risky.choice.thinking, calm.choice.thinking);
    assert.deepEqual(calm.ref, FREE);
    assert.deepEqual(risky.ref, BIG);
});

test("a missing, mistyped or non-finite risk answer falls back to the main agent's model", async () => {
    const answers: Array<[string, unknown]> = [
        ["missing", undefined],
        ["a choice answer", { type: "choice", choice: "yes", confidence: 1, probabilities: {} }],
        ["not a number", { type: "bool", probability: Number.NaN }],
        ["infinite", { type: "bool", probability: Number.POSITIVE_INFINITY }],
    ];

    for (const [name, riskAnswer] of answers) {
        const { ctx } = fakeCtx({ available: ALL, riskAnswer });

        const actual = await chooseAutoModel({
            ctx,
            settings: withTiers({ light: SMALL, deep: XBIG }),
            ...input,
        });

        assert.ok(actual.choice.by === "classifier-failed", name);
        assert.equal(
            actual.choice.error,
            "The auto classifier cls/judge gave no valid risk.",
            name,
        );
        assert.deepEqual(actual.ref, BIG, name);
        assert.equal(actual.thinking, undefined, name);
    }
});

// The boundary table of the risk note, as routing: the answers are what a classifier is expected
// to give. The task strings are kept so a live evaluation can reuse them.
const BOUNDARY_TABLE: Array<{
    task: string;
    tier: AutoTier;
    risk: number;
    model: typeof BIG;
    modelFrom: AutoTier;
    floor?: AutoTier;
}> = [
    {
        task: "Fix the rounding rule for production payment amounts",
        tier: "light",
        risk: 0.8,
        model: XBIG,
        modelFrom: "deep",
        floor: "deep",
    },
    {
        task: "Batch-rename local symbols in the payment module",
        tier: "light",
        risk: 0.1,
        model: SMALL,
        modelFrom: "light",
    },
    {
        task: "Implement a one-off parser in a test sandbox",
        tier: "complex",
        risk: 0.05,
        model: BIG,
        modelFrom: "complex",
    },
    {
        task: "Find all references to validateToken",
        tier: "light",
        risk: 0.1,
        model: SMALL,
        modelFrom: "light",
    },
    {
        task: "Issue a vulnerability audit conclusion for an authentication service",
        tier: "deep",
        risk: 0.9,
        model: XBIG,
        modelFrom: "deep",
    },
];

for (const row of BOUNDARY_TABLE) {
    test(`boundary table: "${row.task}" is routed to the ${row.modelFrom} tier's model`, async () => {
        const { actual, choice, calls } = await routed(row);

        assert.deepEqual(actual.ref, row.model);
        assert.equal(choice.modelFrom, row.modelFrom);
        assert.equal(choice.tier.used, row.tier);
        assert.equal(choice.risk?.floor, row.floor);
        assert.equal(calls.classified[0]!.request.state.task, row.task);
    });
}
