import assert from "node:assert/strict";
import test from "node:test";

import { stableL1Size } from "../../src/memory/l1.ts";
import { getItem } from "../../src/store/rows.ts";
import {
    analyzerReply,
    createDreamEnv,
    decisionCandidate,
    runCount,
    type DreamEnv,
} from "../harness/dreaming.ts";

const lines = (count: number, prefix = "l"): string =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`).join("\n");

/** Two open branches; branch A is already over the line limit, branch B is small. */
function seedBranches(env: DreamEnv): { maxLines: number; maxBytes: number } {
    env.addProject("p1", "Project one");
    env.addBranch("p1", "a");
    env.addBranch("p1", "b");
    env.addSession({
        id: "old",
        projectId: "p1",
        processedRevision: 1,
        events: [{ text: "The state is tracked here.", key: "old-k1", processed: true }],
    });
    const source = [
        {
            kind: "event" as const,
            harness: "claude" as const,
            sessionId: "old",
            eventKey: "old-k1",
        },
    ];
    const { maxLines, maxBytes } = stableL1Size(env.store, env.paths, "p1");
    env.addItem({
        id: "state-a",
        kind: "working_state",
        title: "State A",
        body: lines(maxLines + 69),
        projectId: "p1",
        branch: "a",
        sources: source,
    });
    env.addItem({
        id: "state-b",
        kind: "working_state",
        title: "State B",
        body: lines(20),
        projectId: "p1",
        branch: "b",
        sources: source,
    });
    env.addSession({
        id: "s1",
        projectId: "p1",
        events: [{ role: "user", text: "We decided to use SQLite because the store is local." }],
    });
    return { maxLines, maxBytes };
}

const updateB = (body: string) => ({
    op: "update",
    id: "state-b",
    title: null,
    body,
    evidence: ["s1.c1"],
    from: [],
    links: [],
});

test("a commit that grows branch B over the line limit is rejected while branch A is further over", async (t) => {
    const env = createDreamEnv(t);
    const { maxLines, maxBytes } = seedBranches(env);
    const before = stableL1Size(env.store, env.paths, "p1");
    assert.ok(before.lines > maxLines, "branch A starts over the limit");
    env.route({
        analyzer: analyzerReply([decisionCandidate("Use SQLite")]),
        organizer: { summary: "grow", ops: [updateB(lines(maxLines + 30))] },
    });

    const summary = await env.pass();

    assert.equal(summary.status, "failed");
    const error = summary.projects[0]?.error ?? "";
    const named = /for branch b would be (\d+) lines and (\d+) bytes/u.exec(error);
    assert.ok(named, error);
    assert.ok(Number(named[1]) > maxLines);
    assert.ok(Number(named[2]) > 0);
    assert.ok(error.includes(`over the budget of ${maxLines} lines and ${maxBytes} bytes`));
    assert.equal(getItem(env.store, "state-b")?.body, lines(20));
    assert.equal(runCount(env, "project", "ok"), 0);
    assert.equal(runCount(env, "project", "failed"), 1);
});

test("a commit that grows branch B but keeps it within the limits is accepted while branch A is over", async (t) => {
    const env = createDreamEnv(t);
    seedBranches(env);
    env.route({
        analyzer: analyzerReply([decisionCandidate("Use SQLite")]),
        organizer: { summary: "grow a little", ops: [updateB(lines(60))] },
    });

    const summary = await env.pass();

    assert.equal(summary.status, "ok");
    assert.equal(getItem(env.store, "state-b")?.body, lines(60));
});

test("the Organizer input states the size of the largest branch and the budget of each branch", async (t) => {
    const env = createDreamEnv(t);
    const { maxLines, maxBytes } = seedBranches(env);
    const before = stableL1Size(env.store, env.paths, "p1");
    env.route({
        analyzer: analyzerReply([decisionCandidate("Use SQLite")]),
        organizer: { summary: "nothing", ops: [] },
    });

    await env.pass();

    const input = env.calls.find((call) => call.role === "organizer")?.user ?? "";
    const expected =
        `Startup context now: ${before.lines} lines and ${before.bytes} bytes on the largest ` +
        `branch. Budget: ${maxLines} lines and ${maxBytes} bytes on each branch.`;
    assert.ok(input.includes(expected), input.slice(0, 400));
});
