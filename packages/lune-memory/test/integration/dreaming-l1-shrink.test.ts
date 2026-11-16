import assert from "node:assert/strict";
import test from "node:test";

import { stableL1Size } from "../../src/memory/l1.ts";
import { getItem } from "../../src/store/rows.ts";
import { createDreamEnv, oversizedBody, type DreamEnv } from "../harness/dreaming.ts";

const NOTICE = "# Task for this pass";
const KEY = "dreaming_shrink:p1";

/** A project with no new sessions whose project index is far over the L1 budget. */
function seedOverBudget(env: DreamEnv, projectId = "p1", bodyLines = 400): void {
    env.addProject(projectId, `Project ${projectId}`);
    env.addBranch(projectId, "main");
    env.addSession({
        id: `old-${projectId}`,
        projectId,
        processedRevision: 1,
        events: [{ text: "The index is kept here.", key: "k1", processed: true }],
    });
    env.addItem({
        id: `index-${projectId}`,
        kind: "index",
        title: "Index",
        body: oversizedBody(bodyLines),
        projectId,
        sources: [
            { kind: "event", harness: "claude", sessionId: `old-${projectId}`, eventKey: "k1" },
        ],
    });
}

const organizerCalls = (env: DreamEnv) => env.calls.filter((call) => call.role === "organizer");

const shorten = (id: string) => ({
    op: "update",
    id,
    title: null,
    body: "Short index.",
    evidence: [],
    from: [],
    links: [],
});

test("an over-budget project gets an Organizer call with the task notice and no new sessions", async (t) => {
    const env = createDreamEnv(t);
    seedOverBudget(env);
    env.route({ organizer: { summary: "nothing", ops: [] } });

    await env.pass();

    const calls = organizerCalls(env);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.user.includes(NOTICE));
    assert.equal(env.calls.filter((call) => call.role === "analyzer").length, 0);
});

test("at most maxAttempts shrink passes run in a row, and a forced pass ignores the limit", async (t) => {
    const env = createDreamEnv(t);
    seedOverBudget(env);
    env.route({ organizer: { summary: "nothing", ops: [] } });
    const attempts = env.config.dreaming.maxAttempts;

    for (let i = 0; i < attempts + 2; i++) await env.pass();
    const stalled = organizerCalls(env).length;
    await env.pass({ force: true });

    assert.equal(stalled, attempts);
    assert.equal(organizerCalls(env).length, attempts + 1);
});

test("a project that fits gets no Organizer call", async (t) => {
    const env = createDreamEnv(t);
    seedOverBudget(env, "p1", 5);
    env.route({ organizer: { summary: "nothing", ops: [] } });
    assert.equal(stableL1Size(env.store, env.paths, "p1").fits, true);

    await env.pass();

    assert.equal(organizerCalls(env).length, 0);
});

test("a project filter for another project skips the over-budget project", async (t) => {
    const env = createDreamEnv(t);
    seedOverBudget(env, "p1");
    env.addProject("p2", "Project p2");
    env.route({ organizer: { summary: "nothing", ops: [] } });

    await env.pass({ projectId: "p2" });

    assert.equal(organizerCalls(env).length, 0);
});

test("a reply that shortens the over-budget item ends the shrink passes and clears the count", async (t) => {
    const env = createDreamEnv(t);
    seedOverBudget(env);
    env.route({
        organizer: (user) => ({
            summary: "shortened",
            ops: user.includes(NOTICE) ? [shorten("index-p1")] : [],
        }),
    });

    await env.pass();
    const afterFirst = organizerCalls(env).length;
    await env.pass();

    assert.equal(afterFirst, 1);
    assert.equal(getItem(env.store, "index-p1")?.body, "Short index.");
    assert.equal(stableL1Size(env.store, env.paths, "p1").fits, true);
    assert.equal(organizerCalls(env).length, 1);
    assert.equal(env.store.getMeta(KEY), null);
});
