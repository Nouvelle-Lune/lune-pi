import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionProjection } from "@earendil-works/pi-coding-agent";
import { indexTools } from "../../src/tool-review/candidates.ts";
import { DEFAULT_COMPACTION_POLICY } from "../../src/options.ts";
import { assistantText, assistantToolCall, policy, toolResult, user } from "../harness/fixtures.ts";

interface ProjectedEntryLike {
    sourceEntry: { id: string; type: string };
    messages: AgentMessage[];
}

function projectionFrom(entries: ProjectedEntryLike[]): SessionProjection {
    return {
        entries,
        messages: entries.flatMap((entry) => entry.messages),
        thinkingLevel: "off",
        model: null,
    } as unknown as SessionProjection;
}

function entry(id: string, messages: AgentMessage[]): ProjectedEntryLike {
    return { sourceEntry: { id, type: "message" }, messages };
}

/** A retained tail that never overlaps the history/prefix messages under test. */
const KEPT = [entry("keep", [assistantText("retained tail")])];

test("indexTools pairs a read-only call with its result in history", () => {
    const call = assistantToolCall("t1", "read", { path: "a.ts" });
    const result = toolResult("t1", "read", "file contents");
    const index = indexTools([call, result], [], projectionFrom(KEPT), "keep", policy());
    assert.equal(index.pairs.length, 1);
    assert.equal(index.protectedTools.length, 0);
    const pair = index.pairs[0]!;
    assert.equal(pair.id, "t1");
    assert.equal(pair.toolName, "read");
    assert.equal(pair.call.region, "history");
    assert.equal(pair.result.region, "history");
    assert.deepEqual(pair.arguments, { path: "a.ts" });
});

test("indexTools protects tools not explicitly permitted by the user", () => {
    const call = assistantToolCall("t2", "bash", { command: "ls" });
    const result = toolResult("t2", "bash", "out");
    const index = indexTools(
        [call, result],
        [],
        projectionFrom(KEPT),
        "keep",
        policy({ deletableTools: ["read"] }),
    );
    assert.equal(index.pairs.length, 0);
    assert.deepEqual(index.protectedTools, [{ id: "t2", reasons: ["tool-not-deletable"] }]);
});

test("indexTools protects duplicate call ids", () => {
    const first = assistantToolCall("dup", "read", { path: "a" });
    const second = assistantToolCall("dup", "read", { path: "b" });
    const result = toolResult("dup", "read", "out");
    const index = indexTools([first, second, result], [], projectionFrom(KEPT), "keep", policy());
    assert.equal(index.pairs.length, 0);
    assert.deepEqual(index.protectedTools, [{ id: "dup", reasons: ["unpaired-or-duplicate-id"] }]);
});

test("indexTools protects as-yet-unpaired calls", () => {
    const call = assistantToolCall("open", "read", { path: "a" });
    const index = indexTools([call], [], projectionFrom(KEPT), "keep", policy());
    assert.equal(index.pairs.length, 0);
    assert.deepEqual(index.protectedTools, [{ id: "open", reasons: ["unpaired-or-duplicate-id"] }]);
});

test("indexTools protects cross-region pairs", () => {
    const call = assistantToolCall("x", "read", { path: "a" });
    const result = toolResult("x", "read", "out");
    const index = indexTools([call], [result], projectionFrom(KEPT), "keep", policy());
    assert.equal(index.pairs.length, 0);
    assert.deepEqual(index.protectedTools, [{ id: "x", reasons: ["cross-region-pair"] }]);
});

test("indexTools protects error, media and mismatched-name results", () => {
    const errorCall = assistantToolCall("err", "read", { path: "a" });
    const errorResult = toolResult("err", "read", "boom", { isError: true });
    const mediaCall = assistantToolCall("media", "read", { path: "b" });
    const mediaResult = toolResult("media", "read", "text", {
        nonText: [{ type: "image", data: "AA", mimeType: "image/png" }],
    });
    const mismatchCall = assistantToolCall("name", "read", { path: "c" });
    const mismatchResult = toolResult("name", "ls", "out");
    const messages = [errorCall, errorResult, mediaCall, mediaResult, mismatchCall, mismatchResult];
    const index = indexTools(messages, [], projectionFrom(KEPT), "keep", policy());
    assert.equal(index.pairs.length, 0);
    assert.deepEqual(
        index.protectedTools.map((tool) => [tool.id, tool.reasons]),
        [
            ["err", ["error-result"]],
            ["media", ["non-text-result"]],
            ["name", ["tool-name-mismatch"]],
        ],
    );
});

test("indexTools protects pairs touching the retained region", () => {
    const call = assistantToolCall("r1", "read", { path: "a" });
    const result = toolResult("r1", "read", "out");
    const projection = projectionFrom([entry("keep", [call, result])]);
    const index = indexTools([], [], projection, "keep", policy());
    assert.equal(index.pairs.length, 0);
    assert.deepEqual(index.protectedTools, [{ id: "r1", reasons: ["retained-region"] }]);
});

test("indexTools protects an empty tool-call id", () => {
    const call = assistantToolCall("", "read", { path: "a" });
    const result = toolResult("", "read", "out");
    const index = indexTools([call, result], [], projectionFrom(KEPT), "keep", policy());
    assert.equal(index.pairs.length, 0);
    assert.ok(index.protectedTools[0]!.reasons.includes("empty-id"));
});

test("indexTools records locations across history, prefix and retained regions", () => {
    const history = user("goal");
    const prefix = assistantText("prefix");
    const retained = user("kept");
    const projection = projectionFrom([entry("keep", [retained])]);
    const index = indexTools([history], [prefix], projection, "keep", policy());
    assert.deepEqual(
        index.locations.map((location) => [location.region, location.message.role]),
        [
            ["history", "user"],
            ["prefix", "assistant"],
            ["retained", "user"],
        ],
    );
});

test("indexTools fails when the retained boundary is absent", () => {
    const projection = projectionFrom([entry("e1", [user("x")])]);
    assert.throws(
        () => indexTools([], [], projection, "missing", policy()),
        /missing from the current projection/,
    );
});

test("new default tool names participate in deletion while unselected tools remain protected", () => {
    const defaults = ["codemode", "bash", "edit", "powershell", "tool_search"];
    const messages = [...defaults, "write"].flatMap((name) => [
        assistantToolCall(name, name, {}),
        toolResult(name, name, "completed"),
    ]);
    const index = indexTools(messages, [], projectionFrom(KEPT), "keep", DEFAULT_COMPACTION_POLICY);
    assert.deepEqual(
        index.pairs.map(({ toolName }) => toolName),
        defaults,
    );
    assert.deepEqual(
        index.pairs.map(({ id }) => id),
        defaults,
    );
    assert.deepEqual(index.protectedTools, [{ id: "write", reasons: ["tool-not-deletable"] }]);
});
