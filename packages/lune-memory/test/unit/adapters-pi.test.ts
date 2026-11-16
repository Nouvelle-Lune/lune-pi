import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { piAdapter } from "../../src/adapters/pi.ts";
import { AdapterFormatError } from "../../src/adapters/types.ts";
import { MEMORY_CONTEXT_TAG } from "../../src/core/types.ts";
import {
    jsonl,
    makeTempDir,
    piHeader,
    piMessage,
    removeDir,
    writeText,
} from "../harness/ingest.ts";

describe("Pi adapter", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir();
    });
    afterEach(() => removeDir(dir));

    it("discovers session files one folder level below the root only", () => {
        writeText(join(dir, "cwd-a", "s1.jsonl"), "{}\n");
        writeText(join(dir, "cwd-a", "notes.txt"), "x");
        writeText(join(dir, "cwd-a", "runs", "run1.jsonl"), "{}\n");
        const actual = piAdapter
            .discover(dir)
            .map((ref) => ref.path)
            .sort();
        assert.deepEqual(actual, [join(dir, "cwd-a", "s1.jsonl")]);
    });

    it("returns no files for a missing root", () => {
        assert.deepEqual(piAdapter.discover(join(dir, "absent")), []);
    });

    it("parses messages, tool calls and tool results with trust flags", () => {
        const text = jsonl([
            piHeader("s1", "/work/app"),
            piMessage("m1", null, "user", "fix the bug"),
            piMessage("m2", "m1", "assistant", [
                { type: "thinking", thinking: "hmm" },
                { type: "text", text: "On it." },
                { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
            ]),
            {
                type: "message",
                id: "m3",
                parentId: "m2",
                timestamp: "2026-01-01T00:00:03.000Z",
                message: {
                    role: "toolResult",
                    toolCallId: "c1",
                    toolName: "bash",
                    content: [{ type: "text", text: "a.txt" }],
                },
            },
        ]);
        const actual = piAdapter.parse("/p/s1.jsonl", text);
        assert.ok(actual);
        assert.equal(actual.sessionId, "s1");
        assert.equal(actual.cwd, "/work/app");
        assert.deepEqual(
            actual.events.map((e) => [e.role, e.text, e.untrusted, e.active]),
            [
                ["user", "fix the bug", false, true],
                ["assistant", "On it.", false, true],
                ["tool_call", '{"command":"ls"}', false, true],
                ["tool_result", "a.txt", true, true],
            ],
        );
        assert.equal(actual.filtered.thinking, 1);
    });

    it("marks events of an abandoned branch inactive", () => {
        const text = jsonl([
            piHeader("s2", "/w"),
            piMessage("a", null, "user", "first"),
            piMessage("b", "a", "assistant", "abandoned answer"),
            piMessage("c", "a", "assistant", "kept answer"),
        ]);
        const actual = piAdapter.parse("/p/s2.jsonl", text);
        assert.ok(actual);
        const byText = Object.fromEntries(actual.events.map((e) => [e.text, e.active]));
        assert.deepEqual(byText, { first: true, "abandoned answer": false, "kept answer": true });
    });

    it("flags injected memory context as memory-derived", () => {
        const text = jsonl([
            piHeader("s3", "/w"),
            piMessage("a", null, "user", `<${MEMORY_CONTEXT_TAG}>notes</${MEMORY_CONTEXT_TAG}>`),
            piMessage("b", "a", "user", "plain"),
        ]);
        const actual = piAdapter.parse("/p/s3.jsonl", text);
        assert.deepEqual(
            actual?.events.map((e) => e.memoryDerived),
            [true, false],
        );
    });

    it("returns null for an empty file and for a subagent run file", () => {
        assert.equal(piAdapter.parse("/p/e.jsonl", ""), null);
        const run = jsonl([
            piHeader("run1", "/w"),
            {
                type: "custom",
                id: "x",
                parentId: null,
                customType: "lune-subagent-run",
                data: { runId: "run1" },
            },
        ]);
        assert.equal(piAdapter.parse("/p/run1.jsonl", run), null);
    });

    it("throws AdapterFormatError when the header is missing", () => {
        assert.throws(
            () => piAdapter.parse("/p/x.jsonl", jsonl([{ type: "message", id: "a" }])),
            AdapterFormatError,
        );
    });

    it("warns about a malformed middle line but not a partial last line", () => {
        const text = `${JSON.stringify(piHeader("s4", "/w"))}\nnot json\n${JSON.stringify(
            piMessage("a", null, "user", "hi"),
        )}\n{"type":"mess`;
        const actual = piAdapter.parse("/p/s4.jsonl", text);
        assert.ok(actual);
        assert.deepEqual(actual.warnings, ["line 2: malformed JSON"]);
        assert.equal(actual.events.length, 1);
    });
});
