import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    autoModelRequest,
    chooseAutoModel,
    DEFAULT_AUTO_MODEL_SETTINGS,
    REASONING_THINKING,
    type AutoModelSettings,
} from "../../src/auto-model.ts";
import { AUTO_REASONING, AUTO_TIERS, type AutoTier } from "../../src/run/types.ts";
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
    state: Record<string, unknown>;
    questions: {
        tier: { criteria: Record<string, string> };
        reasoning: { criteria: Record<string, string> };
    };
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
        reasoning?: Answer;
        typedError?: Error;
        classifyError?: Error;
        onClassify?: () => void;
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
                options.onClassify?.();

                if (options.classifyError) throw options.classifyError;

                return {
                    stopReason: "stop",
                    answers: {
                        tier: answer(options.tier ?? { choice: "light", confidence: 0.9 }),
                        reasoning: answer(options.reasoning ?? { choice: "none", confidence: 0.9 }),
                    },
                    ...options.result,
                };
            },
        },
    } as unknown as ExtensionContext;

    return { ctx, calls };
}

const SMALL = { provider: "prov", id: "small" };
const BIG = { provider: "prov", id: "big" };
const FREE = { provider: "prov", id: "free" };

const withTiers = (tiers: Partial<AutoModelSettings["tiers"]> = {}): AutoModelSettings => ({
    classifier: CLASSIFIER,
    tiers: { ...DEFAULT_AUTO_MODEL_SETTINGS.tiers, ...tiers },
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

test("with no tier model and no thinking set the classifier still rates the reasoning", async () => {
    const { ctx, calls } = fakeCtx({ reasoning: { choice: "heavy", confidence: 0.9 } });

    const actual = await chooseAutoModel({ ctx, settings: withTiers(), ...input });

    assert.equal(calls.classified.length, 1);
    assert.deepEqual(actual.ref, { provider: "prov", id: "big" });
    assert.equal(actual.choice.by === "rating" ? actual.choice.modelFrom : undefined, "main");
    assert.equal(actual.thinking, "high");
});

test("a tier with a model runs it, and the rating keeps its shares as finite numbers only", async () => {
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
        reasoning: { choice: "light", confidence: 0.7, probabilities: { light: 0.7, none: 0.3 } },
    });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL }),
        ...input,
    });

    assert.deepEqual(actual, {
        ref: SMALL,
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
            reasoning: {
                rated: "light",
                used: "light",
                confidence: 0.7,
                probabilities: { light: 0.7, none: 0.3 },
            },
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

test("one request asks both questions with a criterion for every level", async () => {
    const { ctx, calls } = fakeCtx();

    await chooseAutoModel({ ctx, settings: withTiers({ light: SMALL }), ...input });

    const { questions } = calls.classified[0]!.request;

    assert.deepEqual(Object.keys(questions.tier.criteria), [...AUTO_TIERS]);
    assert.deepEqual(Object.keys(questions.reasoning.criteria), [...AUTO_REASONING]);
});

test("a confidence under one half moves a rating up one level and a confidence of one half does not", async () => {
    const unsure = fakeCtx({
        tier: { choice: "light", confidence: 0.4 },
        reasoning: { choice: "none", confidence: 0.49 },
    });
    const sure = fakeCtx({
        tier: { choice: "light", confidence: 0.5 },
        reasoning: { choice: "none", confidence: 0.5 },
    });
    const settings = withTiers({ light: SMALL, standard: BIG });

    const moved = await chooseAutoModel({ ctx: unsure.ctx, settings, ...input });
    const kept = await chooseAutoModel({ ctx: sure.ctx, settings, ...input });

    assert.ok(moved.choice.by === "rating" && kept.choice.by === "rating");
    assert.deepEqual(
        [moved.choice.tier.rated, moved.choice.tier.used, moved.choice.reasoning.used],
        ["light", "standard", "light"],
    );
    assert.deepEqual(moved.ref, BIG);
    assert.equal(moved.thinking, "low");
    assert.deepEqual(
        [kept.choice.tier.rated, kept.choice.tier.used, kept.choice.reasoning.used],
        ["light", "light", "none"],
    );
    assert.deepEqual(kept.ref, SMALL);
    assert.equal(kept.thinking, "minimal");
});

test("an unsure rating of the top level stays at the top level", async () => {
    const { ctx } = fakeCtx({
        tier: { choice: "deep", confidence: 0.1 },
        reasoning: { choice: "heavy", confidence: 0.1 },
    });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ deep: SMALL }),
        ...input,
    });

    assert.ok(actual.choice.by === "rating");
    assert.deepEqual([actual.choice.tier.used, actual.choice.reasoning.used], ["deep", "heavy"]);
    assert.equal(actual.thinking, "high");
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

test("each reasoning rating maps to its thinking level", async () => {
    const actual: Record<string, unknown> = {};

    for (const level of AUTO_REASONING) {
        const { ctx } = fakeCtx({ reasoning: { choice: level, confidence: 0.9 } });

        actual[level] = (
            await chooseAutoModel({ ctx, settings: withTiers({ light: SMALL }), ...input })
        ).thinking;
    }

    assert.deepEqual(actual, {
        none: "minimal",
        light: "low",
        moderate: "medium",
        heavy: "high",
    });
    assert.deepEqual(actual, REASONING_THINKING);
});

test("an explicit thinking level suppresses the rated thinking but still picks the model", async () => {
    const { ctx, calls } = fakeCtx({ reasoning: { choice: "heavy", confidence: 0.9 } });

    const actual = await chooseAutoModel({
        ctx,
        settings: withTiers({ light: SMALL }),
        ...input,
        thinkingSet: true,
    });

    assert.deepEqual(actual.ref, SMALL);
    assert.equal(actual.thinking, undefined);
    assert.equal(calls.classified.length, 1);
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
    assert.match(actual.error, /^The auto classifier cls\/judge is unavailable\./);
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

test("a reasoning answer outside the levels falls back", async () => {
    const { ctx } = fakeCtx({ reasoning: { choice: "extreme", confidence: 0.9 } });

    const actual = await failedChoice(ctx);

    assert.equal(actual.error, "The auto classifier cls/judge gave no valid reasoning rating.");
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

const classifierOf = (contextWindow: number, api = "typesafe-system-one") =>
    ({ provider: "cls", id: "judge", api, contextWindow }) as unknown as Parameters<
        typeof autoModelRequest
    >[1];

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
        autoModelRequest({ ...input, tools }, classifierOf(8_192)).state as { access: string };

    assert.equal(access(["read", "edit", "bash"]).access, "can edit files and run commands");
    assert.equal(access(["write"]).access, "can edit files");
    assert.equal(access(["read", "bash"]).access, "can run commands");
    assert.equal(access(["read", "grep"]).access, "read-only");
    assert.equal(access([]).access, "read-only");
});

test("without a tool selection the request names the default tools and has no access", () => {
    const request = autoModelRequest(input, classifierOf(8_192));

    assert.deepEqual(request.state, {
        task: "Find callers of foo",
        tools: "the default tool selection",
        workspace: "the user's working directory",
    });
});

test("an agent definition adds its name, description and instructions to the state", () => {
    const request = autoModelRequest(
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
    const request = autoModelRequest(
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
            const request = autoModelRequest(
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

    const huge = autoModelRequest({ ...input, task }, classifierOf(10_000_000));
    const large = autoModelRequest({ ...input, task }, classifierOf(262_144));

    assert.ok(bytesOf(huge) <= 32_768);
    assert.ok(bytesOf(huge) > 32_768 - 512);
    assert.equal(taskOf(huge), taskOf(large));
});

test("the llama.cpp API gets half the room of another API with the same window", () => {
    const task = "word ".repeat(10_000);
    const classifier = (api: string) => classifierOf(16_384, api);

    const other = autoModelRequest({ ...input, task }, classifier("typesafe-system-one"));
    const llama = autoModelRequest({ ...input, task }, classifier("llama-cpp-classify"));

    assert.ok(bytesOf(llama) <= limitOf(16_384, "llama-cpp-classify"));
    assert.ok(bytesOf(other) <= limitOf(16_384));
    assert.ok(taskOf(llama).length > taskOf(other).length * 0.4);
    assert.ok(taskOf(llama).length < taskOf(other).length * 0.6);
});

test("a cut task keeps its start and its end around a note that counts the code points left out", () => {
    const original = `START-GOAL ${"😀 filler 中文 ".repeat(8_000)} END-DELIVER`;

    const task = taskOf(autoModelRequest({ ...input, task: original }, classifierOf(16_384)));
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

    const task = taskOf(autoModelRequest({ ...input, task: original }, classifierOf(16_384)));
    const [start, end] = task.split(NOTE.exec(task)![0]);
    const share = start!.length / (start!.length + end!.length);

    assert.ok(share > 0.72 && share < 0.78, `start share was ${share}`);
});

test("cutting never splits a surrogate pair, at every cut position", () => {
    for (let offset = 0; offset < 4; offset++) {
        const original = `${"x".repeat(offset)}${"😀".repeat(20_000)}`;

        const task = taskOf(autoModelRequest({ ...input, task: original }, classifierOf(4_096)));

        assert.ok(!hasLoneSurrogate(task), `offset ${offset}`);
        assert.ok(NOTE.test(task));
    }
});

test("the instructions get at most a quarter of the room when the task is long", () => {
    const window = 16_384;
    const room = limitOf(window) - bytesOf(fixedRequest(window));

    const request = autoModelRequest(
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

    const request = autoModelRequest(
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
    return autoModelRequest(
        { ...input, task: "", definition: definition("reviewer", { body: "" }) },
        classifierOf(window),
    );
}

test("a window with too little room fails when the text does not fit, and not when it does", () => {
    // The fixed part of the request leaves under 1,024 bytes of room at this window.
    const small = classifierOf(6_000, "llama-cpp-classify");

    assert.throws(
        () => autoModelRequest({ ...input, task: "long ".repeat(2_000) }, small),
        /The auto classifier cls\/judge has a context window of 6000 tokens, too small for this task/,
    );
    assert.equal(taskOf(autoModelRequest(input, small)), "Find callers of foo");
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
