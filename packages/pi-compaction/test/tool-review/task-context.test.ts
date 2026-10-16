import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageLocation, ToolPair } from "../../src/tool-review/candidates.ts";
import { candidateContext } from "../../src/tool-review/candidates.ts";
import {
    assistantText,
    assistantToolCall,
    toolResult,
    user,
    ZERO_USAGE,
} from "../harness/fixtures.ts";

function setup(messages: AgentMessage[], callIndex: number, resultIndex: number) {
    const locations: MessageLocation[] = messages.map((message, index) => ({
        region: "history",
        index,
        message,
    }));
    const pair: ToolPair = {
        id: "r",
        toolName: "read",
        arguments: { path: "source.ts" },
        call: locations[callIndex]!,
        result: locations[resultIndex]!,
    };
    return { pair, locations };
}

test("candidate context uses message positions and only visible same-turn assistant text", () => {
    // Later user requests must remain current even when they do not quote the earlier output.
    const messages: AgentMessage[] = [
        user("older request"),
        assistantText("older answer"),
        user("inspect source"),
        assistantToolCall("r", "read", { path: "source.ts" }),
        toolResult("r", "read", "body"),
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "HIDDEN_THINKING" },
                { type: "text", text: "analysis" },
            ],
            api: "faux",
            provider: "faux",
            model: "m",
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: 0,
        },
        assistantToolCall("later", "bash", { command: "HIDDEN_COMMAND" }, "checking"),
        toolResult("later", "bash", "HIDDEN_RESULT"),
        assistantText("conclusion"),
        user("apply the fix elsewhere"),
        assistantText("NEXT_TURN_TEXT"),
    ];
    const original = structuredClone(messages);
    const { pair, locations } = setup(messages, 3, 4);
    const actual = candidateContext(pair, locations);
    const expected = {
        originatingRequest: "inspect source",
        currentRequest: "apply the fix elsewhere",
        toolCall: { name: "read", arguments: { path: "source.ts" } },
        sameTurnOutcome: "analysis\nchecking\nconclusion",
    };
    assert.deepEqual(actual, expected);
    assert.deepEqual(messages, original);
});

test("candidate context omits unavailable user requests and outcome", () => {
    const { pair, locations } = setup(
        [assistantToolCall("r", "read", {}), toolResult("r", "read", "body")],
        0,
        1,
    );
    assert.deepEqual(candidateContext(pair, locations), {
        toolCall: { name: "read", arguments: { path: "source.ts" } },
    });
    assert.throws(() => candidateContext(pair, []), /absent from the conversation/);
});

test("candidate context bounds visible excerpts without cutting Unicode code points", () => {
    // Requests keep their opening; the same-turn outcome keeps its final conclusion.
    const { pair, locations } = setup(
        [
            user("😀".repeat(2_100)),
            assistantToolCall("r", "read", {}),
            toolResult("r", "read", "body"),
            assistantText("old details" + "😃".repeat(2_100)),
        ],
        1,
        2,
    );
    const actual = candidateContext(pair, locations);
    assert.equal(actual.originatingRequest, "😀".repeat(2_000));
    assert.equal(actual.currentRequest, "😀".repeat(2_000));
    assert.equal(actual.sameTurnOutcome, "😃".repeat(2_000));
});
