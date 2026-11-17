import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { scanModels } from "../../src/dreaming/providers/scan.ts";
import {
    startEndpoint,
    type EndpointReply,
    type EndpointRequest,
    type FakeEndpoint,
} from "../harness/endpoint.ts";

const KEY = "test-key-not-real";

async function endpointFor(
    t: TestContext,
    handler: (request: EndpointRequest) => EndpointReply,
): Promise<FakeEndpoint> {
    const endpoint = await startEndpoint(handler);
    t.after(() => endpoint.close());
    return endpoint;
}

function firstRequest(endpoint: FakeEndpoint): EndpointRequest {
    const [request] = endpoint.requests;
    assert.ok(request, "the endpoint received no request");
    return request;
}

test("scanModels maps an OpenAI model list to models.json entries", async (t) => {
    const endpoint = await endpointFor(t, () => ({
        json: {
            data: [
                {
                    id: "gpt-6.1",
                    display_name: "GPT 6.1",
                    context_length: 200000,
                    max_output_tokens: 32000,
                    modalities: { input: ["text", "image"], output: ["text"] },
                    pricing: {
                        prompt: "0.0000025",
                        completion: "0.00001",
                        input_cache_read: 0.000001,
                    },
                    reasoning: true,
                    reasoning_levels: ["low", "high"],
                },
                {
                    id: "gpt-6.1-mini",
                    name: "Mini",
                    context_window: 128000,
                    max_tokens: 16000,
                    modalities: { input: ["text"], output: ["text"] },
                    reasoning: false,
                },
                {
                    id: "codex/gpt-6.1-sol",
                    display_name: "Sol",
                    max_input_tokens: 400000,
                    native_endpoints: ["/v1/responses"],
                    modalities: { output: ["text"] },
                },
            ],
        },
    }));

    const actual = await scanModels({
        api: "openai-completions",
        baseUrl: `${endpoint.url}/v1`,
        apiKey: KEY,
    });

    const expected = [
        {
            id: "gpt-6.1",
            name: "GPT 6.1",
            input: ["text", "image"],
            reasoning: true,
            thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high" },
            contextWindow: 200000,
            maxTokens: 32000,
            cost: { input: 2.5, output: 10, cacheRead: 1, cacheWrite: 0 },
        },
        {
            id: "gpt-6.1-mini",
            name: "Mini",
            input: ["text"],
            reasoning: false,
            contextWindow: 128000,
            maxTokens: 16000,
        },
        {
            id: "codex/gpt-6.1-sol",
            name: "Sol",
            api: "openai-responses",
            contextWindow: 400000,
        },
    ];
    assert.deepEqual(actual, expected);

    const request = firstRequest(endpoint);
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.headers["x-api-key"], undefined);
});

test("scanModels drops models without text output and collapses duplicate ids", async (t) => {
    const endpoint = await endpointFor(t, () => ({
        json: {
            data: [
                { id: "embed-1", modalities: { output: ["image"] } },
                { id: "dup", display_name: "First" },
                { id: "dup", display_name: "Second" },
                { display_name: "No id" },
            ],
        },
    }));

    const actual = await scanModels({ api: "openai-completions", baseUrl: endpoint.url });

    assert.deepEqual(actual, [{ id: "dup", name: "First" }]);
});

test("scanModels accepts a bare array and a models wrapper", async (t) => {
    const bare = await endpointFor(t, () => ({ json: [{ id: "bare-model" }] }));
    const wrapped = await endpointFor(t, () => ({ json: { models: [{ id: "wrapped-model" }] } }));

    const bareModels = await scanModels({ api: "openai-completions", baseUrl: bare.url });
    const wrappedModels = await scanModels({ api: "openai-completions", baseUrl: wrapped.url });

    assert.deepEqual(bareModels, [{ id: "bare-model" }]);
    assert.deepEqual(wrappedModels, [{ id: "wrapped-model" }]);
});

test("an Anthropic scan sends x-api-key and follows the pagination", async (t) => {
    const endpoint = await endpointFor(t, (request) => {
        if (request.url === "/v1/models?limit=1000") {
            return {
                json: {
                    data: [
                        {
                            id: "claude-x",
                            display_name: "Claude X",
                            max_input_tokens: 200000,
                            supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
                            capabilities: { thinking: { supported: true } },
                        },
                    ],
                    has_more: true,
                    last_id: "page-2",
                },
            };
        }
        if (request.url === "/v1/models?limit=1000&after_id=page-2") {
            return { json: { data: [{ id: "claude-y" }], has_more: false } };
        }
        return { status: 404, json: { error: `unexpected ${request.url}` } };
    });

    const actual = await scanModels({
        api: "anthropic-messages",
        baseUrl: `${endpoint.url}/`,
        apiKey: KEY,
    });

    const expected = [
        {
            id: "claude-x",
            name: "Claude X",
            reasoning: true,
            thinkingLevelMap: { minimal: null, low: "low", medium: null, high: null, max: "max" },
            contextWindow: 200000,
        },
        { id: "claude-y" },
    ];
    assert.deepEqual(actual, expected);
    assert.deepEqual(
        endpoint.requests.map((request) => request.url),
        ["/v1/models?limit=1000", "/v1/models?limit=1000&after_id=page-2"],
    );
    const [first] = endpoint.requests;
    assert.ok(first);
    assert.equal(first.headers["x-api-key"], KEY);
    assert.equal(first.headers["anthropic-version"], "2023-06-01");
    assert.equal(first.headers.authorization, undefined);
});

test("scanModels reports an HTTP error, a non-JSON body and a list that is missing", async (t) => {
    const failing = await endpointFor(t, () => ({ status: 500, json: { error: "down" } }));
    const notJson = await endpointFor(t, () => ({ body: "not json" }));
    const noList = await endpointFor(t, () => ({ json: { object: "list" } }));

    await assert.rejects(
        scanModels({ api: "openai-completions", baseUrl: failing.url }),
        /failed with HTTP 500/u,
    );
    await assert.rejects(
        scanModels({ api: "openai-completions", baseUrl: notJson.url }),
        /did not return JSON/u,
    );
    await assert.rejects(
        scanModels({ api: "openai-completions", baseUrl: noList.url }),
        /has no data array/u,
    );
});

test("a redirect error names the origin and path without the query string", async (t) => {
    const endpoint = await endpointFor(t, () => ({
        status: 302,
        headers: { location: "https://elsewhere.invalid/?api_key=sk-KEY-IN-REDIRECT#frag" },
    }));

    await assert.rejects(
        scanModels({ api: "anthropic-messages", baseUrl: endpoint.url, apiKey: KEY }),
        (error: unknown) => {
            assert.ok(error instanceof Error, "the scan did not throw an error");
            assert.ok(error.message.includes(`${endpoint.url}/v1/models`), error.message);
            assert.ok(error.message.includes("https://elsewhere.invalid/"), error.message);
            assert.ok(!error.message.includes("api_key"), error.message);
            assert.ok(!error.message.includes("sk-KEY-IN-REDIRECT"), error.message);
            assert.ok(!error.message.includes("limit=1000"), error.message);
            return true;
        },
    );
});

test("a key with a line break is rejected before the request and never echoed", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { data: [] } }));
    const secret = "sk-secret-in-key";

    for (const lineBreak of ["\n", "\r", "\0"]) {
        await assert.rejects(
            scanModels({
                api: "openai-completions",
                baseUrl: `${endpoint.url}/v1`,
                apiKey: `${secret}${lineBreak}second-line`,
            }),
            (error: unknown) => {
                assert.ok(error instanceof Error, "the scan did not throw an error");
                assert.equal(
                    error.message,
                    "The value of the Authorization header has a line break",
                );
                assert.ok(!error.message.includes(secret), error.message);
                return true;
            },
        );
    }
    assert.deepEqual(endpoint.requests, []);
});

test("scanModels does not follow a redirect, so the key never reaches the target", async (t) => {
    const target = await endpointFor(t, () => ({ json: { data: [] } }));
    const source = await endpointFor(t, () => ({
        status: 302,
        headers: { location: `${target.url}/v1/models` },
    }));

    await assert.rejects(
        scanModels({ api: "openai-completions", baseUrl: `${source.url}/v1`, apiKey: KEY }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.ok(
                error.message.includes(`redirects to ${target.url}/v1/models`),
                error.message,
            );
            return true;
        },
    );
    assert.deepEqual(target.requests, []);
});

test("an invalid HTTP header value is rejected before the request and never echoed", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { data: [] } }));
    const secret = "sk-secret-in-header";

    await assert.rejects(
        scanModels({
            api: "openai-completions",
            baseUrl: `${endpoint.url}/v1`,
            headers: { "x-token": `${secret}\u0007` },
        }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "The model list request has an invalid HTTP header");
            assert.ok(!error.message.includes(secret), error.message);
            return true;
        },
    );
    assert.deepEqual(endpoint.requests, []);
});

test("scanModels fails when the list cannot advance or exceeds 20 pages", async (t) => {
    const noCursor = await endpointFor(t, () => ({
        json: { data: [{ id: "model" }], has_more: true },
    }));
    await assert.rejects(
        scanModels({ api: "anthropic-messages", baseUrl: noCursor.url, apiKey: KEY }),
        /The model list cannot advance to its next page/u,
    );

    const repeated = await endpointFor(t, () => ({
        json: { data: [{ id: "model" }], has_more: true, last_id: "same" },
    }));
    await assert.rejects(
        scanModels({ api: "anthropic-messages", baseUrl: repeated.url, apiKey: KEY }),
        /The model list cannot advance to its next page/u,
    );
    assert.equal(repeated.requests.length, 2);

    const endless = await endpointFor(t, (request) => {
        const after = new URL(request.url, "http://127.0.0.1").searchParams.get("after_id");
        const page = after ? Number(after.replace("page-", "")) : 0;
        return {
            json: {
                data: [{ id: `model-${page}` }],
                has_more: true,
                last_id: `page-${page + 1}`,
            },
        };
    });
    await assert.rejects(
        scanModels({ api: "anthropic-messages", baseUrl: endless.url, apiKey: KEY }),
        /The model list exceeds 20 pages/u,
    );
    assert.equal(endless.requests.length, 20);
});
