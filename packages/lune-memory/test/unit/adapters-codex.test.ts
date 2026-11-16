import assert from "node:assert/strict";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readSessionFile } from "../../src/adapters/index.ts";
import { codexAdapter, pageSessionId } from "../../src/adapters/codex.ts";
import { AdapterFormatError } from "../../src/adapters/types.ts";
import { MEMORY_CONTEXT_TAG } from "../../src/core/types.ts";
import {
    codexMessage,
    codexMeta,
    jsonl,
    makeTempDir,
    removeDir,
    writeText,
} from "../harness/ingest.ts";

describe("Codex adapter", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir();
    });
    afterEach(() => removeDir(dir));

    it("discovers rollout files, including .zst, and ignores other files", () => {
        writeText(join(dir, "2026", "01", "02", "rollout-a.jsonl"), "{}\n");
        writeText(join(dir, "2026", "01", "02", "rollout-b.jsonl.zst"), "x");
        writeText(join(dir, "2026", "01", "02", "other.jsonl"), "{}\n");
        const actual = codexAdapter
            .discover(dir)
            .map((ref) => ref.path.slice(dir.length + 1))
            .sort();
        assert.deepEqual(actual, [
            join("2026", "01", "02", "rollout-a.jsonl"),
            join("2026", "01", "02", "rollout-b.jsonl.zst"),
        ]);
    });

    it("parses messages and tool calls with their results", () => {
        const text = jsonl([
            codexMeta("c1", "/w/app", { git: { branch: "main" } }),
            codexMessage("user", "list files"),
            codexMessage("assistant", "ok"),
            {
                timestamp: "2026-01-01T00:00:02.000Z",
                type: "response_item",
                payload: {
                    type: "function_call",
                    call_id: "k1",
                    name: "shell",
                    arguments: '{"cmd": "ls"}',
                },
            },
            {
                timestamp: "2026-01-01T00:00:03.000Z",
                type: "response_item",
                payload: { type: "function_call_output", call_id: "k1", output: "a.txt" },
            },
        ]);
        const actual = codexAdapter.parse("/p/rollout-x.jsonl", text);
        assert.ok(actual);
        assert.equal(actual.sessionId, "c1");
        assert.equal(actual.cwd, "/w/app");
        assert.equal(actual.branch, "main");
        assert.deepEqual(
            actual.events.map((e) => [e.role, e.text, e.untrusted]),
            [
                ["user", "list files", false],
                ["assistant", "ok", false],
                ["tool_call", 'shell {"cmd":"ls"}', false],
                ["tool_result", "a.txt", true],
            ],
        );
        assert.equal(actual.events[3]?.toolName, "shell");
    });

    it("turns an agent_message into an untrusted tool_result", () => {
        const text = jsonl([
            codexMeta("c2", "/w"),
            {
                type: "response_item",
                payload: {
                    type: "agent_message",
                    content: [{ type: "output_text", text: "subagent report" }],
                },
            },
        ]);
        const actual = codexAdapter.parse("/p/rollout-x.jsonl", text);
        const event = actual?.events[0];
        assert.equal(event?.role, "tool_result");
        assert.equal(event?.toolName, "agent_message");
        assert.equal(event?.untrusted, true);
        assert.equal(event?.text, "subagent report");
    });

    it("skips a subagent rollout", () => {
        const text = jsonl([
            codexMeta("sub", "/w", { source: { subagent: { parent: "c1" } } }),
            codexMessage("user", "task"),
        ]);
        assert.equal(codexAdapter.parse("/p/rollout-x.jsonl", text), null);
    });

    it("drops injected context blocks but keeps the memory context tag as memory-derived", () => {
        const text = jsonl([
            codexMeta("c3", "/w"),
            codexMessage("user", "<environment_context><cwd>/w/env</cwd></environment_context>"),
            codexMessage("user", `<${MEMORY_CONTEXT_TAG}>notes</${MEMORY_CONTEXT_TAG}>`),
        ]);
        const actual = codexAdapter.parse("/p/rollout-x.jsonl", text);
        assert.equal(actual?.events.length, 1);
        assert.equal(actual?.events[0]?.memoryDerived, true);
        assert.equal(actual?.filtered.injected, 1);
    });

    it("marks events of rolled back turns inactive", () => {
        const text = jsonl([
            codexMeta("c4", "/w"),
            codexMessage("user", "turn one"),
            codexMessage("user", "turn two"),
            codexMessage("assistant", "answer two"),
            { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
        ]);
        const actual = codexAdapter.parse("/p/rollout-x.jsonl", text);
        assert.ok(actual);
        const active = actual.events.map((e) => [e.text, e.active]);
        assert.deepEqual(active, [
            ["turn one", true],
            ["turn two", false],
            ["answer two", false],
            ["Rolled back 1 turn", true],
        ]);
    });

    it("throws AdapterFormatError when the first record is not a header", () => {
        assert.throws(
            () => codexAdapter.parse("/p/rollout-x.jsonl", jsonl([codexMessage("user", "x")])),
            AdapterFormatError,
        );
    });

    it("gives each page of a paginated thread its own session id", () => {
        assert.equal(
            pageSessionId("/p/rollout-2026-01-01T00-00-00-abc.jsonl", "abc"),
            "abc~2026-01-01T00-00-00",
        );
    });

    it("reads a zstd-compressed rollout through readSessionFile", () => {
        const text = jsonl([codexMeta("c5", "/w"), codexMessage("user", "compressed")]);
        const path = join(dir, "rollout-z.jsonl.zst");
        writeText(path, zstdCompressSync(Buffer.from(text)));
        const actual = codexAdapter.parse(path, readSessionFile(path));
        assert.equal(actual?.events[0]?.text, "compressed");
    });
});

/** Texts of the user events that evidence may read as the person's own statement. */
function trustedUserTexts(
    events: ReadonlyArray<{ role: string; text: string; untrusted: boolean }>,
): string[] {
    return events
        .filter((event) => event.role === "user" && !event.untrusted)
        .map((event) => event.text);
}

/** User message with the desktop content-kind metadata of the rollout format. */
function markdownUserItem(text: string, kinds: string[]) {
    return {
        type: "response_item",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
            internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
        },
    };
}

describe("Codex source markers", () => {
    it("does not read marked project instructions as a user statement", () => {
        const text = jsonl([
            codexMeta("c1", "/w", { source: "cli", thread_source: "user" }),
            markdownUserItem("Always use tabs in every project.", ["agents_md.instructions"]),
            markdownUserItem("Question", ["user.text"]),
        ]);

        const actual = trustedUserTexts(
            codexAdapter.parse("/p/rollout-x.jsonl", text)?.events ?? [],
        );

        assert.deepEqual(actual, ["Question"]);
    });

    it("does not read the task of a subagent thread as a user statement", () => {
        const text = jsonl([
            codexMeta("agent", "/w", { source: "cli", thread_source: "subagent" }),
            codexMessage("user", "Hidden agent task"),
        ]);

        const actual = trustedUserTexts(
            codexAdapter.parse("/p/rollout-agent.jsonl", text)?.events ?? [],
        );

        assert.deepEqual(actual, []);
    });
});

describe("Codex rollback by task", () => {
    const taskEvent = (type: string) => ({ type: "event_msg", payload: { type } });
    const rollback = {
        type: "event_msg",
        payload: { type: "thread_rolled_back", num_turns: 1 },
    };
    const userFlags = (text: string) =>
        (codexAdapter.parse("/p/rollout-x.jsonl", text)?.events ?? [])
            .filter((event) => event.role === "user")
            .map((event) => [event.text, event.active]);

    it("rolls back every user message of the rolled back task", () => {
        const text = jsonl([
            codexMeta("c1", "/w"),
            taskEvent("task_started"),
            codexMessage("user", "Request"),
            codexMessage("user", "Steer"),
            taskEvent("task_complete"),
            rollback,
        ]);

        assert.deepEqual(userFlags(text), [
            ["Request", false],
            ["Steer", false],
        ]);
    });

    it("does not count a task without a user message as a rolled back turn", () => {
        const text = jsonl([
            codexMeta("c2", "/w"),
            taskEvent("task_started"),
            codexMessage("user", "Keep"),
            taskEvent("task_complete"),
            taskEvent("task_started"),
            taskEvent("turn_aborted"),
            taskEvent("task_started"),
            codexMessage("user", "Last"),
            taskEvent("task_complete"),
            rollback,
        ]);

        assert.deepEqual(userFlags(text), [
            ["Keep", true],
            ["Last", false],
        ]);
    });
});
