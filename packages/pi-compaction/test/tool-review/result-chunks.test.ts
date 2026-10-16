import test from "node:test";
import assert from "node:assert/strict";
import { chunkResult, splitText } from "../../src/tool-review/candidates.ts";
import type { ToolPair } from "../../src/tool-review/candidates.ts";
import { ZERO_USAGE, image, toolResultBlocks } from "../harness/fixtures.ts";

function pairWithResult(
    id: string,
    content: Parameters<typeof toolResultBlocks>[2],
    region: "history" | "prefix" = "history",
): ToolPair {
    const result = toolResultBlocks(id, "read", content);
    return {
        id,
        toolName: "read",
        arguments: {},
        call: {
            region,
            index: 0,
            message: {
                role: "assistant",
                content: [],
                api: "faux",
                provider: "faux",
                model: "m",
                usage: ZERO_USAGE,
                stopReason: "toolUse",
                timestamp: 0,
            },
        },
        result: { region, index: 1, message: result },
    };
}

test("splitText returns no chunks for empty text", () => {
    assert.deepEqual(splitText("", 10), []);
});

test("splitText partitions every UTF-16 position exactly once", () => {
    const text = "alpha\nbeta\ngamma\n";
    const pieces = splitText(text, 5);
    assert.equal(pieces.map((piece) => piece.text).join(""), text);
    assert.equal(pieces[0]!.start, 0);
    for (let index = 0; index < pieces.length; index++) {
        if (index > 0) assert.equal(pieces[index]!.start, pieces[index - 1]!.end);
        assert.equal(pieces[index]!.text, text.slice(pieces[index]!.start, pieces[index]!.end));
    }
    assert.equal(pieces[pieces.length - 1]!.end, text.length);
});

test("splitText prefers a line boundary inside the cap", () => {
    const pieces = splitText("aaaa\nbbbb", 6);
    assert.deepEqual(
        pieces.map((piece) => piece.text),
        ["aaaa\n", "bbbb"],
    );
});

test("splitText never cuts a surrogate pair", () => {
    const text = "ab😀cd";
    const pieces = splitText(text, 4);
    assert.equal(pieces.map((piece) => piece.text).join(""), text);
    for (const piece of pieces) {
        const first = piece.text.charCodeAt(0);
        const last = piece.text.charCodeAt(piece.text.length - 1);
        assert.ok(
            !(last >= 0xd800 && last <= 0xdbff),
            `chunk ends on a high surrogate: ${JSON.stringify(piece.text)}`,
        );
        assert.ok(
            !(first >= 0xdc00 && first <= 0xdfff),
            `chunk starts on a low surrogate: ${JSON.stringify(piece.text)}`,
        );
    }
});

test("splitText rejects a cap that cannot hold a surrogate pair", () => {
    assert.throws(() => splitText("abc", 1), /maxChars/);
    assert.throws(() => splitText("abc", 2.5), /maxChars/);
});

test("chunkResult covers the whole result text with source ranges", () => {
    const text = "aaaa\nbbbb\ncccc";
    const chunks = chunkResult(pairWithResult("c1", [{ type: "text", text }]), 5);
    assert.deepEqual(
        chunks.map((chunk) => chunk.text),
        ["aaaa\n", "bbbb\n", "cccc"],
    );
    assert.deepEqual(
        chunks.map((chunk) => [chunk.start, chunk.end]),
        [
            [0, 5],
            [5, 10],
            [10, 14],
        ],
    );
    assert.equal(chunks[0]!.toolCallId, "c1");
});

test("chunkResult keeps block order and offsets independent per block", () => {
    const chunks = chunkResult(
        pairWithResult("c2", [
            { type: "text", text: "aaaaaa" },
            { type: "text", text: "bbbbbb" },
        ]),
        4,
    );
    assert.deepEqual(
        chunks.map((chunk) => [chunk.blockIndex, chunk.start, chunk.end, chunk.text]),
        [
            [0, 0, 4, "aaaa"],
            [0, 4, 6, "aa"],
            [1, 0, 4, "bbbb"],
            [1, 4, 6, "bb"],
        ],
    );
});

test("chunkResult rejects a candidate whose result contains non-text content", () => {
    assert.throws(
        () => chunkResult(pairWithResult("c3", [{ type: "text", text: "ok" }, image()]), 10),
        /non-text/,
    );
});
