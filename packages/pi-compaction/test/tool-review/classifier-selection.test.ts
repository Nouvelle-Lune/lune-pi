import test from "node:test";
import assert from "node:assert/strict";
import type { ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveClassifier } from "../../src/tool-review/classification.ts";

function classifier(id: string, api = "typesafe-system-one"): ClassifierModel<string> {
    return {
        id,
        name: id,
        api,
        provider: "typesafe",
        baseUrl: "http://localhost:0",
        input: ["text"],
        type: "classifier",
        contextWindow: 8_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}
function contextWith(models: ClassifierModel<string>[]): ExtensionContext {
    return {
        scopedModels: [],
        modelRegistry: {
            getAvailableOfType: async () => models,
            getProviderDisplayName: (provider: string) => provider,
        },
    } as unknown as ExtensionContext;
}

test("classifier selection preserves Pi catalog windows without model-specific caps", async () => {
    for (const id of ["jev-latest", "~typesafe/jev-latest", "liquid/d1", "other-model"]) {
        const model = { ...classifier(id), contextWindow: 64_000 };
        const actual = await resolveClassifier(null, contextWith([model]));
        assert.equal(actual.contextWindow, 64_000);
    }
});

test("an explicit reference resolves the exact available Pi classifier", async () => {
    const expected = classifier("jev-latest");
    const actual = await resolveClassifier(
        { provider: "typesafe", id: "jev-latest" },
        contextWith([classifier("other"), expected]),
    );
    assert.equal(actual, expected);
});

test("an unavailable fixed selection is refused without switching to another model", async () => {
    await assert.rejects(
        resolveClassifier(
            { provider: "typesafe", id: "missing" },
            contextWith([classifier("jev-latest")]),
        ),
        /missing is unavailable/,
    );
});

test("automatic selection uses the first available Pi classifier, including non-Jev APIs", async () => {
    const expected = classifier("gpt-6-luna", "openai-decisions");
    const actual = await resolveClassifier(null, contextWith([expected]));
    assert.equal(actual, expected);
    await assert.rejects(
        resolveClassifier(null, contextWith([])),
        /No classifier is available.*provider in Pi/,
    );
});
