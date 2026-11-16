import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { MemoryBackend } from "../../src/client/memory-client.ts";
import type { NoteInput } from "../../src/memory/notes.ts";
import {
    callMcpTool,
    MCP_PROTOCOL_VERSIONS,
    MCP_TOOLS,
    McpConnection,
    runMcpServer,
} from "../../src/integrations/mcp.ts";
import { MemoryService } from "../../src/service.ts";
import { createTestEnv, type Json, type TestEnv } from "../harness/daemon.ts";

/** In-process backend over a real service, as the client falls back to it with no daemon. */
function backendFor(service: MemoryService, onClose: () => void = () => {}): MemoryBackend {
    return {
        l1: async (request) => service.l1(request),
        noteWrite: async (input: NoteInput) => service.noteWrite(input),
        noteUpdate: async (id, request) => service.noteUpdate(id, request),
        noteRetract: async (id, writer) => service.noteRetract(id, writer),
        search: async (request) => service.search(request),
        location: async (cwd) => service.location(cwd),
        close: async () => onClose(),
    };
}

let env: TestEnv;
let service: MemoryService;
let connection: McpConnection;
let workdir: string;

beforeEach(() => {
    env = createTestEnv();
    service = MemoryService.open(env.home);
    workdir = env.folder("work");
    connection = new McpConnection({
        backend: backendFor(service),
        harness: "claude",
        sessionId: "s-1",
        cwd: workdir,
    });
});

afterEach(() => {
    service.close();
    env.cleanup();
});

async function rpc(message: unknown): Promise<Json> {
    const line = await connection.handleLine(JSON.stringify(message));
    return line === null ? null : JSON.parse(line);
}

function call(name: string, args: unknown, id = 1) {
    return rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

describe("protocol", () => {
    it("negotiates a supported protocol version and falls back to the newest", async () => {
        const older = await rpc({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2024-11-05" },
        });
        assert.equal(older.result.protocolVersion, "2024-11-05");
        const unknown = await rpc({
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: { protocolVersion: "1999-01-01" },
        });
        assert.equal(unknown.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
        assert.equal(unknown.result.serverInfo.name, "lune-memory");
        assert.deepEqual(unknown.result.capabilities, { tools: { listChanged: false } });
    });

    it("lists exactly the MCP_TOOLS", async () => {
        const answer = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
        const names = answer.result.tools.map((tool: { name: string }) => tool.name);
        assert.deepEqual(
            names,
            MCP_TOOLS.map((tool) => tool.name),
        );
        assert.deepEqual(names, [
            "transcript_search",
            "note_write",
            "note_update",
            "note_retract",
            "memory_location",
        ]);
    });

    it("answers ping and gives no answer to a notification", async () => {
        assert.deepEqual((await rpc({ jsonrpc: "2.0", id: 7, method: "ping" })).result, {});
        assert.equal(await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
        assert.equal(await connection.handleLine("   "), null);
    });

    it("gives JSON-RPC errors for parse errors, unknown methods and bad requests", async () => {
        const parse = JSON.parse((await connection.handleLine("{bad"))!);
        assert.equal(parse.error.code, -32700);
        const method = await rpc({ jsonrpc: "2.0", id: 1, method: "nope" });
        assert.equal(method.error.code, -32601);
        const invalid = await rpc({ jsonrpc: "2.0", id: 1 });
        assert.equal(invalid.error.code, -32600);
        const emptyBatch = JSON.parse((await connection.handleLine("[]"))!);
        assert.equal(emptyBatch.error.code, -32600);
    });

    it("answers a batch in one array and skips notifications in it", async () => {
        const line = await connection.handleLine(
            JSON.stringify([
                { jsonrpc: "2.0", id: 1, method: "ping" },
                { jsonrpc: "2.0", method: "notifications/initialized" },
                { jsonrpc: "2.0", id: 2, method: "tools/list" },
            ]),
        );
        const answers = JSON.parse(line!);
        assert.deepEqual(
            answers.map((a: { id: number }) => a.id),
            [1, 2],
        );
    });
});

describe("tools/call", () => {
    it("gives -32602 for an unknown tool or malformed params", async () => {
        const unknown = await call("no_such_tool", {});
        assert.equal(unknown.error.code, -32602);
        assert.match(unknown.error.message, /Unknown tool: no_such_tool/u);
        const malformed = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: [] });
        assert.equal(malformed.error.code, -32602);
        const noName = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
        assert.equal(noName.error.code, -32602);
    });

    it("gives an error result, not a JSON-RPC error, for invalid arguments", async () => {
        const cases: Array<[string, unknown, RegExp]> = [
            ["note_write", { title: "t" }, /body must be a non-empty string/u],
            ["note_write", { title: "t", body: "b", kind: "poem" }, /kind must be one of/u],
            [
                "note_write",
                { title: "t", body: "b", sources: [{ harness: "pi" }] },
                /session_id must be/u,
            ],
            ["transcript_search", {}, /query must be a non-empty string/u],
            [
                "transcript_search",
                { query: "q", limit: 99 },
                /limit must be an integer from 1 to 50/u,
            ],
            [
                "transcript_search",
                { query: "q", since: "yesterday-ish" },
                /since must be an ISO date/u,
            ],
            ["transcript_search", { query: "q", harness: "vim" }, /harness must be one of/u],
            ["note_update", { id: "n-1" }, /title must be/u],
            ["memory_location", "text", /arguments must be an object/u],
        ];
        for (const [name, args, message] of cases) {
            const answer = await call(name, args);
            assert.equal(answer.result.isError, true, name);
            assert.match(answer.result.content[0].text, message);
        }
    });

    it("writes a note with trust inference by the connection writer", async () => {
        const answer = await call("note_write", { title: "Use pnpm", body: "The repo uses pnpm." });
        assert.equal(answer.result.isError, false);
        assert.match(answer.result.content[0].text, /^Saved note n-/u);
        assert.match(answer.result.content[0].text, /trust inference/u);

        const items = service.store.all(
            "SELECT trust, status, writer_harness, writer_session FROM items",
        );
        assert.equal(items.length, 1);
        assert.equal(items[0]?.trust, "inference");
        assert.equal(items[0]?.status, "provisional");
    });

    it("does not let the tool arguments raise the trust", async () => {
        await call("note_write", { title: "t", body: "b", trust: "user" });
        const row = service.store.get("SELECT trust FROM items");
        assert.equal(row?.trust, "inference");
    });

    it("updates and retracts a note of the same session", async () => {
        const written = await call("note_write", { title: "A", body: "one" });
        const id = /note (n-\S+):/u.exec(written.result.content[0].text)![1]!;
        const updated = await call("note_update", { id, title: "B", body: "two" });
        assert.match(updated.result.content[0].text, /^Updated note .*"B"/u);
        const retracted = await call("note_retract", { id });
        assert.match(retracted.result.content[0].text, /^Retracted note .*retired/u);
    });

    it("refuses to change a note of another session with an error result", async () => {
        const written = await call("note_write", {
            title: "A",
            body: "one",
            session_id: "s-other",
        });
        const id = /note (n-\S+):/u.exec(written.result.content[0].text)![1]!;
        const answer = await call("note_retract", { id });
        assert.equal(answer.result.isError, true);
    });

    it("searches and reports the memory location", async () => {
        const search = await call("transcript_search", { query: "needle", all_projects: true });
        assert.equal(search.result.isError, false);
        assert.equal(search.result.content[0].text, "No transcript hits for: needle");
        const location = await call("memory_location", {});
        assert.match(location.result.content[0].text, new RegExp(`Memory home: ${env.home}`, "u"));
    });

    it("callMcpTool reports an unknown tool as an error result", async () => {
        const result = await callMcpTool(
            { backend: backendFor(service), harness: null, sessionId: null, cwd: workdir },
            "ghost",
            {},
        );
        assert.equal(result.isError, true);
    });
});

describe("runMcpServer", () => {
    it("answers over streams, writes only JSON-RPC lines and closes the backend at the end", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let closed = 0;
        const chunks: string[] = [];
        output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

        const done = runMcpServer({
            input,
            output,
            backend: backendFor(service, () => (closed += 1)),
            cwd: workdir,
        });
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
        input.write("not json\n");
        input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
        await done;
        output.end();

        const lines = chunks.join("").trim().split("\n");
        const parsed = lines.map((line) => JSON.parse(line));
        assert.equal(parsed.length, 3);
        assert.ok(parsed.every((message) => message.jsonrpc === "2.0"));
        assert.ok(parsed.some((message) => message.error?.code === -32700));
        assert.ok(parsed.some((message) => message.id === 2 && message.result.tools.length === 5));
        assert.equal(closed, 1);
    });
});
