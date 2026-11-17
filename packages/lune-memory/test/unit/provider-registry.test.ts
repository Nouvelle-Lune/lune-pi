import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { memoryPaths, type MemoryPaths } from "../../src/core/paths.ts";
import { loadModelRegistry } from "../../src/dreaming/providers/registry.ts";

const KEY = "test-key-not-real";

interface RegistryEnv {
    paths: MemoryPaths;
    writeModels(content: unknown): void;
    writeCredentials(content: unknown): void;
}

function createEnv(t: TestContext): RegistryEnv {
    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const paths = memoryPaths(home);
    return {
        paths,
        writeModels(content) {
            const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
            writeFileSync(paths.models, text);
        },
        writeCredentials(content) {
            const text = typeof content === "string" ? content : JSON.stringify(content);
            writeFileSync(paths.credentials, text);
        },
    };
}

/** One custom provider whose base URL is never called by these tests. */
function provider(models: unknown[], extra: Record<string, unknown> = {}) {
    return {
        name: "Magpie",
        baseUrl: "http://127.0.0.1:3425/v1",
        api: "openai-completions",
        models,
        ...extra,
    };
}

test("a custom provider and its models resolve, including an id with slashes", (t) => {
    const env = createEnv(t);
    env.writeModels({
        providers: {
            magpie: provider([
                { id: "codex/gpt-6.1-sol", name: "Sol", contextWindow: 200000 },
                { id: "auto" },
            ]),
        },
    });

    const { models, error } = loadModelRegistry(env.paths);

    assert.equal(error, undefined);
    const actual = models.getModel("magpie", "codex/gpt-6.1-sol");
    assert.equal(actual?.provider, "magpie");
    assert.equal(actual?.id, "codex/gpt-6.1-sol");
    assert.equal(actual?.name, "Sol");
    assert.equal(actual?.api, "openai-completions");
    assert.equal(actual?.baseUrl, "http://127.0.0.1:3425/v1");
    assert.equal(actual?.contextWindow, 200000);
    assert.equal(models.getModel("magpie", "auto")?.id, "auto");
});

test("the key of a custom provider comes from credentials.json", async (t) => {
    const env = createEnv(t);
    env.writeModels({ providers: { magpie: provider([{ id: "auto" }]) } });
    env.writeCredentials({ magpie: { type: "api_key", key: KEY } });

    const { models } = loadModelRegistry(env.paths);
    const auth = await models.getAuth("magpie");

    assert.equal(auth?.auth.apiKey, KEY);
});

test("apiKey in models.json resolves from $ENV and from a !command", async (t) => {
    const env = createEnv(t);
    process.env["LUNE_TEST_PROVIDER_KEY"] = "test-env-key-not-real";
    t.after(() => delete process.env["LUNE_TEST_PROVIDER_KEY"]);

    env.writeModels({ providers: { magpie: provider([{ id: "auto" }]) } });
    const missing = loadModelRegistry(env.paths);
    assert.equal(await missing.models.getAuth("magpie"), undefined);

    env.writeModels({
        providers: { magpie: provider([{ id: "auto" }], { apiKey: "$LUNE_TEST_PROVIDER_KEY" }) },
    });
    const fromEnv = loadModelRegistry(env.paths);
    assert.equal((await fromEnv.models.getAuth("magpie"))?.auth.apiKey, "test-env-key-not-real");

    env.writeModels({
        providers: { magpie: provider([{ id: "auto" }], { apiKey: "!printf %s test-shell-key" }) },
    });
    const fromCommand = loadModelRegistry(env.paths);
    assert.equal((await fromCommand.models.getAuth("magpie"))?.auth.apiKey, "test-shell-key");
});

test("a provider that fails validation is left out and does not fall back to a built-in", (t) => {
    const env = createEnv(t);
    env.writeModels({
        providers: {
            openai: provider([{ id: "m", api: "made-up-api" }]),
            good: provider([{ id: "ok" }]),
        },
    });

    const { models, error, fileFailed } = loadModelRegistry(env.paths);

    assert.equal(fileFailed, false);
    assert.equal(models.getProvider("openai"), undefined);
    assert.equal(models.getModel("good", "ok")?.id, "ok");
    assert.match(error ?? "", /Provider "openai"/u);
    assert.match(error ?? "", /made-up-api/u);
});

test("fileFailed marks a file that did not load, and openai keeps its default endpoint", (t) => {
    const env = createEnv(t);
    env.writeModels({
        providers: {
            openai: {
                baseUrl: "https://gateway.invalid/v1",
                api: "openai-completions",
                models: [{ id: "" }],
            },
        },
    });
    const broken = loadModelRegistry(env.paths);
    const clean = loadModelRegistry(createEnv(t).paths);

    assert.equal(broken.fileFailed, true);
    assert.match(broken.error ?? "", /Invalid models\.json schema/u);
    assert.ok((broken.error ?? "").includes(env.paths.models));
    const openaiBaseUrls = broken.models.getModels("openai").map((model) => model.baseUrl);
    assert.deepEqual(
        openaiBaseUrls,
        clean.models.getModels("openai").map((model) => model.baseUrl),
    );
    assert.ok(!openaiBaseUrls.includes("https://gateway.invalid/v1"));
});

test("a models.json that does not parse loads no custom provider and reports the file", (t) => {
    const env = createEnv(t);
    env.writeModels('{ "providers": ');

    const { models, error, fileFailed } = loadModelRegistry(env.paths);

    assert.equal(fileFailed, true);
    assert.equal(models.getProvider("magpie"), undefined);
    assert.ok(models.getProvider("anthropic"), "a built-in provider still loads");
    assert.match(error ?? "", /Failed to parse models\.json/u);
    assert.ok((error ?? "").includes(env.paths.models), error ?? "");
});

test("oauth in models.json is rejected", (t) => {
    const env = createEnv(t);
    env.writeModels({
        providers: {
            magpie: {
                baseUrl: "http://127.0.0.1:3425/v1",
                api: "openai-completions",
                oauth: "radius",
            },
        },
    });

    const { models, error } = loadModelRegistry(env.paths);

    assert.equal(models.getProvider("magpie"), undefined);
    assert.match(error ?? "", /"oauth" is not supported/u);
});

test("a hand-written model URL with a query is left out without echoing the secret", (t) => {
    const env = createEnv(t);
    const secret = "sk-secret-in-model-url";
    env.writeModels({
        providers: {
            manual: provider(
                [{ id: "bad", baseUrl: `https://example.invalid/v1?api_key=${secret}` }],
                { baseUrl: "https://example.invalid/v1" },
            ),
            good: provider([{ id: "ok" }]),
        },
    });

    const { models, error } = loadModelRegistry(env.paths);

    assert.equal(models.getProvider("manual"), undefined);
    assert.equal(models.getModel("manual", "bad"), undefined);
    assert.equal(models.getModel("good", "ok")?.id, "ok");
    assert.match(error ?? "", /Provider "manual"/u);
    assert.match(error ?? "", /no query string or fragment/u);
    assert.ok(!(error ?? "").includes(secret), error ?? "");
});
