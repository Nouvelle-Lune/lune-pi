import assert from "node:assert/strict";
import { test } from "node:test";

import {
    INLINE_SETTINGS,
    agentSettingsProblem,
    autoOnlyProblem,
} from "../../src/run/run-manager.ts";

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

test("autoOnlyProblem is silent when Auto mode only is off", () => {
    assert.equal(autoOnlyProblem({ model: "a/one" }, false), undefined);
});

test("autoOnlyProblem rejects an inline start that names another model", () => {
    const actual = autoOnlyProblem({ model: "a/one" }, true);
    const expected =
        'Auto mode only is on, so an inline run uses model auto; leave out model "a/one".';

    assert.equal(actual, expected);
});

test("autoOnlyProblem allows an inline start with model auto or no model", () => {
    assert.equal(autoOnlyProblem({ model: "auto" }, true), undefined);
    assert.equal(autoOnlyProblem({ title: "Check" }, true), undefined);
});

test("autoOnlyProblem leaves an agent start with a model to agentSettingsProblem", () => {
    assert.equal(autoOnlyProblem({ agent: "reviewer", model: "a/one" }, true), undefined);
});
