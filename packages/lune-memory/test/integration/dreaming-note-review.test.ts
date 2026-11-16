import assert from "node:assert/strict";
import test from "node:test";

import { getItem } from "../../src/store/rows.ts";
import type { PassSummary } from "../../src/dreaming/index.ts";
import { createDreamEnv, createGitRepo, type DreamEnv } from "../harness/dreaming.ts";

const NOTE_ID = "n1";

/** One project with a session and a provisional Note that this session wrote. */
function seed(env: DreamEnv, note: { branch?: string; kind?: "note" | "open_item" } = {}): void {
    env.addProject("p1", "Project one");
    env.addSession({
        id: "s1",
        projectId: "p1",
        events: [
            { role: "user", text: "The cache is cleared at startup, by design." },
            { role: "assistant", text: "Understood." },
        ],
    });
    env.addItem({
        id: NOTE_ID,
        kind: note.kind ?? "note",
        title: "Cache clears at startup",
        body: "The cache is cleared at startup.",
        projectId: "p1",
        branch: note.branch ?? null,
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "s1",
    });
}

function script(env: DreamEnv, noteReviews: Array<Record<string, unknown>>): void {
    env.route({
        analyzer: { summary: "Reviewed.", candidates: [], noteReviews, conflicts: [] },
        organizer: { summary: "Nothing to organize.", ops: [] },
    });
}

const review = (action: string, extra: Record<string, unknown> = {}) => ({
    noteId: NOTE_ID,
    action,
    title: null,
    body: null,
    evidence: [],
    reason: "test",
    ...extra,
});

function warnings(summary: PassSummary): string {
    return (summary.projects[0]?.warnings ?? []).join("\n");
}

test("a Note with no review stays provisional and the pass warns", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, []);

    const summary = await env.pass();

    assert.equal(getItem(env.store, NOTE_ID)?.status, "provisional");
    assert.match(warnings(summary), /Note n1 has no review\. It stays provisional\./u);
});

test("a retract review retires the Note", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, [review("retract")]);

    await env.pass();

    assert.equal(getItem(env.store, NOTE_ID)?.status, "retired");
});

test("a keep review with live evidence confirms the Note", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, [review("keep", { evidence: ["e1"] })]);

    await env.pass();

    const note = getItem(env.store, NOTE_ID);
    assert.equal(note?.status, "active");
    assert.equal(note?.title, "Cache clears at startup");
    assert.ok(
        note?.sources.some((source) => source.kind === "event" && source.eventKey === "s1-k1"),
    );
});

test("a correct review with live evidence confirms the Note with the new text", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, [
        review("correct", {
            title: "Cache clears on every start",
            body: "The cache is cleared on every start.",
            evidence: ["e1"],
        }),
    ]);

    await env.pass();

    const note = getItem(env.store, NOTE_ID);
    assert.equal(note?.status, "active");
    assert.equal(note?.title, "Cache clears on every start");
    assert.equal(note?.body, "The cache is cleared on every start.");
});

test("a keep review with no live evidence keeps the Note provisional", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, [review("keep", { evidence: [] })]);

    const summary = await env.pass();

    assert.equal(getItem(env.store, NOTE_ID)?.status, "provisional");
    assert.match(warnings(summary), /Note n1: the review cites no live evidence/u);
});

test("a correct review with no live evidence keeps the Note provisional and unchanged", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, [review("correct", { title: "Changed", body: "Changed body.", evidence: [] })]);

    const summary = await env.pass();

    const note = getItem(env.store, NOTE_ID);
    assert.equal(note?.status, "provisional");
    assert.equal(note?.title, "Cache clears at startup");
    assert.match(warnings(summary), /cites no live evidence/u);
});

test("a Note on a closed branch is retired at its review, even with live evidence", async (t) => {
    const env = createDreamEnv(t);
    seed(env, { branch: "feat/old", kind: "open_item" });
    env.addBranch("p1", "feat/old", "merged");
    env.store.run("UPDATE branches SET handled_run = 1 WHERE name = 'feat/old'");
    script(env, [review("keep", { evidence: ["e1"] })]);

    const summary = await env.pass();

    assert.equal(getItem(env.store, NOTE_ID)?.status, "retired");
    assert.match(warnings(summary), /Note n1 is on the closed branch feat\/old\. It is retired\./u);
});

test("closing a branch retires a provisional Note of a branch kind on it", async (t) => {
    const env = createDreamEnv(t);
    const repo = createGitRepo(env.home);
    env.addProject("p1", "Repo project", repo.root);
    repo.branch("feat/a");
    repo.run("merge", "-q", "feat/a");
    env.addBranch("p1", "feat/a");
    env.addBranch("p1", "main");
    env.addItem({
        id: "todo",
        kind: "open_item",
        title: "Todo on A",
        body: "Open.",
        projectId: "p1",
        branch: "feat/a",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
    });
    env.addItem({
        id: "plain",
        kind: "note",
        title: "Plain note",
        body: "Not tied to a branch kind.",
        projectId: "p1",
        branch: "feat/a",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
    });
    env.route({ organizer: { summary: "closed", ops: [] } });

    const summary = await env.pass();

    assert.deepEqual(summary.closedBranches, ["p1:feat/a"]);
    assert.equal(getItem(env.store, "todo")?.status, "retired");
    assert.equal(getItem(env.store, "plain")?.status, "provisional");
});
