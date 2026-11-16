import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { PassSummary } from "../../src/dreaming/index.ts";
import { ProjectResolver } from "../../src/projects/resolver.ts";
import { getItem, getSession, listItems } from "../../src/store/rows.ts";
import { createDreamEnv, type DreamEnv } from "../harness/dreaming.ts";

const NOTE_ID = "gn1";
const eventSource = (eventKey: string, sessionId = "old") => ({
    kind: "event" as const,
    harness: "claude" as const,
    sessionId,
    eventKey,
});

/** A session outside any project and a provisional global Note that it wrote. */
function seed(env: DreamEnv): void {
    env.addSession({
        id: "loose",
        events: [
            { role: "user", text: "The build server is called atlas, in every project." },
            { role: "assistant", text: "Understood." },
        ],
    });
    env.addItem({
        id: NOTE_ID,
        scope: "global",
        projectId: null,
        kind: "note",
        title: "Build server is atlas",
        body: "The build server is called atlas.",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "loose",
    });
}

function script(env: DreamEnv, noteReviews: Array<Record<string, unknown>>): void {
    env.route({
        analyzer: { summary: "Reviewed.", candidates: [], noteReviews, conflicts: [] },
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
    return (summary.global?.warnings ?? []).join("\n");
}

test("a global Note with no review stays provisional", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, []);

    const summary = await env.pass();

    assert.equal(getItem(env.store, NOTE_ID)?.status, "provisional");
    assert.match(warnings(summary), /Note gn1 has no review\. It stays provisional\./u);
});

test("a global keep review that cites no live evidence leaves the Note provisional", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, [review("keep", { evidence: [] })]);

    const summary = await env.pass();

    assert.equal(getItem(env.store, NOTE_ID)?.status, "provisional");
    assert.match(warnings(summary), /Note gn1: the review cites no live evidence/u);
});

test("a global correct review that cites no live evidence leaves the Note provisional and unchanged", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, [review("correct", { title: "Changed", body: "Changed body.", evidence: [] })]);

    const summary = await env.pass();

    const note = getItem(env.store, NOTE_ID);
    assert.equal(note?.status, "provisional");
    assert.equal(note?.title, "Build server is atlas");
    assert.match(warnings(summary), /cites no live evidence/u);
});

test("a global retract review retires the Note", async (t) => {
    const env = createDreamEnv(t);
    seed(env);
    script(env, [review("retract")]);

    await env.pass();

    assert.equal(getItem(env.store, NOTE_ID)?.status, "retired");
});

test("a global Note whose existing source changes during the Analyzer stays provisional", async (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "old",
        processedRevision: 1,
        events: [{ role: "user", text: "Deploy on Fridays.", key: "old-k1", processed: true }],
    });
    env.addSession({
        id: "loose",
        events: [{ role: "user", text: "Always answer in English." }],
    });
    env.addItem({
        id: NOTE_ID,
        scope: "global",
        projectId: null,
        kind: "note",
        title: "Deploy on Fridays",
        body: "We deploy on Fridays.",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "loose",
        sources: [eventSource("old-k1")],
    });
    env.route({
        analyzer: () => {
            env.store.run(
                "UPDATE events SET text = 'Deploy on Mondays.', hash = 'edited' WHERE session_id = 'old' AND key = 'old-k1'",
            );
            return {
                summary: "Reviewed.",
                candidates: [],
                noteReviews: [review("keep", { evidence: ["e1"] })],
                conflicts: [],
            };
        },
        global: { summary: "", ops: [] },
    });

    const summary = await env.pass({ force: true, sessions: ["claude:loose"] });

    assert.equal(getItem(env.store, NOTE_ID)?.status, "provisional");
    assert.match(warnings(summary), /changed during the pass/u);
    assert.deepEqual(getItem(env.store, NOTE_ID)?.sources, [eventSource("old-k1")]);
});

test("a global Note whose existing source changes during the global call stays provisional", async (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "old",
        processedRevision: 1,
        events: [{ role: "user", text: "Deploy on Fridays.", key: "old-k1", processed: true }],
    });
    env.addSession({
        id: "loose",
        events: [{ role: "user", text: "Always answer in English." }],
    });
    env.addItem({
        id: NOTE_ID,
        scope: "global",
        projectId: null,
        kind: "note",
        title: "Deploy on Fridays",
        body: "We deploy on Fridays.",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "loose",
        sources: [eventSource("old-k1")],
    });
    env.route({
        analyzer: {
            summary: "Reviewed.",
            candidates: [
                {
                    kind: "preference",
                    title: "Answer in English",
                    body: "Reply in English.",
                    trust: "user",
                    general: true,
                    evidence: ["e1"],
                    updates: null,
                },
            ],
            noteReviews: [review("keep", { evidence: ["e1"] })],
            conflicts: [],
        },
        global: () => {
            env.store.run(
                "UPDATE events SET text = 'Deploy on Mondays.', hash = 'edited' WHERE session_id = 'old' AND key = 'old-k1'",
            );
            return { summary: "", ops: [] };
        },
    });

    const summary = await env.pass({ force: true, sessions: ["claude:loose"] });

    assert.equal(env.calls.filter((call) => call.role === "global").length, 1);
    const note = getItem(env.store, NOTE_ID);
    assert.equal(note?.status, "provisional");
    assert.match(warnings(summary), /changed during the pass/u);
    assert.deepEqual(note?.sources, [eventSource("old-k1")]);
});

test("a keep review without evidence does not activate a global Note that has older sources", async (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "old",
        processedRevision: 1,
        events: [{ role: "user", text: "Hello.", key: "old-k1", processed: true }],
    });
    env.addSession({ id: "loose", events: [{ role: "user", text: "Hello again." }] });
    env.addItem({
        id: NOTE_ID,
        scope: "global",
        projectId: null,
        kind: "note",
        title: "Server uses SQLite",
        body: "The server uses SQLite.",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "loose",
        sources: [eventSource("old-k1")],
    });
    env.route({
        analyzer: {
            summary: "Reviewed.",
            candidates: [],
            noteReviews: [review("keep", { evidence: [] })],
            conflicts: [],
        },
        global: { summary: "", ops: [] },
    });

    const summary = await env.pass({ force: true, sessions: ["claude:loose"] });

    const note = getItem(env.store, NOTE_ID);
    assert.equal(note?.status, "provisional");
    assert.deepEqual(note?.sources, [eventSource("old-k1")]);
    assert.equal(summary.global?.counts.notes, 0);
});

test("a global Note written before its folder was registered is reviewed after the session joins a project", async (t) => {
    const env = createDreamEnv(t);
    const plain = join(env.home, "plain");
    mkdirSync(plain, { recursive: true });
    env.addSession({
        id: "s1",
        events: [{ role: "user", text: "The cache is cleared at startup." }],
    });
    env.store.run("UPDATE sessions SET cwd = ? WHERE id = 's1'", plain);
    env.addItem({
        id: NOTE_ID,
        scope: "global",
        projectId: null,
        kind: "note",
        title: "Cache clears at startup",
        body: "The cache is cleared at startup.",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "s1",
    });
    const project = new ProjectResolver(env.store).register(plain);
    assert.equal(getSession(env.store, "claude", "s1")?.projectId, project.id);
    let analyzerInput = "";
    env.route({
        analyzer: (user) => {
            analyzerInput = user;
            return {
                summary: "Reviewed.",
                candidates: [],
                noteReviews: [review("keep", { evidence: ["e1"] })],
                conflicts: [],
            };
        },
        organizer: { summary: "", ops: [] },
        global: { summary: "", ops: [] },
    });

    await env.pass({ force: true, sessions: ["claude:s1"] });

    assert.match(analyzerInput, /Cache clears at startup/u);
    assert.equal(getItem(env.store, NOTE_ID)?.status, "active");
});

test("a global preference Note with a general user statement is reviewed after its writer joins a project", async (t) => {
    const env = createDreamEnv(t);
    const plain = join(env.home, "plain-pref");
    mkdirSync(plain, { recursive: true });
    env.addSession({
        id: "s1",
        events: [{ role: "user", text: "Always answer in English, in every project." }],
    });
    env.store.run("UPDATE sessions SET cwd = ? WHERE id = 's1'", plain);
    env.addItem({
        id: NOTE_ID,
        scope: "global",
        projectId: null,
        kind: "preference",
        title: "Answer in English",
        body: "Reply in English in every project.",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "s1",
    });
    new ProjectResolver(env.store).register(plain);
    env.route({
        analyzer: {
            summary: "Reviewed.",
            candidates: [
                {
                    kind: "preference",
                    title: "Answer in English",
                    body: "Reply in English in every project.",
                    trust: "user",
                    general: true,
                    evidence: ["e1"],
                    updates: null,
                },
            ],
            noteReviews: [review("keep", { evidence: ["e1"] })],
            conflicts: [],
        },
        organizer: { summary: "", ops: [] },
        global: { summary: "", ops: [] },
    });

    await env.pass({ force: true, sessions: ["claude:s1"] });

    const note = getItem(env.store, NOTE_ID);
    assert.equal(note?.status, "active");
    assert.equal(note?.general, true);
});

test("a project session cannot support a global promotion or retraction from outside a project", async (t) => {
    const env = createDreamEnv(t);
    const plain = join(env.home, "plain-route");
    mkdirSync(plain, { recursive: true });
    env.addSession({
        id: "s1",
        events: [
            { role: "user", text: "The cache is cleared at startup.", key: "s1-k1" },
            { role: "user", text: "Always answer in English, in every project.", key: "s1-k2" },
            { role: "user", text: "Stop answering in English.", key: "s1-k3" },
        ],
    });
    env.store.run("UPDATE sessions SET cwd = ? WHERE id = 's1'", plain);
    env.addItem({
        id: NOTE_ID,
        scope: "global",
        projectId: null,
        kind: "note",
        title: "Cache clears at startup",
        body: "The cache is cleared at startup.",
        status: "provisional",
        origin: "agent_note",
        trust: "inference",
        writerHarness: "claude",
        writerSession: "s1",
    });
    new ProjectResolver(env.store).register(plain);
    env.addProject("other", "Other project");
    env.addSession({
        id: "pref-session",
        projectId: "other",
        processedRevision: 1,
        events: [{ role: "user", text: "Always use spaces.", key: "p-k1", processed: true }],
    });
    // A changed project preference gives the global pass a reason to call the model.
    env.addItem({
        id: "existing-pref",
        projectId: "other",
        kind: "preference",
        title: "Use spaces",
        body: "Use spaces.",
        general: true,
        updatedRun: 999,
        sources: [eventSource("p-k1", "pref-session")],
    });
    env.addItem({
        id: "global-old",
        scope: "global",
        projectId: null,
        kind: "preference",
        title: "Answer in English",
        body: "Reply in English.",
        general: true,
        sources: [eventSource("old-k1")],
    });
    let globalInput = "";
    env.route({
        analyzer: {
            summary: "Reviewed.",
            candidates: [
                {
                    kind: "preference",
                    title: "Answer in English",
                    body: "Reply in English everywhere.",
                    trust: "user",
                    general: true,
                    evidence: ["e2"],
                    updates: null,
                },
            ],
            noteReviews: [review("keep", { evidence: ["e1"] })],
            conflicts: [],
        },
        organizer: { summary: "", ops: [] },
        global: (user) => {
            globalInput = user;
            return {
                summary: "attempt",
                ops: [
                    {
                        op: "promote",
                        title: "Answer in English",
                        body: "Reply in English everywhere.",
                        from: [],
                        evidence: ["s1.c1"],
                    },
                    {
                        op: "retire",
                        id: "global-old",
                        reason: "withdrawn",
                        from: [],
                        evidence: ["s1.e3"],
                    },
                ],
            };
        },
    });

    const summary = await env.pass({ force: true, sessions: ["claude:s1"] });

    assert.doesNotMatch(globalInput, /# General preferences from sessions outside a project/u);
    assert.doesNotMatch(globalInput, /# User statements from sessions outside a project/u);
    assert.match(globalInput, /Use spaces/u);
    assert.equal(summary.global?.called, true);
    assert.equal(summary.global?.counts.promoted, 0);
    assert.equal(summary.global?.counts.rejected, 2);
    assert.match(summary.global?.warnings.join("\n") ?? "", /Unknown evidence s1\.c1/u);
    assert.match(summary.global?.warnings.join("\n") ?? "", /Unknown evidence s1\.e3/u);
    assert.equal(getItem(env.store, "global-old")?.status, "active");
    assert.equal(
        listItems(env.store, { scope: "global", kind: ["preference"], status: ["active"] }).length,
        1,
    );
    assert.equal(getItem(env.store, NOTE_ID)?.status, "active");
});
