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

    it("reconnects the preserved segment after compaction and leaves the older history inactive", () => {
        const text = jsonl([
            claudeRecord("s", "old", null, "user", "Ancient"),
            claudeRecord("s", "head", "old", "user", "Retained request"),
            claudeRecord("s", "tail", "head", "assistant", [
                { type: "text", text: "Retained answer" },
            ]),
            {
                ...claudeRecord("s", "boundary", null, "user", "unused"),
                type: "system",
                subtype: "compact_boundary",
                compactMetadata: {
                    preservedSegment: {
                        headUuid: "head",
                        tailUuid: "tail",
                        anchorUuid: "summary",
                    },
                },
            },
            claudeRecord("s", "summary", "boundary", "user", "Plan summary", {
                isCompactSummary: true,
            }),
            claudeRecord("s", "new", "summary", "user", "Continue"),
        ]);

        const actual = Object.fromEntries(
            (claudeAdapter.parse("/p/proj/s.jsonl", text)?.events ?? []).map((event) => [
                event.text,
                event.active,
            ]),
        );

        assert.deepEqual(actual, {
            Ancient: false,
            "Retained request": true,
            "Retained answer": true,
            "Plan summary": true,
            Continue: true,
        });
    });

    /** A session with a compact boundary whose logical parent is the tail of the kept records. */
    function compactSession(preserved: boolean): Record<string, boolean> {
        const text = jsonl([
            claudeRecord("s", "u1", null, "user", "Old request"),
            claudeRecord("s", "a1", "u1", "assistant", [{ type: "text", text: "Old answer" }]),
            claudeRecord("s", "u2", "a1", "user", "Kept request"),
            claudeRecord("s", "a2", "u2", "assistant", [{ type: "text", text: "Kept answer" }]),
            {
                ...claudeRecord("s", "b1", null, "user", "unused"),
                type: "system",
                subtype: "compact_boundary",
                logicalParentUuid: "a2",
                compactMetadata: preserved
                    ? { preservedSegment: { headUuid: "u2", tailUuid: "a2", anchorUuid: "s1" } }
                    : {},
            },
            claudeRecord("s", "s1", "b1", "user", "Summary of the conversation", {
                isCompactSummary: true,
            }),
            claudeRecord("s", "u3", "a2", "user", "Next request"),
            claudeRecord("s", "a3", "u3", "assistant", [{ type: "text", text: "Next answer" }]),
        ]);
        return Object.fromEntries(
            (claudeAdapter.parse("/p/proj/s.jsonl", text)?.events ?? []).map((event) => [
                event.text,
                event.active,
            ]),
        );
    }

    it("reconnects a preserved segment whose boundary also has a logical parent, without a cycle", () => {
        const actual = compactSession(true);

        assert.deepEqual(actual, {
            "Old request": false,
            "Old answer": false,
            "Kept request": true,
            "Kept answer": true,
            "Summary of the conversation": true,
            "Next request": true,
            "Next answer": true,
        });
    });

    it("walks a compact boundary without a preserved segment into the old history through its logical parent", () => {
        // The next request hangs off the kept tail, so the summary is on a side branch here.
        const actual = compactSession(false);

        assert.deepEqual(actual, {
            "Old request": true,
            "Old answer": true,
            "Kept request": true,
            "Kept answer": true,
            "Summary of the conversation": false,
            "Next request": true,
            "Next answer": true,
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
