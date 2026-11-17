import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Models } from "@earendil-works/pi-ai";

import { memoryPaths } from "../../src/core/paths.ts";
import { loadModelRegistry } from "../../src/dreaming/providers/registry.ts";
import { MemoryService } from "../../src/service.ts";
import { startEndpoint, type EndpointReply, type FakeEndpoint } from "../harness/endpoint.ts";

const KEY = "test-key-not-real";
const MARKER = "sk-dhwuoz";
const UNSAFE = `${MARKER}\nsecond-line`;

interface Completion {
    stopReason: string;
    error: string;
    text: string;
}

function userContext() {
    return { messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }] };
}

/** Run a completion through the composed pi-ai provider, not a helper of the service. */
async function complete(models: Models, providerId: string, modelId = "auto"): Promise<Completion> {
    const model = models.getModel(providerId, modelId);
    assert.ok(model, `the registry has no ${providerId}/${modelId}`);
    const result = await models.completeSimple(model, userContext(), {
        signal: AbortSignal.timeout(10_000),
    });
    let text = "";
    for (const block of result.content) {
        if (block.type === "text") text += block.text;
    }
    return { stopReason: result.stopReason, error: result.errorMessage ?? "", text };
}

function composeRegistry(
    t: TestContext,
    providers: Record<string, unknown>,
    credentials?: Record<string, unknown>,
): Models {
    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const paths = memoryPaths(home);
    writeFileSync(paths.models, JSON.stringify({ providers }));
    if (credentials !== undefined) {
        writeFileSync(paths.credentials, JSON.stringify(credentials));
    }
    return loadModelRegistry(paths).models;
}

async function endpointFor(
    t: TestContext,
    handler: (request: { method: string; url: string }) => EndpointReply,
): Promise<FakeEndpoint> {
    const endpoint = await startEndpoint(handler);
    t.after(() => endpoint.close());
    return endpoint;
}

/** A rejected secret must not reach the transport and must not appear in its diagnostic. */
function assertRejected(outcome: Completion, label: string): void {
    assert.equal(outcome.stopReason, "error", `${label}: ${outcome.error}`);
    assert.ok(!outcome.error.includes(MARKER), `${label}: ${outcome.error}`);
}

function chatEvents(text: string): string[] {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 1,
            model: "model-1",
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
    return [chunk({ role: "assistant", content: text }), chunk({}, "stop"), "data: [DONE]\n\n"];
}

function responsesEvents(text: string): string[] {
    const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const item = {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text }],
    };
    return [
        event({
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, content: [] },
        }),
        event({
            type: "response.output_text.delta",
            output_index: 0,
            item_id: "msg_1",
            delta: text,
        }),
        event({ type: "response.output_item.done", output_index: 0, item }),
        event({
            type: "response.completed",
            response: {
                id: "resp_1",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
            },
        }),
    ];
}

function anthropicEvents(text: string): string[] {
    const event = (name: string, payload: unknown) =>
        `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    return [
        event("message_start", {
            type: "message_start",
            message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "model-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
            },
        }),
        event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text },
        }),
        event("content_block_stop", { type: "content_block_stop", index: 0 }),
        event("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 2 },
        }),
        event("message_stop", { type: "message_stop" }),
    ];
}

function pathOf(url: string): string {
    return new URL(url, "http://127.0.0.1").pathname;
}

test("a literal key with a line break is rejected before every protocol sends", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { ok: true } }));
    const apis = [
        { id: "completions", api: "openai-completions", baseUrl: `${endpoint.url}/v1` },
        { id: "responses", api: "openai-responses", baseUrl: `${endpoint.url}/v1` },
        { id: "messages", api: "anthropic-messages", baseUrl: endpoint.url },
    ] as const;
    const providers = Object.fromEntries(
        apis.map((entry) => [
            entry.id,
            {
                baseUrl: entry.baseUrl,
                api: entry.api,
                apiKey: UNSAFE,
                models: [{ id: "auto" }],
            },
        ]),
    );
    const models = composeRegistry(t, providers);

    for (const entry of apis) {
        assertRejected(await complete(models, entry.id), entry.api);
    }
    assert.deepEqual(endpoint.requests, []);
});

test("a stored credential with a line break is rejected before the request", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { ok: true } }));
    const models = composeRegistry(
        t,
        {
            magpie: {
                baseUrl: endpoint.url,
                api: "anthropic-messages",
                models: [{ id: "auto" }],
            },
        },
        { magpie: { type: "api_key", key: UNSAFE } },
    );

    assertRejected(await complete(models, "magpie"), "stored credential");
    assert.deepEqual(endpoint.requests, []);
});

test("an environment key with a line break is rejected before the request", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { ok: true } }));
    process.env.LUNE_TEST_UNSAFE_KEY = UNSAFE;
    t.after(() => {
        delete process.env.LUNE_TEST_UNSAFE_KEY;
    });
    const models = composeRegistry(t, {
        magpie: {
            baseUrl: `${endpoint.url}/v1`,
            api: "openai-completions",
            apiKey: "$LUNE_TEST_UNSAFE_KEY",
            models: [{ id: "auto" }],
        },
    });

    assertRejected(await complete(models, "magpie"), "environment key");
    assert.deepEqual(endpoint.requests, []);
});

test("a command key with a line break is rejected before the request", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { ok: true } }));
    const models = composeRegistry(t, {
        magpie: {
            baseUrl: `${endpoint.url}/v1`,
            api: "openai-responses",
            apiKey: `!printf '${MARKER}\\nsecond-line'`,
            models: [{ id: "auto" }],
        },
    });

    assertRejected(await complete(models, "magpie"), "command key");
    assert.deepEqual(endpoint.requests, []);
});

test("a provider header or a model header with a line break is rejected before the request", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { ok: true } }));
    const models = composeRegistry(t, {
        providerHeader: {
            baseUrl: `${endpoint.url}/v1`,
            api: "openai-completions",
            apiKey: KEY,
            headers: { "x-provider-token": UNSAFE },
            models: [{ id: "auto" }],
        },
        modelHeader: {
            baseUrl: endpoint.url,
            api: "anthropic-messages",
            apiKey: KEY,
            models: [{ id: "auto", headers: { "x-model-token": UNSAFE } }],
        },
    });

    assertRejected(await complete(models, "providerHeader"), "provider header");
    assertRejected(await complete(models, "modelHeader"), "model header");
    assert.deepEqual(endpoint.requests, []);
});

test("an invalid header name is rejected without echoing its secret", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { ok: true } }));
    const models = composeRegistry(t, {
        magpie: {
            baseUrl: `${endpoint.url}/v1`,
            api: "openai-responses",
            apiKey: KEY,
            headers: { [`x-${MARKER}\nbad`]: "value" },
            models: [{ id: "auto" }],
        },
    });

    assertRejected(await complete(models, "magpie"), "invalid header name");
    assert.deepEqual(endpoint.requests, []);
});

test("a key with a NUL character is rejected before the request", async (t) => {
    const endpoint = await endpointFor(t, () => ({ json: { ok: true } }));
    const models = composeRegistry(t, {
        magpie: {
            baseUrl: `${endpoint.url}/v1`,
            api: "openai-completions",
            apiKey: `${MARKER}\u0000second-line`,
            models: [{ id: "auto" }],
        },
    });

    assertRejected(await complete(models, "magpie"), "NUL key");
    assert.deepEqual(endpoint.requests, []);
});

async function serviceWithProvider(
    t: TestContext,
    endpoint: FakeEndpoint,
    api: "openai-completions" | "anthropic-messages",
    basePath: string,
): Promise<MemoryService> {
    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    const service = MemoryService.open(home);
    t.after(() => {
        service.close();
        rmSync(home, { recursive: true, force: true });
    });
    const added = await service.addProvider({
        id: "gw",
        api,
        baseUrl: `${endpoint.url}${basePath}`,
        key: KEY,
    });
    assert.deepEqual(added.scan, { id: "gw", models: 1 });
    return service;
}

function persistedModels(service: MemoryService): Array<Record<string, unknown>> {
    const document = JSON.parse(readFileSync(service.paths.models, "utf8")) as {
        providers: Record<string, { baseUrl: string; models: Array<Record<string, unknown>> }>;
    };
    const entry = document.providers["gw"];
    assert.ok(entry, "the scanned provider is not in models.json");
    return entry.models;
}

test("a scanned OpenAI /v1 provider sends its Anthropic model under the gateway prefix", async (t) => {
    const modelId = "claude-only";
    const endpoint = await endpointFor(t, (request) => {
        const path = pathOf(request.url);
        if (request.method === "GET" && path === "/gateway/v1/models") {
            return { json: { data: [{ id: modelId, native_endpoints: ["/v1/messages"] }] } };
        }
        if (request.method === "POST" && path === "/gateway/v1/messages") {
            return {
                headers: { "content-type": "text/event-stream" },
                chunks: anthropicEvents("Hello from Anthropic"),
            };
        }
        return { status: 404, json: { error: `unexpected ${request.method} ${request.url}` } };
    });
    const service = await serviceWithProvider(t, endpoint, "openai-completions", "/gateway/v1");

    const persisted = persistedModels(service).find((model) => model["id"] === modelId);
    assert.equal(persisted?.["api"], "anthropic-messages");

    const outcome = await complete(service.models(), "gw", modelId);

    assert.equal(outcome.stopReason, "stop", outcome.error);
    assert.equal(outcome.text, "Hello from Anthropic");
    const posts = endpoint.requests.filter((request) => request.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(pathOf(posts[0]!.url), "/gateway/v1/messages");
});

test("a scanned Anthropic-root provider sends its OpenAI model under /v1 with the gateway prefix", async (t) => {
    const modelId = "chat-only";
    const endpoint = await endpointFor(t, (request) => {
        const path = pathOf(request.url);
        if (request.method === "GET" && path === "/gateway/v1/models") {
            return {
                json: { data: [{ id: modelId, native_endpoints: ["/v1/chat/completions"] }] },
            };
        }
        if (request.method === "POST" && path === "/gateway/v1/chat/completions") {
            return {
                headers: { "content-type": "text/event-stream" },
                chunks: chatEvents("Hello from chat"),
            };
        }
        return { status: 404, json: { error: `unexpected ${request.method} ${request.url}` } };
    });
    const service = await serviceWithProvider(t, endpoint, "anthropic-messages", "/gateway");

    const persisted = persistedModels(service).find((model) => model["id"] === modelId);
    assert.equal(persisted?.["api"], "openai-completions");

    const outcome = await complete(service.models(), "gw", modelId);

    assert.equal(outcome.stopReason, "stop", outcome.error);
    assert.equal(outcome.text, "Hello from chat");
    const posts = endpoint.requests.filter((request) => request.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(pathOf(posts[0]!.url), "/gateway/v1/chat/completions");
});

test("a scanned OpenAI provider keeps its /v1 base for a Responses model", async (t) => {
    const modelId = "responses-only";
    const endpoint = await endpointFor(t, (request) => {
        const path = pathOf(request.url);
        if (request.method === "GET" && path === "/gateway/v1/models") {
            return { json: { data: [{ id: modelId, native_endpoints: ["/v1/responses"] }] } };
        }
        if (request.method === "POST" && path === "/gateway/v1/responses") {
            return {
                headers: { "content-type": "text/event-stream" },
                chunks: responsesEvents("Hello from responses"),
            };
        }
        return { status: 404, json: { error: `unexpected ${request.method} ${request.url}` } };
    });
    const service = await serviceWithProvider(t, endpoint, "openai-completions", "/gateway/v1");

    const persisted = persistedModels(service).find((model) => model["id"] === modelId);
    assert.equal(persisted?.["api"], "openai-responses");

    const outcome = await complete(service.models(), "gw", modelId);

    assert.equal(outcome.stopReason, "stop", outcome.error);
    assert.equal(outcome.text, "Hello from responses");
    const posts = endpoint.requests.filter((request) => request.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(pathOf(posts[0]!.url), "/gateway/v1/responses");
});
