import assert from "node:assert/strict";
import test from "node:test";

import { runGlobalPass } from "../../src/dreaming/global.ts";
import { createDreamingModel } from "../../src/dreaming/model.ts";
import { getItem, getSession, listItems } from "../../src/store/rows.ts";
import {
    analyzerReply,
    count,
    createDreamEnv,
    decisionCandidate,
    NOW,
    type DreamEnv,
} from "../harness/dreaming.ts";

const STALE = /Rejected \w+: evidence changed during the pass/u;

const source = (eventKey: string) => ({
    kind: "event" as const,
    harness: "claude" as const,
    sessionId: "old",
    eventKey,
});

/** Change the text hash of an event, as an import does when the event is edited. */
function changeEvent(env: DreamEnv, key: string): void {
    env.store.run("UPDATE events SET hash = 'edited' WHERE session_id = 'old' AND key = ?", key);
}

/**
 * A project with an old processed session (two events), a new session that the pass analyzes,
 * and decisions A, B and M that rest on the old events.
 */
function seedProject(env: DreamEnv): void {
    env.addProject("p1", "Project one");
    env.addSession({
        id: "old",
        projectId: "p1",
        processedRevision: 1,
        events: [
            { text: "We use SQLite for storage.", key: "old-k1", processed: true },
            { text: "We deploy on Fridays.", key: "old-k2", processed: true },
        ],
    });
    env.addSession({
        id: "s1",
        projectId: "p1",
        events: [{ role: "user", text: "We decided to use SQLite because the store is local." }],
    });
    for (const [id, key] of [
        ["item-a", "old-k1"],
        ["item-b", "old-k2"],
    ] as const) {
        env.addItem({
            id,
            kind: "decision",
            title: `Decision ${id}`,
            body: `Body of ${id}.`,
            projectId: "p1",
            sources: [source(key)],
        });
    }
    env.addItem({
        id: "item-m",
        kind: "decision",
        title: "Decision M",
        body: "Body of M.",
        projectId: "p1",
        sources: [source("old-k1"), source("old-k2")],
    });
}

/** Organizer that changes `key` of the old session while the model call runs, once. */
function organizerChanging(env: DreamEnv, key: string, ops: Array<Record<string, unknown>>) {
    return (_user: string, index: number) => {
        if (index === 0) changeEvent(env, key);
        return { summary: "race", ops };
    };
}

const update = (id: string) => ({
    op: "update",
    id,
    title: null,
    body: "New body that the model chose.",
    evidence: ["s1.c1"],
    from: [],
    links: [],
});

/** The new session s1 is still to analyze: its event and revision are unprocessed. */
function assertStillUnprocessed(env: DreamEnv): void {
    assert.equal(
        count(
            env,
            "SELECT COUNT(*) AS n FROM events WHERE session_id = 's1' AND processed_hash IS NOT NULL",
        ),
        0,
    );
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision, null);
}

test("an operation on an item whose source changed during the model call is rejected, and its events stay unprocessed", async (t) => {
    const env = createDreamEnv(t);
    seedProject(env);
    env.route({
        analyzer: analyzerReply([decisionCandidate("Use SQLite")]),
        organizer: organizerChanging(env, "old-k1", [update("item-a")]),
    });

    const first = await env.pass();

    assert.match(first.projects[0]?.warnings.join("\n") ?? "", STALE);
    assert.equal(first.projects[0]?.counts?.updated, 0);
    assert.equal(getItem(env.store, "item-a")?.body, "Body of item-a.");
    assertStillUnprocessed(env);

    const second = await env.pass();

    const analyzed = env.calls.filter(
        (call) => call.role === "analyzer" && call.user.includes("Session: s1"),
    );
    assert.equal(analyzed.length, 2);
    assert.equal(second.status, "ok");
});

test("a project merge whose source changed is rejected and does not retire the other item", async (t) => {
    const env = createDreamEnv(t);
    seedProject(env);
    env.route({
        analyzer: analyzerReply([decisionCandidate("Use SQLite")]),
        organizer: organizerChanging(env, "old-k1", [
            {
                op: "merge",
                ids: ["item-a", "item-b"],
                title: "Merged decision",
                body: "Both decisions in one.",
                evidence: ["s1.c1"],
                from: [],
                links: [],
            },
        ]),
    });

    const summary = await env.pass();

    assert.match(
        summary.projects[0]?.warnings.join("\n") ?? "",
        /Rejected merge: evidence changed/u,
    );
    assert.equal(getItem(env.store, "item-a")?.status, "active");
    assert.equal(getItem(env.store, "item-b")?.status, "active");
    assert.equal(getItem(env.store, "item-a")?.title, "Decision item-a");
    assertStillUnprocessed(env);
});

test("an operation with one changed pinned source and one unchanged unrelated source is rejected as a whole", async (t) => {
    const env = createDreamEnv(t);
    seedProject(env);
    env.route({
        analyzer: analyzerReply([decisionCandidate("Use SQLite")]),
        organizer: organizerChanging(env, "old-k1", [update("item-m")]),
    });

    const summary = await env.pass();

    assert.match(summary.projects[0]?.warnings.join("\n") ?? "", STALE);
    const item = getItem(env.store, "item-m");
    assert.equal(item?.body, "Body of M.");
    assert.deepEqual(item?.sources, [source("old-k1"), source("old-k2")]);
    assertStillUnprocessed(env);
});

// ---------------------------------------------------------------------------------------------
// Global pass

function seedGlobalPreference(env: DreamEnv, id: string, general: boolean): void {
    if (!env.store.get("SELECT 1 AS n FROM projects WHERE id = ?", `p-${id}`)) {
        env.addProject(`p-${id}`, `Project ${id}`);
    }
    env.addSession({
        id: `sess-${id}`,
        projectId: `p-${id}`,
        processedRevision: 1,
        events: [{ text: "Always answer in English.", key: `ev-${id}`, processed: true }],
    });
    env.addItem({
        id,
        kind: "preference",
        title: `Answer in English ${id}`,
        body: "Reply in English.",
        projectId: `p-${id}`,
        general,
        sources: [
            { kind: "event", harness: "claude", sessionId: `sess-${id}`, eventKey: `ev-${id}` },
        ],
    });
}

function runGlobal(env: DreamEnv) {
    const model = createDreamingModel(env.config.dreaming, env.paths, { models: env.models });
    return runGlobalPass(env.store, env.paths, model, {
        pass: "p-test",
        trigger: "test",
        results: [],
        now: NOW,
    });
}

test("a global promotion of a project preference whose source changed is rejected", async (t) => {
    const env = createDreamEnv(t);
    seedGlobalPreference(env, "pref1", true);
    env.route({
        global: () => {
            env.store.run("UPDATE events SET hash = 'edited' WHERE key = 'ev-pref1'");
            return {
                summary: "",
                ops: [
                    {
                        op: "promote",
                        title: "Answer in English",
                        body: "Reply in English everywhere.",
                        from: ["pref1"],
                        evidence: [],
                    },
                ],
            };
        },
    });

    const actual = await runGlobal(env);

    assert.equal(actual.counts.promoted, 0);
    assert.equal(actual.counts.rejected, 1);
    assert.match(actual.warnings.join("\n"), STALE);
    assert.equal(listItems(env.store, { scope: "global", kind: ["preference"] }).length, 0);
    assert.equal(getItem(env.store, "pref1")?.status, "active");
});

test("a global merge whose sources all became memory-derived does not make an active preference", async (t) => {
    const env = createDreamEnv(t);
    seedGlobalPreference(env, "pref1", true);
    for (const id of ["g1", "g2"]) {
        env.addSession({
            id: `gs-${id}`,
            processedRevision: 1,
            events: [{ text: "Always answer in English.", key: `gev-${id}`, processed: true }],
        });
        env.addItem({
            id,
            scope: "global",
            kind: "preference",
            title: `Global ${id}`,
            body: `Reply in English (${id}).`,
            general: true,
            sources: [
                { kind: "event", harness: "claude", sessionId: `gs-${id}`, eventKey: `gev-${id}` },
            ],
        });
    }
    env.route({
        global: () => {
            env.store.run("UPDATE events SET memory_derived = 1 WHERE key LIKE 'gev-%'");
            return {
                summary: "",
                ops: [
                    { op: "merge", ids: ["g1", "g2"], title: "Merged", body: "Reply in English." },
                ],
            };
        },
    });

    const actual = await runGlobal(env);

    assert.equal(actual.counts.merged, 0);
    assert.equal(actual.counts.rejected, 1);
    assert.match(actual.warnings.join("\n"), /would have no live evidence/u);
    assert.equal(getItem(env.store, "g1")?.status, "active");
    assert.equal(getItem(env.store, "g1")?.title, "Global g1");
    assert.equal(getItem(env.store, "g2")?.status, "active");
});
