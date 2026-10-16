import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { chunkResult, type ResultChunk, type ToolPair } from "../../src/tool-review/candidates.ts";
import { applyDecisions, type ChunkDecision } from "../../src/tool-review/review.ts";
import { assistantText, assistantToolCall, toolResult, user } from "../harness/fixtures.ts";

function pairFor(text: string, description = ""): ToolPair {
    const call = assistantToolCall("t", "read", { path: "a.ts" }, description);
    const result = toolResult("t", "read", text);
    return {
        id: "t",
        toolName: "read",
        arguments: { path: "a.ts" },
        call: { region: "history", index: 1, message: call },
        result: { region: "history", index: 2, message: result },
    };
}

function decisions(
    chunks: readonly ResultChunk[],
    actions: ("keep" | "drop" | "placeholder")[],
): ChunkDecision[] {
    return chunks.map((chunk, index) =>
        actions[index] === "placeholder"
            ? { chunkId: chunk.id, action: "placeholder", reason: "classifier-context-window" }
            : {
                  chunkId: chunk.id,
                  action: actions[index] ?? "keep",
                  probability: actions[index] === "drop" ? 1 : 0,
              },
    );
}

function history(pair: ToolPair): AgentMessage[] {
    return [user("goal"), pair.call.message, pair.result.message];
}
function resultText(messages: AgentMessage[]): string {
    const result = messages.find((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    return result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

test("partial deletion preserves source ranges, metadata and the original invocation", () => {
    const pair = pairFor("aaaa\nbbbb\ncccc");
    const chunks = chunkResult(pair, 5);
    const source = history(pair);
    const original = structuredClone(source);
    const actual = applyDecisions(
        source,
        [],
        [pair],
        chunks,
        decisions(chunks, ["keep", "drop", "keep"]),
    );
    const text = resultText(actual.messagesToSummarize);
    assert.ok(text.startsWith("aaaa\n"));
    assert.ok(text.endsWith("cccc"));
    assert.ok(!text.includes("bbbb"));
    assert.match(text, /omitted UTF-16 range 5-10 \(5 code units\)/);
    assert.ok(actual.messagesToSummarize.includes(pair.call.message));
    assert.deepEqual(actual.removedCalls, []);
    assert.deepEqual(source, original);
});

test("all approved chunks remove the pair while preserving assistant text", () => {
    const pair = pairFor("aaaa\nbbbb", "kept explanation");
    const chunks = chunkResult(pair, 4);
    const actual = applyDecisions(
        history(pair),
        [],
        [pair],
        chunks,
        decisions(
            chunks,
            chunks.map(() => "drop"),
        ),
    );
    assert.deepEqual(actual.removedCalls, ["t"]);
    assert.deepEqual(
        actual.messagesToSummarize.map(({ role }) => role),
        ["user", "assistant"],
    );
    const survivor = actual.messagesToSummarize[1]!;
    assert.ok(survivor.role === "assistant");
    assert.deepEqual(survivor.content, [{ type: "text", text: "kept explanation" }]);
});

test("deleting a pair removes only its call block from a shared assistant message", () => {
    // Parallel calls share an assistant message; deleting one must not corrupt its sibling.
    const pair = pairFor("body");
    const call = pair.call.message;
    assert.ok(call.role === "assistant");
    call.content.push({ type: "toolCall", id: "other", name: "read", arguments: { path: "b.ts" } });
    const chunks = chunkResult(pair, 10);
    const actual = applyDecisions(history(pair), [], [pair], chunks, decisions(chunks, ["drop"]));
    assert.deepEqual(actual.removedCalls, ["t"]);
    const survivor = actual.messagesToSummarize[1]!;
    assert.ok(survivor.role === "assistant");
    assert.deepEqual(survivor.content, [
        { type: "toolCall", id: "other", name: "read", arguments: { path: "b.ts" } },
    ]);
});

test("empty results cannot be removed", () => {
    const empty = pairFor("");
    assert.deepEqual(applyDecisions(history(empty), [], [empty], [], []).removedCalls, []);
});

test("budget placeholders differ from model omissions and block whole-pair deletion", () => {
    const pair = pairFor("aaaa\nbbbb\ncccc");
    const chunks = chunkResult(pair, 5);
    const actual = applyDecisions(
        history(pair),
        [],
        [pair],
        chunks,
        decisions(chunks, ["placeholder", "drop", "keep"]),
    );
    const text = resultText(actual.messagesToSummarize);
    assert.match(text, /placeholder for UTF-16 range 0-5/);
    assert.match(text, /content not classified/);
    assert.match(text, /omitted UTF-16 range 5-10/);
    assert.ok(text.endsWith("cccc"));
    assert.deepEqual(actual.removedCalls, []);
});

test("applyDecisions rejects unknown, duplicate or missing decisions and duplicate calls", () => {
    const pair = pairFor("body");
    const chunks = chunkResult(pair, 10);
    const source = history(pair);
    const approved = decisions(chunks, ["drop"]);
    assert.throws(
        () =>
            applyDecisions(source, [], [pair], chunks, [
                { chunkId: "unknown", action: "keep", probability: 0 },
            ]),
        /Unknown or duplicate/,
    );
    assert.throws(
        () => applyDecisions(source, [], [pair], chunks, [...approved, ...approved]),
        /Unknown or duplicate/,
    );
    assert.throws(() => applyDecisions(source, [], [pair], chunks, []), /Missing decision/);
    assert.throws(
        () => applyDecisions(source, [], [pair, pair], chunks, approved),
        /Duplicate candidate call IDs/,
    );
});

test("applyDecisions validates exact coverage before deleting any pair", () => {
    const pair = pairFor("aaaa\nbbbb");
    const chunks = chunkResult(pair, 5);
    const source = history(pair);
    const approved = decisions(chunks, ["drop", "drop"]);
    for (const broken of [
        chunks.slice(0, 1),
        [{ ...chunks[0]!, text: "wrong" }, chunks[1]!],
        [chunks[0]!, { ...chunks[1]!, start: 4 }],
        [chunks[0]!, { ...chunks[1]!, blockIndex: 99 }],
    ])
        assert.throws(
            () => applyDecisions(source, [], [pair], broken, approved),
            /coverage|matches|original result|Unknown or duplicate/,
        );
    const moved = { ...pair, call: { ...pair.call, index: 0 } };
    assert.throws(
        () => applyDecisions(source, [], [moved], chunks, approved),
        /native summary region/,
    );
});

test("prefix rewriting stays separate and unrelated plain messages remain intact", () => {
    const pair = pairFor("body");
    const prefixPair: ToolPair = {
        ...pair,
        call: { ...pair.call, region: "prefix" },
        result: { ...pair.result, region: "prefix" },
    };
    const chunks = chunkResult(prefixPair, 10);
    const plain = [user("goal"), assistantText("plain")];
    const actual = applyDecisions(
        plain,
        history(prefixPair),
        [prefixPair],
        chunks,
        decisions(chunks, ["drop"]),
    );
    assert.deepEqual(actual.messagesToSummarize, plain);
    assert.deepEqual(
        actual.turnPrefixMessages.map(({ role }) => role),
        ["user"],
    );
});
