import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { createDreamingModel, parseJsonReply } from "../../src/dreaming/model.ts";
import { createDreamEnv, FAUX_REF } from "../harness/dreaming.ts";

test("createDreamingModel throws when no model is configured", (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = null;

    assert.throws(
        () => createDreamingModel(env.config.dreaming, env.paths, { models: env.models }),
        /No Dreaming model configured/u,
    );
});

test("createDreamingModel throws for a reference that is not provider/id", (t) => {
    const env = createDreamEnv(t);
    for (const bad of ["no-slash", "/missing-provider", "missing-id/"]) {
        env.config.dreaming.model = bad;
        assert.throws(
            () => createDreamingModel(env.config.dreaming, env.paths, { models: env.models }),
            /must be provider\/id/u,
            bad,
        );
    }
});

test("createDreamingModel throws for a model the registry does not know", (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = "faux-dream/missing";

    assert.throws(
        () => createDreamingModel(env.config.dreaming, env.paths, { models: env.models }),
        /Unknown Dreaming model: faux-dream\/missing/u,
    );
});

test("complete returns the trimmed text and the usage of one call", async (t) => {
    const env = createDreamEnv(t);
    env.faux.setResponses([fauxAssistantMessage([fauxText('  {"ok":'), fauxText("true}  ")])]);
    const model = createDreamingModel(env.config.dreaming, env.paths, { models: env.models });

    const actual = await model.complete("system", "user");

    assert.equal(model.ref, FAUX_REF);
    assert.equal(actual.text, '{"ok":true}');
    assert.equal(actual.usage.calls, 1);
    assert.ok((actual.usage.totalTokens ?? 0) > 0);
});

test("complete fails when the model stops for another reason than stop", async (t) => {
    const env = createDreamEnv(t);
    env.faux.setResponses([
        fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "provider down" }),
    ]);
    const model = createDreamingModel(env.config.dreaming, env.paths, { models: env.models });

    await assert.rejects(model.complete("s", "u"), /ended with error: provider down/u);
});

test("complete fails when the reply has no text", async (t) => {
    const env = createDreamEnv(t);
    env.faux.setResponses([fauxAssistantMessage([fauxText("   ")])]);
    const model = createDreamingModel(env.config.dreaming, env.paths, { models: env.models });

    await assert.rejects(model.complete("s", "u"), /returned no text/u);
});

test("parseJsonReply reads a bare object, a fenced object and an object inside text", () => {
    const expected = { a: 1 };

    assert.deepEqual(parseJsonReply('{"a":1}'), expected);
    assert.deepEqual(parseJsonReply('Here:\n```json\n{"a":1}\n```\nDone.'), expected);
    assert.deepEqual(parseJsonReply('Sure. {"a":1} Hope it helps.'), expected);
});

test("parseJsonReply rejects text without a JSON object", () => {
    for (const bad of ["no json", "[1,2]", "{broken", '"string"', ""]) {
        assert.throws(() => parseJsonReply(bad), /no JSON object/u, bad);
    }
});
