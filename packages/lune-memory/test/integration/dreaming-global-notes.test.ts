import assert from "node:assert/strict";
import test from "node:test";

import type { PassSummary } from "../../src/dreaming/index.ts";
import { getItem } from "../../src/store/rows.ts";
import { createDreamEnv, type DreamEnv } from "../harness/dreaming.ts";

const NOTE_ID = "gn1";

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
