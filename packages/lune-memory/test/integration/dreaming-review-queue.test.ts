import assert from "node:assert/strict";
import test from "node:test";

import { getItem, getSession, listItems } from "../../src/store/rows.ts";
import {
    analyzerReply,
    count,
    createDreamEnv,
    decisionCandidate,
    type DreamEnv,
} from "../harness/dreaming.ts";

const deadSource = (eventKey: string, sessionId = "dead") => ({
    kind: "event" as const,
    harness: "claude" as const,
    sessionId,
    eventKey,
});

/** Ids that the Analyzer input marks for review. */
function reviewIds(user: string): string[] {
    return [...user.matchAll(/^- \[([^\]]+)\] .*Review:/gmu)].map((match) => match[1] ?? "");
}

const unsupportedAll = (user: string) => ({
    summary: "Reviewed.",
    candidates: [],
    noteReviews: [],
    conflicts: [],
    unsupported: reviewIds(user).map((id) => ({ id, reason: "its evidence is gone" })),
});

/** A session that an import emptied: every event was removed, and review is queued. */
function seedEmptiedSession(env: DreamEnv): void {
    env.addProject("p1", "Project one");
    env.addSession({ id: "dead", projectId: "p1", revision: 2, processedRevision: 2 });
    env.store.run("UPDATE sessions SET review_revision = 2 WHERE id = 'dead'");
}

test("a session whose events are all removed stays eligible, and the pass reviews the items that cite it", async (t) => {
    const env = createDreamEnv(t);
    seedEmptiedSession(env);
    env.addSession({
        id: "other",
        projectId: "p1",
        processedRevision: 1,
        events: [{ text: "We use SQLite.", key: "o-k1", processed: true }],
    });
    env.addItem({
        id: "only-dead",
        kind: "decision",
        title: "Only on the dead session",
        body: "Rests on removed text.",
        projectId: "p1",
        sources: [deadSource("d-k1")],
    });
    env.addItem({
        id: "shared",
        kind: "decision",
        title: "Shared with another session",
        body: "Rests on removed text and on a live event.",
        projectId: "p1",
        sources: [deadSource("d-k2"), deadSource("o-k1", "other")],
    });
    env.route({ analyzer: unsupportedAll, organizer: { summary: "none", ops: [] } });

    const summary = await env.pass();

    assert.equal(summary.eligible, 1);
    assert.deepEqual(env.calledRoles().slice(0, 1), ["analyzer"]);
    assert.equal(getItem(env.store, "only-dead")?.status, "retired");
    const shared = getItem(env.store, "shared");
    assert.equal(shared?.status, "active");
    assert.deepEqual(shared?.sources, [deadSource("o-k1", "other")]);
    assert.equal(getSession(env.store, "claude", "dead")?.reviewRevision ?? null, null);
});

test("an emptied session with nothing left to review is trivial and leaves the queue", async (t) => {
    const env = createDreamEnv(t);
    seedEmptiedSession(env);
    env.route({ analyzer: unsupportedAll });

    const summary = await env.pass();

    assert.equal(summary.eligible, 0);
    assert.deepEqual(env.calledRoles(), []);
    assert.equal(getSession(env.store, "claude", "dead")?.reviewRevision ?? null, null);
});

test("when more than 40 items need review the session stays queued and the next pass reviews the rest", async (t) => {
    const env = createDreamEnv(t);
    seedEmptiedSession(env);
    for (let i = 0; i < 45; i++) {
        env.addItem({
            id: `item-${i}`,
            kind: "decision",
            title: `Decision ${i}`,
            body: `Rests on removed text ${i}.`,
            projectId: "p1",
            sources: [deadSource(`d-k${i}`)],
        });
    }
    env.route({ analyzer: unsupportedAll, organizer: { summary: "none", ops: [] } });
    const active = () =>
        listItems(env.store, { scope: "project", projectId: "p1", status: ["active"] }).length;

    await env.pass();

    assert.equal(active(), 5);
    assert.notEqual(getSession(env.store, "claude", "dead")?.reviewRevision ?? null, null);

    await env.pass();

    assert.equal(active(), 0);
    assert.equal(getSession(env.store, "claude", "dead")?.reviewRevision ?? null, null);
});

// ---------------------------------------------------------------------------------------------
// Imports during a pass. The import is simulated by its effect on the rows (see Importer).

/** A session `sx` with a new event, and an item that cites an older event of it and another session. */
function seedSession(env: DreamEnv): void {
    env.addProject("p1", "Project one");
    env.addSession({
        id: "other",
        projectId: "p1",
        processedRevision: 1,
        events: [{ text: "We use SQLite.", key: "o-k1", processed: true }],
    });
    env.addSession({
        id: "sx",
        projectId: "p1",
        events: [
            { text: "We use SQLite for storage.", key: "x-k1", processed: true },
            { role: "user", text: "We decided to use WAL mode for the store.", key: "x-k2" },
        ],
    });
    env.addItem({
        id: "stale",
        kind: "decision",
        title: "Use SQLite",
        body: "Rests on an event that is removed later.",
        projectId: "p1",
        sources: [deadSource("x-k1", "sx"), deadSource("o-k1", "other")],
    });
}

function analyzerOnce(onFirst: () => void) {
    return (user: string, index: number) => {
        if (index === 0) onFirst();
        if (reviewIds(user).length) return unsupportedAll(user);
        return analyzerReply([decisionCandidate("Use WAL mode", ["e2"])]);
    };
}

test("an import that removes events while the pass waits keeps the session in the review queue, and the next pass reviews the stale item", async (t) => {
    const env = createDreamEnv(t);
    seedSession(env);
    env.route({
        analyzer: analyzerOnce(() => {
            env.store.run("DELETE FROM events WHERE session_id = 'sx' AND key = 'x-k1'");
            env.store.run("UPDATE sessions SET revision = 2, review_revision = 2 WHERE id = 'sx'");
        }),
        organizer: { summary: "none", ops: [] },
    });

    await env.pass();

    const afterFirst = getSession(env.store, "claude", "sx");
    assert.equal(afterFirst?.reviewRevision, 2);
    assert.equal(afterFirst?.processedRevision ?? null, null);
    assert.equal(getItem(env.store, "stale")?.sources.length, 2);

    await env.pass();

    const stale = getItem(env.store, "stale");
    assert.equal(stale?.status, "active");
    assert.deepEqual(stale?.sources, [deadSource("o-k1", "other")]);
    assert.equal(getSession(env.store, "claude", "sx")?.reviewRevision ?? null, null);
    assert.equal(getSession(env.store, "claude", "sx")?.processedRevision, 2);
});

test("an import that reorders events while the pass waits resets the seam events, and the old pass does not mark them processed", async (t) => {
    const env = createDreamEnv(t);
    seedSession(env);
    env.route({
        analyzer: analyzerOnce(() => {
            // The import marks the seam events unprocessed in the new revision.
            env.store.run("UPDATE sessions SET revision = 2 WHERE id = 'sx'");
            env.store.run(
                `UPDATE events SET processed_hash = NULL, processed_chars = NULL, reset_revision = 2
                WHERE session_id = 'sx' AND key = 'x-k2'`,
            );
        }),
        organizer: { summary: "none", ops: [] },
    });
    const pending = () =>
        count(
            env,
            "SELECT COUNT(*) AS n FROM events WHERE session_id = 'sx' AND key = 'x-k2' AND processed_hash IS NULL",
        );

    await env.pass();

    assert.equal(pending(), 1);
    assert.equal(getSession(env.store, "claude", "sx")?.processedRevision ?? null, null);
    const analyzedBefore = env.calls.filter((call) => call.role === "analyzer").length;

    await env.pass();

    assert.equal(env.calls.filter((call) => call.role === "analyzer").length, analyzedBefore + 1);
    assert.equal(pending(), 0);
    assert.equal(getSession(env.store, "claude", "sx")?.processedRevision, 2);
});
