import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { claudeAdapter } from "../../src/adapters/claude.ts";
import { codexAdapter } from "../../src/adapters/codex.ts";
import { memoryPathTest } from "../../src/adapters/common.ts";
import { piAdapter } from "../../src/adapters/pi.ts";
import type { ParseContext } from "../../src/adapters/types.ts";
import { memoryPaths } from "../../src/core/paths.ts";
import {
    codexMessage,
    codexMeta,
    jsonl,
    makeTempDir,
    piHeader,
    piMessage,
    removeDir,
} from "../harness/ingest.ts";

let dir: string;
let work: string;
let home: string;
let context: ParseContext;
beforeEach(() => {
    dir = makeTempDir();
    // The working folder is a sibling of the memory home, so `../memory/...` reaches it.
    work = join(dir, "work");
    home = join(dir, "memory");
    const paths = memoryPaths(home);
    context = {
        memoryPath: memoryPathTest([paths.views, paths.generations, paths.transcripts, paths.db]),
    };
});
afterEach(() => removeDir(dir));

/** Memory-derived flags of a tool call and its result in a Pi session. */
function piFlags(cwd: string, args: Record<string, unknown>): boolean[] {
    const text = jsonl([
        piHeader("s1", cwd),
        piMessage("m1", null, "user", "look"),
        piMessage("m2", "m1", "assistant", [
            { type: "toolCall", id: "t1", name: "bash", arguments: args },
        ]),
        {
            type: "message",
            id: "m3",
            parentId: "m2",
            timestamp: "2026-01-01T00:00:02.000Z",
            message: {
                role: "toolResult",
                toolCallId: "t1",
                toolName: "bash",
                content: [{ type: "text", text: "file content" }],
            },
        },
    ]);
    const events = piAdapter.parse("/p/cwd/s1.jsonl", text, context)?.events ?? [];
    return events.filter((e) => e.role !== "user").map((e) => e.memoryDerived);
}

describe("memory-derived tool calls with relative paths", () => {
    it("marks a call and its result that read a memory file by a path relative to the cwd", () => {
        const actual = piFlags(work, { command: "cat ../memory/views/projects/p/wiki/a.md" });

        assert.deepEqual(actual, [true, true]);
    });

    it("treats the folder after cd as a start folder for relative paths", () => {
        const actual = piFlags(work, { command: "cd ../memory/views && cat a.md" });

        assert.deepEqual(actual, [true, true]);
    });

    it("treats the workdir argument as a start folder for relative paths", () => {
        const actual = piFlags(work, { command: "cat a.md", workdir: "../memory/views" });

        assert.deepEqual(actual, [true, true]);
    });

    it("does not match a folder whose name only starts with a memory folder name", () => {
        const actual = piFlags(work, { command: "cat ../memory/views2/a.md" });

        assert.deepEqual(actual, [false, false]);
    });

    it("ignores a URL token that looks like a relative memory path", () => {
        const actual = piFlags(work, { command: "curl https://example.com/../memory/views/a.md" });

        assert.deepEqual(actual, [false, false]);
    });

    it("does not mark an absolute read outside the memory home when the cwd is the home", () => {
        const actual = piFlags(home, {
            command: `cat ${join(dir, "independent-project", "result.txt")}`,
        });

        assert.deepEqual(actual, [false, false]);
    });

    it("marks the same relative read when the cwd is the memory home itself", () => {
        const actual = piFlags(home, { command: "cat views/projects/p/wiki/a.md" });

        assert.deepEqual(actual, [true, true]);
    });

    it("Claude: a record without cwd uses the first cwd of the session records", () => {
        const base = { sessionId: "s1", timestamp: "2026-01-01T00:00:01.000Z" };
        const text = jsonl([
            {
                ...base,
                type: "user",
                uuid: "u1",
                parentUuid: null,
                cwd: work,
                message: { role: "user", content: "look" },
            },
            {
                ...base,
                type: "assistant",
                uuid: "a2",
                parentUuid: "u1",
                message: {
                    role: "assistant",
                    id: "m2",
                    content: [
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "Bash",
                            input: { command: "cat ../memory/views/a.md" },
                        },
                    ],
                },
            },
            {
                ...base,
                type: "user",
                uuid: "u3",
                parentUuid: "a2",
                message: {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "t1", content: "text" }],
                },
            },
        ]);

        const events = claudeAdapter.parse("/p/proj/s1.jsonl", text, context)?.events ?? [];

        assert.deepEqual(
            events
                .filter((e) => e.role === "tool_call" || e.role === "tool_result")
                .map((e) => e.memoryDerived),
            [true, true],
        );
    });

    it("Codex: the cwd of the latest turn_context is the start folder", () => {
        const text = jsonl([
            codexMeta("c1", join(dir, "elsewhere")),
            { type: "turn_context", payload: { cwd: work } },
            codexMessage("user", "look"),
            {
                type: "response_item",
                payload: {
                    type: "function_call",
                    call_id: "k1",
                    name: "shell",
                    arguments: JSON.stringify({
                        command: ["bash", "-lc", "cat ../memory/views/a.md"],
                    }),
                },
            },
            {
                type: "response_item",
                payload: { type: "function_call_output", call_id: "k1", output: "text" },
            },
        ]);

        const events = codexAdapter.parse("/p/rollout-x.jsonl", text, context)?.events ?? [];

        assert.deepEqual(
            events
                .filter((e) => e.role === "tool_call" || e.role === "tool_result")
                .map((e) => e.memoryDerived),
            [true, true],
        );
    });
});

describe("a text block with an unknown shape", () => {
    const badBlock = { type: "text", text: { value: "Keep this evidence" } };
    const RECORD_ERROR = /line \d+: .*unknown format/u;

    it("Pi: makes the parse fail with the record named", () => {
        const text = jsonl([
            piHeader("s1", "/w"),
            piMessage("m1", null, "user", "hi"),
            piMessage("m2", "m1", "assistant", [badBlock]),
        ]);

        assert.throws(() => piAdapter.parse("/p/cwd/s1.jsonl", text), RECORD_ERROR);
    });

    it("Claude: makes the parse fail with the record named", () => {
        const text = jsonl([
            {
                type: "user",
                uuid: "u1",
                parentUuid: null,
                sessionId: "s1",
                message: { role: "user", content: [badBlock] },
            },
        ]);

        assert.throws(() => claudeAdapter.parse("/p/proj/s1.jsonl", text), RECORD_ERROR);
    });

    it("Codex: makes the parse fail with the record named", () => {
        const text = jsonl([
            codexMeta("c1", "/w"),
            {
                type: "response_item",
                payload: { type: "message", role: "user", content: [badBlock] },
            },
        ]);

        assert.throws(() => codexAdapter.parse("/p/rollout-x.jsonl", text), RECORD_ERROR);
    });
});

describe("Codex record keys", () => {
    const timestamp = "2026-01-01T00:00:05.000Z";

    it("uses the full SHA-256 digest of the record", () => {
        const text = jsonl([codexMeta("c1", "/w"), codexMessage("user", "one", timestamp)]);

        const keys = codexAdapter.parse("/p/rollout-x.jsonl", text)?.events.map((e) => e.key) ?? [];

        assert.equal(keys.length, 1);
        assert.match(keys[0] ?? "", /^[0-9a-f]{64}(?![0-9a-f])/u);
    });

    it("gives two different records with the same timestamp different keys", () => {
        const text = jsonl([
            codexMeta("c1", "/w"),
            codexMessage("user", "one", timestamp),
            codexMessage("user", "two", timestamp),
        ]);

        const keys = codexAdapter.parse("/p/rollout-x.jsonl", text)?.events.map((e) => e.key) ?? [];

        assert.equal(new Set(keys).size, 2);
    });

    it("keeps the key of a record when another record is inserted before it", () => {
        const head = codexMeta("c1", "/w");
        const keyOf = (records: unknown[]) =>
            codexAdapter
                .parse("/p/rollout-x.jsonl", jsonl(records))
                ?.events.find((e) => e.text === "target")?.key;
        const expected = keyOf([head, codexMessage("user", "target", timestamp)]);

        const actual = keyOf([
            head,
            codexMessage("user", "inserted", timestamp),
            codexMessage("user", "target", timestamp),
        ]);

        assert.ok(expected);
        assert.equal(actual, expected);
    });
});
