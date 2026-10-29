import assert from "node:assert/strict";
import { test } from "node:test";

import { INLINE_SETTINGS, agentSettingsProblem } from "../../src/run/run-manager.ts";

const lead =
    'The agent "reviewer" runs with the model, thinking, tools and isolation of its definition; ' +
    "give only task and title with agent, and leave out ";

test("without an agent, any settings are allowed", () => {
    assert.equal(
        agentSettingsProblem({ model: "a/one", tools: [], isolation: "worktree" }),
        undefined,
    );
});

test("an agent with only a title has no problem", () => {
    assert.equal(agentSettingsProblem({ agent: "reviewer", title: "Review" }), undefined);
});

test("an agent with settings lists exactly the set ones in the fixed order", () => {
    const actual = agentSettingsProblem({
        agent: "reviewer",
        isolation: "shared",
        model: "a/one",
        thinking: "low",
    });

    assert.deepEqual(INLINE_SETTINGS, ["model", "thinking", "tools", "isolation"]);
    assert.equal(actual, `${lead}model, thinking, isolation.`);
});

test("an empty tools list counts as set", () => {
    assert.equal(agentSettingsProblem({ agent: "reviewer", tools: [] }), `${lead}tools.`);
});
