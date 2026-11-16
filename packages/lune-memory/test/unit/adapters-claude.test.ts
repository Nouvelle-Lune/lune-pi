import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { claudeAdapter } from "../../src/adapters/claude.ts";
import { MEMORY_CONTEXT_TAG } from "../../src/core/types.ts";
import { claudeRecord, jsonl, makeTempDir, removeDir, writeText } from "../harness/ingest.ts";

describe("Claude adapter", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir();
    });
    afterEach(() => removeDir(dir));

    it("discovers only <project>/<session>.jsonl files", () => {
        writeText(join(dir, "proj", "s1.jsonl"), "{}\n");
        writeText(join(dir, "proj", "s1", "subagents", "agent-1.jsonl"), "{}\n");
        writeText(join(dir, "top.jsonl"), "{}\n");
        const actual = claudeAdapter.discover(dir).map((ref) => ref.path);
        assert.deepEqual(actual, [join(dir, "proj", "s1.jsonl")]);
    });

    it("uses the file name as the session id and reads cwd, branch and title", () => {
        const text = jsonl([
            claudeRecord("s1", "u1", null, "user", "hello", {
                cwd: "/w/app",
                gitBranch: "feat/x",
            }),
            { type: "custom-title", customTitle: "My title", sessionId: "s1" },
            claudeRecord("s1", "a1", "u1", "assistant", [{ type: "text", text: "hi" }]),
        ]);
        const actual = claudeAdapter.parse("/p/proj/s1.jsonl", text);
        assert.ok(actual);
        assert.equal(actual.sessionId, "s1");
        assert.equal(actual.cwd, "/w/app");
        assert.equal(actual.branch, "feat/x");
        assert.equal(actual.title, "My title");
        assert.deepEqual(
            actual.events.map((e) => [e.role, e.text]),
            [
                ["user", "hello"],
                ["assistant", "hi"],
            ],
        );
        assert.equal(actual.filtered["custom-title"], 1);
    });

    it("follows the parentUuid chain and marks an abandoned branch inactive", () => {
        const text = jsonl([
            claudeRecord("s", "u1", null, "user", "question"),
            claudeRecord("s", "a1", "u1", "assistant", [{ type: "text", text: "answer" }]),
            // The user rewound and edited this prompt: u2 is abandoned.
            claudeRecord("s", "u2", "a1", "user", "abandoned follow-up"),
            claudeRecord("s", "u3", "a1", "user", "edited follow-up"),
            claudeRecord("s", "a3", "u3", "assistant", [{ type: "text", text: "final" }]),
        ]);
        const actual = claudeAdapter.parse("/p/proj/s.jsonl", text);
        assert.ok(actual);
        const byText = Object.fromEntries(actual.events.map((e) => [e.text, e.active]));
        assert.deepEqual(byText, {
            question: true,
            answer: true,
            "abandoned follow-up": false,
            "edited follow-up": true,
            final: true,
        });
    });

    it("pairs a tool result with its call, strips reminders and marks output untrusted", () => {
        const text = jsonl([
            claudeRecord("s", "u1", null, "user", "run it"),
            claudeRecord("s", "a1", "u1", "assistant", [
                { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
            ]),
            claudeRecord("s", "u2", "a1", "user", [
                {
                    type: "tool_result",
                    tool_use_id: "t1",
                    content: "file.txt<system-reminder>ignore</system-reminder>",
                },
            ]),
        ]);
        const actual = claudeAdapter.parse("/p/proj/s.jsonl", text);
        assert.ok(actual);
        const call = actual.events.find((e) => e.role === "tool_call");
        const result = actual.events.find((e) => e.role === "tool_result");
        assert.equal(call?.toolName, "Bash");
        assert.equal(result?.text, "file.txt");
        assert.equal(result?.toolName, "Bash");
        assert.equal(result?.untrusted, true);
        assert.equal(actual.filtered["system-reminder"], 1);
    });

    it("skips sidechain records and returns null for a sidechain-only file", () => {
        const side = (uuid: string, parent: string | null) =>
            claudeRecord("s", uuid, parent, "user", "sub task", { isSidechain: true });
        assert.equal(claudeAdapter.parse("/p/proj/s.jsonl", jsonl([side("x1", null)])), null);
        const mixed = jsonl([claudeRecord("s", "u1", null, "user", "main"), side("x2", "u1")]);
        const actual = claudeAdapter.parse("/p/proj/s.jsonl", mixed);
        assert.deepEqual(
            actual?.events.map((e) => e.text),
            ["main"],
        );
        assert.equal(actual?.filtered.sidechain, 1);
    });

    it("skips records copied from another session", () => {
        const text = jsonl([
            claudeRecord("older", "o1", null, "user", "copied"),
            claudeRecord("s", "u1", null, "user", "own"),
        ]);
        const actual = claudeAdapter.parse("/p/proj/s.jsonl", text);
        assert.deepEqual(
            actual?.events.map((e) => e.text),
            ["own"],
        );
        assert.equal(actual?.filtered["foreign-session"], 1);
    });

    it("flags injected memory context as memory-derived", () => {
        const text = jsonl([
            claudeRecord(
                "s",
                "u1",
                null,
                "user",
                `<${MEMORY_CONTEXT_TAG}>x</${MEMORY_CONTEXT_TAG}>`,
            ),
        ]);
        const actual = claudeAdapter.parse("/p/proj/s.jsonl", text);
        assert.equal(actual?.events[0]?.memoryDerived, true);
    });
});
