import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
    ModelRegistry,
    ModelRuntime,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { modelChoices } from "../src/panel/index.ts";

function chat(id: string, provider = "chat-provider"): Model<string> {
    return {
        id,
        name: `Name ${id}`,
        api: "faux",
        provider,
        baseUrl: "http://localhost:0",
        input: ["text"],
        reasoning: false,
        contextWindow: 32000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}
function request(
    context: ExtensionContext,
    candidateScope = "all",
    signal = new AbortController().signal,
) {
    return { context, candidateScope, scope: "global" as const, values: {}, signal };
}
function fakeContext(models = [chat("first"), chat("second")]): ExtensionContext {
    return {
        scopedModels: [{ model: models[1], thinkingLevel: "high" }],
        modelRegistry: {
            getAvailable: () => models,
            getProviderDisplayName: (provider: string) => `Display ${provider}`,
            refresh: async () => ({ aborted: false, errors: new Map() }),
        },
    } as unknown as ExtensionContext;
}
async function configured(t: TestContext, providers: Record<string, unknown>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lune-model-choices-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const modelsPath = path.join(root, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers }));
    const runtime = await ModelRuntime.create({
        modelsPath,
        authPath: path.join(root, "auth.json"),
        allowModelNetwork: false,
    });
    const context = {
        modelRegistry: new ModelRegistry(runtime),
        scopedModels: [],
    } as unknown as ExtensionContext;
    return { runtime, context, modelsPath };
}
const localProvider = (models: { id: string; name?: string }[]) => ({
    "local-endpoint": {
        name: "Local Endpoint",
        baseUrl: "http://localhost:4321/v1",
        api: "openai-completions",
        apiKey: "local-test-key",
        models,
    },
});

test("model choices retain provider identity, display metadata and special consumer values", async () => {
    const context = fakeContext();
    const source = modelChoices({ specialChoices: [{ value: null, label: "Follow session" }] });
    const actual = await source.load(request(context));
    assert.deepEqual(
        actual.map((choice) => choice.value),
        [
            null,
            { provider: "chat-provider", id: "first" },
            { provider: "chat-provider", id: "second" },
        ],
    );
    assert.equal(actual[1]!.label, "first");
    assert.equal(actual[1]!.badge, "chat-provider");
    assert.match(actual[1]!.searchText!, /chat-provider\/first Name first Display chat-provider/);
    assert.match(actual[2]!.description!, /scoped thinking: high/);
    assert.equal(source.defaultScope!(context), "scoped");
    assert.equal(source.defaultScope!({ ...context, scopedModels: [] }), "all");
});

test("scoped candidates filter availability without broadening explicit empty scopes", async () => {
    const first = chat("first"),
        second = chat("second");
    const context = fakeContext([first]);
    Object.assign(context, {
        scopedModels: [
            { model: second, thinkingLevel: "off" },
            { model: first, thinkingLevel: "off" },
            { model: first, thinkingLevel: "high" },
        ],
    });
    const source = modelChoices({
        specialChoices: (_context, models) => [
            { value: null, label: `${models.length} available` },
        ],
    });
    const actual = await source.load(request(context, "scoped"));
    assert.deepEqual(
        actual.map((choice) => choice.value),
        [null, { provider: first.provider, id: first.id }],
    );
    assert.equal(actual[0]!.label, "1 available");
    assert.deepEqual(
        (await source.load(request({ ...context, scopedModels: [] }, "scoped"))).map(
            (choice) => choice.value,
        ),
        [null],
    );
    await assert.rejects(
        async () => source.load(request(context, "unknown")),
        /Invalid model candidate scope/,
    );
});

test("invalid model types and candidate ranges fail during declaration without querying Pi", () => {
    for (const options of [
        { type: null },
        { type: "audio" },
        { scopes: [] },
        { scopes: ["all", "all"] },
        { scopes: ["unknown"] },
    ])
        assert.throws(() => modelChoices(options as never), TypeError);
    assert.throws(
        () => modelChoices({ type: "classifier", scopes: ["scoped"] } as never),
        /only contain chat/,
    );
    const typeProbe = () => {
        // @ts-expect-error Classifiers cannot use Pi's chat scopes.
        modelChoices({ type: "classifier", scopes: ["scoped"] });
    };
    void typeProbe;
});

test("manual refresh passes the operation signal and reports cancellation or provider failures", async () => {
    const context = fakeContext();
    const source = modelChoices();
    const signal = new AbortController().signal;
    let received: unknown;
    Object.assign(context.modelRegistry, {
        refresh: async (options: unknown) => {
            received = options;
            return { aborted: false, errors: new Map() };
        },
    });
    await source.refresh!(request(context, "all", signal));
    assert.deepEqual(received, { signal, allowNetwork: true, force: true });
    Object.assign(context.modelRegistry, {
        refresh: async () => ({
            aborted: false,
            errors: new Map([["broken", new Error("offline")]]),
        }),
    });
    await assert.rejects(source.refresh!(request(context)), {
        name: "AggregateError",
        message: /broken: offline/,
    });
    Object.assign(context.modelRegistry, {
        refresh: async () => ({ aborted: true, errors: new Map() }),
    });
    await assert.rejects(source.refresh!(request(context)), { name: "AbortError" });
    const controller = new AbortController();
    controller.abort(new Error("cancelled by editor"));
    await assert.rejects(
        async () => source.load(request(context, "all", controller.signal)),
        /cancelled by editor/,
    );
});

test("typed discovery propagates cancellation and discards a late Pi result", async () => {
    const context = fakeContext();
    const controller = new AbortController();
    let finish!: (models: never[]) => void;
    const pending = new Promise<never[]>((resolve) => {
        finish = resolve;
    });
    let received: AbortSignal | undefined;
    Object.assign(context.modelRegistry, {
        getAvailableOfType: async (
            _type: string,
            _provider: unknown,
            options: { signal: AbortSignal },
        ) => {
            received = options.signal;
            return pending;
        },
    });
    const loading = modelChoices({ type: "classifier" }).load(
        request(context, "all", controller.signal),
    );
    assert.strictEqual(received, controller.signal);
    controller.abort(new Error("retired"));
    finish([]);
    await assert.rejects(async () => loading, /retired/);
});

test("Pi-configured custom models and built-in additions appear through the Panel helper", async (t) => {
    const { context } = await configured(t, {
        ...localProvider([{ id: "user-custom", name: "User Custom" }]),
        zai: { apiKey: "local-test-key", models: [{ id: "glm-custom", name: "My Zai" }] },
    });
    const actual = await modelChoices().load(request(context));
    assert.ok(
        actual.some(
            (choice) =>
                choice.value.provider === "local-endpoint" && choice.value.id === "user-custom",
        ),
    );
    assert.ok(
        actual.some(
            (choice) => choice.value.provider === "zai" && choice.value.id === "glm-custom",
        ),
    );
    const custom = actual.find((choice) => choice.value.id === "user-custom")!;
    assert.match(custom.description!, /User Custom · Local Endpoint/);
});

test("manual refresh rereads changed models.json without requiring a Core model cache", async (t) => {
    const { context, modelsPath } = await configured(t, localProvider([{ id: "before" }]));
    await writeFile(
        modelsPath,
        JSON.stringify({ providers: localProvider([{ id: "before" }, { id: "after" }]) }),
    );
    const source = modelChoices();
    await source.refresh!(request(context));
    assert.ok((await source.load(request(context))).some((choice) => choice.value.id === "after"));
});

test("chat models without configured credentials stay out of choices while remaining in Pi", async (t) => {
    const { context } = await configured(t, {
        keyless: {
            baseUrl: "http://localhost:4321/v1",
            api: "openai-completions",
            models: [{ id: "hidden" }],
        },
    });
    assert.ok(context.modelRegistry.getAll().some((model) => model.id === "hidden"));
    assert.equal(
        (await modelChoices().load(request(context))).some(
            (choice) => choice.value.id === "hidden",
        ),
        false,
    );
});

test("classifier choices use available typed models and honor Pi provider filtering", async (t) => {
    const { context, runtime } = await configured(t, {});
    const classifier = {
        type: "classifier" as const,
        id: "jev-latest",
        name: "Jev",
        api: "typesafe-system-one",
        baseUrl: "http://localhost:0",
        contextWindow: 32000,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    runtime.registerProvider("not-configured", { models: [classifier] });
    runtime.registerProvider("configured", {
        apiKey: "offline-test-key",
        models: [classifier, { ...classifier, id: "excluded" }],
    });
    const provider = runtime.getProvider("configured")!;
    runtime.registerNativeProvider({
        ...provider,
        filterAllModels: (models) => models.filter((model) => model.id !== "excluded"),
    });
    const actual = await modelChoices({ type: "classifier" }).load(request(context));
    assert.ok(
        actual.some(
            (choice) => choice.value.provider === "configured" && choice.value.id === "jev-latest",
        ),
    );
    assert.equal(
        actual.some(
            (choice) =>
                choice.value.provider === "not-configured" || choice.value.id === "excluded",
        ),
        false,
    );
});
