import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { MemoryOperationError } from "../../src/core/errors.ts";
import { MemoryService } from "../../src/service.ts";
import { startEndpoint, type EndpointRequest, type FakeEndpoint } from "../harness/endpoint.ts";

const KEY = "test-key-not-real";

interface ServiceEnv {
    service: MemoryService;
    modelsPath: string;
    credentialsPath: string;
}

function createEnv(t: TestContext): ServiceEnv {
    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    const service = MemoryService.open(home);
    t.after(() => {
        service.close();
        rmSync(home, { recursive: true, force: true });
    });
    return {
        service,
        modelsPath: join(home, "models.json"),
        credentialsPath: join(home, "credentials.json"),
    };
}

/** A service plus the endpoint that answers its model list. */
async function createEnvWithModels(
    t: TestContext,
    models: unknown[],
): Promise<{ env: ServiceEnv; endpoint: FakeEndpoint }> {
    const endpoint = await startEndpoint((request) =>
        request.url === "/v1/models"
            ? { json: { data: models } }
            : { status: 404, json: { error: `unexpected ${request.url}` } },
    );
    t.after(() => endpoint.close());
    return { env: createEnv(t), endpoint };
}

interface ModelsEntry {
    name?: string;
    baseUrl?: string;
    api?: string;
    apiKey?: string;
    compat?: unknown;
    modelOverrides?: unknown;
    models?: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

function readDocument(path: string): Record<string, unknown> & {
    providers: Record<string, ModelsEntry>;
} {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & {
        providers: Record<string, ModelsEntry>;
    };
}

function readEntry(path: string, id: string): ModelsEntry | undefined {
    return readDocument(path).providers[id];
}

function firstRequest(endpoint: FakeEndpoint): EndpointRequest {
    const [request] = endpoint.requests;
    assert.ok(request, "the endpoint received no request");
    return request;
}

test("addProvider rejects an invalid id, protocol or URL, and a duplicate", async (t) => {
    const { env, endpoint } = await createEnvWithModels(t, []);
    const baseUrl = `${endpoint.url}/v1`;
    const add = (input: Parameters<MemoryService["addProvider"]>[0]) =>
        env.service.addProvider(input);

    await assert.rejects(
        add({ id: "-bad", api: "openai-completions", baseUrl }),
        /letters, digits/u,
    );
    await assert.rejects(
        add({ id: "openai", api: "openai-completions", baseUrl }),
        /openai is a provider of pi-ai/u,
    );
    await assert.rejects(add({ id: "acme", api: "grpc", baseUrl }), /api must be one of/u);
    await assert.rejects(
        add({ id: "acme", api: "openai-completions", baseUrl: "ftp://example.com/v1" }),
        /must start with http/u,
    );
    await assert.rejects(
        add({ id: "acme", api: "openai-completions", baseUrl: "127.0.0.1:3425/v1" }),
        /Not a URL/u,
    );
    assert.equal(existsSync(env.modelsPath), false);

    await add({ id: "acme", api: "openai-completions", baseUrl, scan: false });
    await assert.rejects(
        add({ id: "acme", api: "openai-completions", baseUrl }),
        /acme exists already/u,
    );
});

test("addProvider rejects a base URL with userinfo, a query string or a fragment", async (t) => {
    const env = createEnv(t);
    const secret = "sk-secret-in-userinfo";
    const rejected: Array<[string, RegExp]> = [
        [
            `https://user:${secret}@example.invalid/v1`,
            /The base URL has no user name or password\. Give the key as the API key/u,
        ],
        [`https://example.invalid/v1?api_key=${secret}`, /no query string or fragment/u],
        ["https://example.invalid/v1#frag", /no query string or fragment/u],
        ["https://example.invalid/v1?", /no query string or fragment/u],
    ];

    for (const [baseUrl, message] of rejected) {
        await assert.rejects(
            env.service.addProvider({ id: "acme", api: "openai-completions", baseUrl }),
            (error: unknown) => {
                assert.ok(error instanceof MemoryOperationError);
                assert.match(error.message, message);
                assert.ok(!error.message.includes(secret), error.message);
                return true;
            },
        );
    }
    assert.equal(existsSync(env.modelsPath), false);
    const { providers } = await env.service.providers();
    assert.equal(
        providers.some((provider) => provider.id === "acme"),
        false,
    );
});

test("addProvider validates the key before it writes models.json", async (t) => {
    const fresh = createEnv(t);
    const secret = "sk-secret-in-key";

    await assert.rejects(
        fresh.service.addProvider({
            id: "acme",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1/v1",
            key: `${secret}\nsecond`,
        }),
        (error: unknown) => {
            assert.ok(error instanceof MemoryOperationError);
            assert.equal(error.message, "The key must be a single line");
            assert.ok(!error.message.includes(secret), error.message);
            return true;
        },
    );
    assert.equal(existsSync(fresh.modelsPath), false);

    const env = createEnv(t);
    const existingKey = "test-wqixm-zk-dyf";
    writeFileSync(
        env.modelsPath,
        JSON.stringify({
            providers: {
                existing: { baseUrl: "http://127.0.0.1:3425/v1", api: "openai-completions" },
            },
        }),
    );
    await env.service.setCredential("existing", existingKey);
    const modelsBefore = readFileSync(env.modelsPath, "utf8");
    const credentialsBefore = readFileSync(env.credentialsPath, "utf8");

    for (const [key, message] of [
        [`${secret}\nsecond`, /^The key must be a single line$/u],
        [`${secret}\u0000second`, /^The key is not a valid HTTP header value$/u],
        [`${secret}\u0007second`, /^The key is not a valid HTTP header value$/u],
    ] as const) {
        await assert.rejects(
            env.service.addProvider({
                id: "acme",
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:1/v1",
                key,
            }),
            (error: unknown) => {
                assert.ok(error instanceof MemoryOperationError);
                assert.match(error.message, message);
                assert.ok(!error.message.includes(secret), error.message);
                return true;
            },
        );
        assert.equal(readFileSync(env.modelsPath, "utf8"), modelsBefore);
        assert.equal(readFileSync(env.credentialsPath, "utf8"), credentialsBefore);
    }
    assert.deepEqual(Object.keys(readDocument(env.modelsPath).providers), ["existing"]);
    assert.ok(readFileSync(env.credentialsPath, "utf8").includes(existingKey));
});

test("addProvider stores the key in credentials.json and drops a trailing slash", async (t) => {
    const { env, endpoint } = await createEnvWithModels(t, []);

    await env.service.addProvider({
        id: "acme",
        name: "Acme",
        api: "openai-completions",
        baseUrl: `${endpoint.url}/v1/`,
        key: KEY,
        scan: false,
    });

    const modelsText = readFileSync(env.modelsPath, "utf8");
    assert.ok(!modelsText.includes(KEY), "the key stays out of models.json");
    const entry = readEntry(env.modelsPath, "acme");
    assert.ok(entry);
    assert.deepEqual(
        { name: entry.name, baseUrl: entry.baseUrl, api: entry.api },
        { name: "Acme", baseUrl: `${endpoint.url}/v1`, api: "openai-completions" },
    );
    assert.ok(readFileSync(env.credentialsPath, "utf8").includes(KEY));

    const { providers } = await env.service.providers();
    const provider = providers.find((candidate) => candidate.id === "acme");
    assert.ok(provider);
    assert.deepEqual(
        {
            custom: provider.custom,
            api: provider.api,
            baseUrl: provider.baseUrl,
            configured: provider.configured,
            models: provider.models,
        },
        {
            custom: true,
            api: "openai-completions",
            baseUrl: `${endpoint.url}/v1`,
            configured: true,
            models: [],
        },
    );
});

test("a provider is scanned on add and its models are written to models.json", async (t) => {
    const { env, endpoint } = await createEnvWithModels(t, [
        { id: "acme-1", display_name: "Acme One", context_length: 200000, reasoning: true },
        { id: "acme-2" },
    ]);

    const actual = await env.service.addProvider({
        id: "acme",
        api: "openai-completions",
        baseUrl: `${endpoint.url}/v1`,
        key: KEY,
    });

    assert.deepEqual(actual, { id: "acme", scan: { id: "acme", models: 2 }, scanError: null });
    const entry = readEntry(env.modelsPath, "acme");
    assert.ok(entry);
    assert.deepEqual(
        entry.models?.map((model) => model["id"]),
        ["acme-1", "acme-2"],
    );
    const { providers } = await env.service.providers();
    assert.deepEqual(providers.find((candidate) => candidate.id === "acme")?.models, [
        { id: "acme-1", name: "Acme One", reasoning: true, contextWindow: 200000 },
        { id: "acme-2", name: "acme-2", reasoning: false, contextWindow: 128000 },
    ]);
    assert.equal(firstRequest(endpoint).headers.authorization, `Bearer ${KEY}`);
});

test("a failed scan keeps the provider and reports the error", async (t) => {
    const endpoint = await startEndpoint(() => ({ status: 503, json: { error: "down" } }));
    t.after(() => endpoint.close());
    const env = createEnv(t);

    const actual = await env.service.addProvider({
        id: "acme",
        api: "openai-completions",
        baseUrl: `${endpoint.url}/v1`,
    });

    assert.equal(actual.scan, null);
    assert.match(actual.scanError ?? "", /HTTP 503/u);
    const { providers } = await env.service.providers();
    assert.deepEqual(providers.find((candidate) => candidate.id === "acme")?.models, []);
    assert.ok(readEntry(env.modelsPath, "acme"));
});

test("scan: false adds the provider without asking the endpoint", async (t) => {
    const { env, endpoint } = await createEnvWithModels(t, [{ id: "acme-1" }]);

    const actual = await env.service.addProvider({
        id: "acme",
        api: "openai-completions",
        baseUrl: `${endpoint.url}/v1`,
        scan: false,
    });

    assert.deepEqual(actual, { id: "acme", scan: null, scanError: null });
    assert.deepEqual(endpoint.requests, []);
    assert.deepEqual(readEntry(env.modelsPath, "acme")?.models, undefined);
});

test("scanProvider replaces models and keeps modelOverrides, compat, apiKey and unknown fields", async (t) => {
    const { env, endpoint } = await createEnvWithModels(t, [
        { id: "new-model", max_input_tokens: 100000 },
    ]);
    writeFileSync(
        env.modelsPath,
        JSON.stringify({
            $schema: "https://example.com/models.schema.json",
            providers: {
                magpie: {
                    name: "Magpie",
                    baseUrl: `${endpoint.url}/v1`,
                    api: "openai-completions",
                    apiKey: "test-file-key-not-real",
                    compat: { supportsDeveloperRole: true },
                    modelOverrides: { "old-model": { name: "Old Name" } },
                    note: "hand written",
                    models: [{ id: "old-model" }],
                },
            },
        }),
    );

    const actual = await env.service.scanProvider("magpie");

    assert.deepEqual(actual, { id: "magpie", models: 1 });
    const document = readDocument(env.modelsPath);
    assert.equal(document["$schema"], "https://example.com/models.schema.json");
    const entry = document.providers["magpie"];
    assert.ok(entry);
    assert.deepEqual(entry.models, [{ id: "new-model", contextWindow: 100000 }]);
    assert.deepEqual(
        {
            name: entry.name,
            api: entry.api,
            apiKey: entry.apiKey,
            compat: entry.compat,
            modelOverrides: entry.modelOverrides,
            note: entry.note,
        },
        {
            name: "Magpie",
            api: "openai-completions",
            apiKey: "test-file-key-not-real",
            compat: { supportsDeveloperRole: true },
            modelOverrides: { "old-model": { name: "Old Name" } },
            note: "hand written",
        },
    );
    assert.equal(firstRequest(endpoint).headers.authorization, "Bearer test-file-key-not-real");
});

test("an empty model list is an error and keeps the old models", async (t) => {
    const { env, endpoint } = await createEnvWithModels(t, []);
    writeFileSync(
        env.modelsPath,
        JSON.stringify({
            providers: {
                magpie: {
                    baseUrl: `${endpoint.url}/v1`,
                    api: "openai-completions",
                    models: [{ id: "old-model" }],
                },
            },
        }),
    );

    await assert.rejects(env.service.scanProvider("magpie"), /lists no models/u);

    assert.deepEqual(readEntry(env.modelsPath, "magpie")?.models, [{ id: "old-model" }]);
});

test("scanProvider keeps the old models when the list cannot advance", async (t) => {
    const endpoint = await startEndpoint(() => ({
        json: { data: [{ id: "scanned" }], has_more: true, last_id: "same" },
    }));
    t.after(() => endpoint.close());
    const env = createEnv(t);
    writeFileSync(
        env.modelsPath,
        JSON.stringify({
            $schema: "https://example.com/models.schema.json",
            providers: {
                magpie: {
                    name: "Magpie",
                    baseUrl: `${endpoint.url}/v1`,
                    api: "anthropic-messages",
                    apiKey: "test-file-key-not-real",
                    compat: { supportsDeveloperRole: true },
                    modelOverrides: { "old-model": { name: "Old Name" } },
                    note: "hand written",
                    models: [{ id: "old-model" }],
                },
            },
        }),
    );

    await assert.rejects(env.service.scanProvider("magpie"), /cannot advance/u);

    const document = readDocument(env.modelsPath);
    assert.equal(document["$schema"], "https://example.com/models.schema.json");
    assert.deepEqual(document.providers["magpie"], {
        name: "Magpie",
        baseUrl: `${endpoint.url}/v1`,
        api: "anthropic-messages",
        apiKey: "test-file-key-not-real",
        compat: { supportsDeveloperRole: true },
        modelOverrides: { "old-model": { name: "Old Name" } },
        note: "hand written",
        models: [{ id: "old-model" }],
    });
});

test("removeProvider rejects an unknown and a pi-ai id, and deletes the entry and the key", async (t) => {
    const { env, endpoint } = await createEnvWithModels(t, []);
    writeFileSync(
        env.modelsPath,
        JSON.stringify({
            providers: { openai: { baseUrl: `${endpoint.url}/v1`, api: "openai-completions" } },
        }),
    );

    await assert.rejects(env.service.removeProvider("nope"), /Unknown custom provider: nope/u);
    await assert.rejects(env.service.removeProvider("openai"), /openai is a provider of pi-ai/u);
    assert.ok(readEntry(env.modelsPath, "openai"));

    await env.service.addProvider({
        id: "acme",
        api: "openai-completions",
        baseUrl: `${endpoint.url}/v1`,
        key: KEY,
        scan: false,
    });
    await env.service.removeProvider("acme");

    assert.equal(readEntry(env.modelsPath, "acme"), undefined);
    assert.deepEqual(await env.service.credentials(), []);
    assert.ok(!readFileSync(env.credentialsPath, "utf8").includes(KEY));
});

test("removeProvider keeps the provider a concurrent addProvider wrote", async (t) => {
    const env = createEnv(t);
    const baseUrl = "http://127.0.0.1:1/v1";
    await env.service.addProvider({ id: "first", api: "openai-completions", baseUrl, scan: false });

    await Promise.all([
        env.service.removeProvider("first"),
        env.service.addProvider({ id: "second", api: "openai-completions", baseUrl, scan: false }),
    ]);

    assert.deepEqual(Object.keys(readDocument(env.modelsPath).providers), ["second"]);
});

test("setCredential rejects a key with a line break and an empty key removes the key", async (t) => {
    const env = createEnv(t);
    await env.service.setCredential("openai", "test-key-not-real");

    await assert.rejects(
        env.service.setCredential("openai", "first-line\nsecond-line"),
        /The key must be a single line/u,
    );

    assert.deepEqual(await env.service.credentials(), [{ providerId: "openai", type: "api_key" }]);
    assert.ok(!readFileSync(env.credentialsPath, "utf8").includes("second-line"));
    await env.service.setCredential("openai", "");
    assert.deepEqual(await env.service.credentials(), []);
});

test("providers() reports why models.json did not load", async (t) => {
    const env = createEnv(t);
    writeFileSync(env.modelsPath, '{ "providers": ');

    const { providers, error } = await env.service.providers();

    assert.match(error ?? "", /Failed to parse models\.json/u);
    assert.ok((error ?? "").includes(env.modelsPath));
    assert.ok(
        providers.some((provider) => provider.id === "anthropic" && !provider.custom),
        "the built-in providers still load",
    );
    assert.equal(
        providers.some((provider) => provider.custom),
        false,
    );
});

test("providers() leaves out a hand-written provider whose URL holds a secret", async (t) => {
    const env = createEnv(t);
    const secret = "sk-dhwuoz-in-url";
    writeFileSync(
        env.modelsPath,
        JSON.stringify({
            providers: {
                manual: {
                    baseUrl: `https://user:${secret}@example.invalid/v1`,
                    api: "openai-completions",
                },
            },
        }),
    );

    const list = await env.service.providers();

    assert.equal(
        list.providers.some((provider) => provider.id === "manual"),
        false,
    );
    assert.match(list.error ?? "", /no user name or password/u);
    assert.ok(!(list.error ?? "").includes(secret), list.error ?? "");
    assert.ok(!JSON.stringify(list).includes(secret));
});

test("the provider list follows an edit of models.json outside the service", async (t) => {
    const { env, endpoint } = await createEnvWithModels(t, [{ id: "first" }]);
    await env.service.addProvider({
        id: "magpie",
        api: "openai-completions",
        baseUrl: `${endpoint.url}/v1`,
        scan: true,
    });
    const before = await env.service.providers();
    assert.deepEqual(
        before.providers
            .find((provider) => provider.id === "magpie")
            ?.models.map((model) => model.id),
        ["first"],
    );

    const document = readDocument(env.modelsPath);
    const entry = document.providers["magpie"];
    assert.ok(entry);
    document.providers["magpie"] = { ...entry, models: [{ id: "first" }, { id: "second" }] };
    writeFileSync(env.modelsPath, JSON.stringify(document));

    const after = await env.service.providers();
    assert.deepEqual(
        after.providers
            .find((provider) => provider.id === "magpie")
            ?.models.map((model) => model.id),
        ["first", "second"],
    );
});

test("dream reports no model and the models.json error when the file did not load", async (t) => {
    const env = createEnv(t);
    const config = env.service.getConfig();
    config.dreaming.model = "magpie/auto";
    env.service.setConfig(config);
    writeFileSync(env.modelsPath, '{ "providers": ');
    // Force global work, so the pass has to resolve the configured model.
    env.service.store.setMeta("dreaming_global_retry_since", "0");

    const summary = await env.service.dream({ force: true });

    assert.equal(summary.status, "no-model");
    const errors = summary.errors.join("\n");
    assert.match(errors, /models\.json did not load, so Dreaming does not call magpie\/auto/u);
    assert.match(errors, /Failed to parse models\.json/u);
    assert.ok(errors.includes(env.modelsPath), errors);
});
