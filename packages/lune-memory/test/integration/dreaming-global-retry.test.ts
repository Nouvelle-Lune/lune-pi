import assert from "node:assert/strict";
import test from "node:test";

import { createDreamEnv, type DreamEnv } from "../harness/dreaming.ts";

const globalCalls = (env: DreamEnv): number =>
    env.calls.filter((call) => call.role === "global").length;

/** One project with a processed session and an active project preference with a low run id. */
function seed(env: DreamEnv): void {
    env.addProject("p1", "One");
    env.addSession({
        id: "s1",
        projectId: "p1",
        processedRevision: 1,
        events: [{ text: "Always answer in English.", key: "ev1", processed: true }],
    });
    env.addItem({
        id: "pref1",
        kind: "preference",
        title: "Answer in English",
        body: "Reply in English.",
        projectId: "p1",
        updatedRun: 1,
        sources: [{ kind: "event", harness: "claude", sessionId: "s1", eventKey: "ev1" }],
    });
}

/** Mark the preference as changed by a run newer than every failed global run. */
function touchPreference(env: DreamEnv): void {
    env.store.run(
        "UPDATE items SET updated_run = (SELECT MAX(id) FROM runs) + 1 WHERE id = 'pref1'",
    );
}

test("after maxAttempts failed global passes in a row the pass makes no model call", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    env.route({ global: "this is not json" });
    const attempts = env.config.dreaming.maxAttempts;

    for (let i = 0; i < attempts + 3; i++) await env.pass();

    assert.equal(attempts, 3);
    assert.equal(globalCalls(env), attempts);
});

test("a project preference changed after the last failure starts the model again", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    env.route({ global: "this is not json" });
    for (let i = 0; i < 5; i++) await env.pass();
    const stalled = globalCalls(env);

    touchPreference(env);
    await env.pass();

    assert.equal(stalled, env.config.dreaming.maxAttempts);
    assert.equal(globalCalls(env), stalled + 1);
});

test("a forced pass ignores the stop point", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    env.route({ global: "this is not json" });
    for (let i = 0; i < 5; i++) await env.pass();
    const stalled = globalCalls(env);

    await env.pass({ force: true });

    assert.equal(globalCalls(env), stalled + 1);
});

test("a successful global pass resets the count, so the next change gets a fresh set of attempts", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    env.route({ global: "this is not json" });
    for (let i = 0; i < 5; i++) await env.pass();
    const attempts = env.config.dreaming.maxAttempts;

    env.route({ global: { summary: "", ops: [] } });
    await env.pass({ force: true });
    const afterSuccess = globalCalls(env) - attempts;
    await env.pass();
    const idle = globalCalls(env) - attempts;

    env.route({ global: "this is not json" });
    touchPreference(env);
    for (let i = 0; i < attempts + 3; i++) await env.pass();

    assert.equal(afterSuccess, 1);
    assert.equal(idle, 1, "a pass after the success makes no call");
    assert.equal(globalCalls(env), attempts + 1 + attempts);
});
