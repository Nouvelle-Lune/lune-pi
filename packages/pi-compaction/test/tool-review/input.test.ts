import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import {
    collectReviewInput,
    MAX_TOOL_RESULT_CHARS,
    TOOL_RESULT_TRUNCATION_MARKER,
    truncateToolResult,
} from "../../src/tool-review/candidates.ts";
import { assistantText, toolResult } from "../harness/fixtures.ts";

function text(message: AgentMessage): string {
    assert.equal(message.role, "toolResult");
    return contentText((message as Extract<AgentMessage, { role: "toolResult" }>).content, "");
}

test("tool results at or below the limit return their original text and message", () => {
    for (const raw of ["", "  exact\r\ntext 😀  ", "x".repeat(MAX_TOOL_RESULT_CHARS)]) {
        const message = toolResult("t", "read", raw);
        assert.equal(truncateToolResult(message), message);
        assert.equal(text(truncateToolResult(message)), raw);
    }
    const assistant = assistantText("unmodified");
    assert.equal(truncateToolResult(assistant), assistant);
});

test("oversized tool results retain both ends with one marker within the limit", () => {
    for (const length of [MAX_TOOL_RESULT_CHARS + 1, 1_000_000]) {
        const raw = `HEAD${"x".repeat(length - 8)}TAIL`;
        const message = toolResult("t", "read", raw);
        const actual = text(truncateToolResult(message));
        assert.ok(actual.startsWith("HEAD"));
        assert.ok(actual.endsWith("TAIL"));
        assert.equal(actual.split(TOOL_RESULT_TRUNCATION_MARKER).length, 2);
        assert.equal(actual.length, MAX_TOOL_RESULT_CHARS);
        assert.equal(text(message), raw);
    }
});

test("the result-wide text limit applies across blocks while media and metadata survive", () => {
    const message = toolResult("t", "read", "HEAD" + "a".repeat(4_000), {
        isError: true,
        nonText: [{ type: "image", data: "AA", mimeType: "image/png" }],
    });
    assert.equal(message.role, "toolResult");
    if (message.role !== "toolResult") throw new Error("Expected tool result");
    message.content.push({ type: "text", text: "MIDDLE_MUST_DISAPPEAR" + "b".repeat(4_000) });
    message.content.push({ type: "text", text: "c".repeat(4_000) + "TAIL" });
    message.details = { provenance: "original" };
    const snapshot = structuredClone(message);
    const actual = truncateToolResult(message);
    assert.equal(actual.role, "toolResult");
    if (actual.role !== "toolResult") throw new Error("Expected tool result");
    assert.ok(text(actual).startsWith("HEAD"));
    assert.ok(text(actual).endsWith("TAIL"));
    assert.ok(!text(actual).includes("MIDDLE_MUST_DISAPPEAR"));
    assert.ok(text(actual).length <= MAX_TOOL_RESULT_CHARS);
    assert.equal(actual.content[1], message.content[1]);
    assert.equal(actual.details, message.details);
    assert.equal(actual.isError, true);
    assert.equal(actual.timestamp, message.timestamp);
    assert.deepEqual(message, snapshot);
});

test("head and tail boundaries preserve surrogate pairs and CRLF", () => {
    const budget = MAX_TOOL_RESULT_CHARS - TOOL_RESULT_TRUNCATION_MARKER.length;
    const head = Math.ceil(budget / 2);
    const tail = Math.floor(budget / 2);
    for (const boundary of ["😀", "\r\n"]) {
        const raw =
            "a".repeat(head - 1) + boundary + "x".repeat(10_000) + boundary + "b".repeat(tail - 1);
        const actual = text(truncateToolResult(toolResult("t", "read", raw)));
        assert.equal(
            actual,
            "a".repeat(head - 1) + TOOL_RESULT_TRUNCATION_MARKER + "b".repeat(tail - 1),
        );
    }
});

test("native projection and preparation share converted messages across every region", () => {
    const history = toolResult("history", "read", "a".repeat(20_000));
    const prefix = toolResult("prefix", "read", "b".repeat(20_000));
    const retained = toolResult("retained", "read", "c".repeat(20_000));
    const messages = [history, prefix, retained];
    const projection = {
        entries: messages.map((message, index) => ({
            sourceEntry: { id: String(index), type: "message" },
            messages: [message],
        })),
        messages,
        thinkingLevel: "off",
        model: null,
    };
    const event = {
        preparation: {
            messagesToSummarize: [history],
            turnPrefixMessages: [prefix],
            firstKeptEntryId: "2",
        },
    } as unknown as SessionBeforeCompactEvent;
    const ctx = { sessionManager: { buildSessionProjection: () => projection } } as never;
    const actual = collectReviewInput(event, ctx);
    assert.equal(actual.preparation.messagesToSummarize[0], actual.projection.messages[0]);
    assert.equal(actual.preparation.turnPrefixMessages[0], actual.projection.messages[1]);
    for (let index = 0; index < messages.length; index++) {
        assert.equal(
            actual.projection.entries[index]!.messages[0],
            actual.projection.messages[index],
        );
        assert.ok(text(actual.projection.messages[index]!).length <= MAX_TOOL_RESULT_CHARS);
        assert.equal(text(messages[index]!).length, 20_000);
    }
});
