import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultConfig } from "../../src/core/config.ts";
import { memoryPaths } from "../../src/core/paths.ts";
import { createDreamingModel } from "../../src/dreaming/model.ts";
import { MemoryService } from "../../src/service.ts";
import { startEndpoint } from "../harness/endpoint.ts";

const KEY = "test-key-not-real";
const MODEL_ID = "codex/gpt-6.1-sol";

function sseChunk(delta: Record<string, unknown>, finish: string | null = null): string {
    return `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
}

test("createDreamingModel streams from a custom OpenAI-compatible endpoint with the stored key", async (t) => {
    const endpoint = await startEndpoint((request) => {
        if (request.url === "/v1/models") return { json: { data: [{ id: MODEL_ID }] } };
        if (request.url === "/v1/chat/completions") {
            return {
                headers: { "content-type": "text/event-stream" },
                chunks: [
                    sseChunk({ role: "assistant", content: "Hello " }),
                    sseChunk({ content: "from the endpoint" }),
                    sseChunk({}, "stop"),
                    "data: [DONE]\n\n",
                ],
            };
        }
        return { status: 404, json: { error: `unexpected ${request.url}` } };
    });
    t.after(() => endpoint.close());

    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    const service = MemoryService.open(home);
    t.after(() => {
        service.close();
        rmSync(home, { recursive: true, force: true });
    });
    await service.addProvider({
        id: "magpie",
        api: "openai-completions",
        baseUrl: `${endpoint.url}/v1`,
        key: KEY,
    });

    const dreaming = {
        ...defaultConfig(home).dreaming,
        model: `magpie/${MODEL_ID}`,
        maxRetries: 0,
    };
    const model = createDreamingModel(dreaming, service.paths);

    const actual = await model.complete("You are a test", "Say hello");

    assert.equal(actual.text, "Hello from the endpoint");
    assert.equal(actual.usage.calls, 1);
    const completion = endpoint.requests.find((request) => request.url === "/v1/chat/completions");
    assert.ok(completion, "the endpoint received no completion request");
    assert.equal(completion.headers.authorization, `Bearer ${KEY}`);
    const body = completion.json() as { model?: string; stream?: boolean };
    assert.equal(body.model, MODEL_ID);
    assert.equal(body.stream, true);
});

test("createDreamingModel refuses to call a model when models.json itself did not load", (t) => {
    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const paths = memoryPaths(home);
    writeFileSync(paths.models, '{ "providers": ');
    const dreaming = { ...defaultConfig(home).dreaming, model: `magpie/${MODEL_ID}` };

    assert.throws(
        () => createDreamingModel(dreaming, paths),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(
                error.message,
                /^models\.json did not load, so Dreaming does not call magpie\/codex\/gpt-6\.1-sol:/u,
            );
            assert.match(error.message, /Failed to parse models\.json/u);
            assert.ok(error.message.includes(paths.models), error.message);
            return true;
        },
    );
});

test("createDreamingModel names the omitted provider and still loads the other providers", (t) => {
    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const paths = memoryPaths(home);
    writeFileSync(
        paths.models,
        JSON.stringify({
            providers: {
                magpie: {
                    baseUrl: "http://127.0.0.1:3425/v1",
                    api: "openai-completions",
                    models: [{ id: MODEL_ID, api: "made-up-api" }],
                },
                good: {
                    baseUrl: "http://127.0.0.1:3425/v1",
                    api: "openai-completions",
                    models: [{ id: "ok" }],
                },
            },
        }),
    );
    const dreaming = { ...defaultConfig(home).dreaming, model: `magpie/${MODEL_ID}` };

    assert.throws(
        () => createDreamingModel(dreaming, paths),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /^Unknown Dreaming model: magpie\/codex\/gpt-6\.1-sol/u);
            assert.match(error.message, /Provider "magpie"/u);
            assert.match(error.message, /made-up-api/u);
            return true;
        },
    );
    const other = createDreamingModel({ ...dreaming, model: "good/ok" }, paths);
    assert.equal(other.ref, "good/ok");
});

test("a streamed request of a custom provider does not follow a redirect", async (t) => {
    const other = await startEndpoint(() => ({ json: { ok: true } }));
    t.after(() => other.close());
    const endpoint = await startEndpoint((request) => {
        if (request.method === "GET") return { json: { data: [{ id: "redirect-model" }] } };
        return { status: 307, headers: { location: `${other.url}/foreign` } };
    });
    t.after(() => endpoint.close());

    const home = mkdtempSync(join(tmpdir(), "lune-memory-test-"));
    const service = MemoryService.open(home);
    t.after(() => {
        service.close();
        rmSync(home, { recursive: true, force: true });
    });
    const apis = [
        { api: "openai-completions", baseUrl: `${endpoint.url}/v1` },
        { api: "openai-responses", baseUrl: `${endpoint.url}/v1` },
        { api: "anthropic-messages", baseUrl: endpoint.url },
    ];

    for (const [index, entry] of apis.entries()) {
        const providerId = `stream-${index + 1}`;
        await service.addProvider({
            id: providerId,
            api: entry.api,
            baseUrl: entry.baseUrl,
            key: KEY,
        });
        const model = service.models().getModel(providerId, "redirect-model");
        assert.ok(model, `${entry.api}: the scanned model did not load`);

        const result = await service
            .models()
            .completeSimple(
                model,
                { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
                { signal: AbortSignal.timeout(10_000) },
            );

        assert.equal(result.stopReason, "error", entry.api);
    }
    assert.equal(
        endpoint.requests.filter((request) => request.method === "POST").length,
        apis.length,
        "every protocol sent its stream request",
    );
    assert.deepEqual(other.requests, []);
});
