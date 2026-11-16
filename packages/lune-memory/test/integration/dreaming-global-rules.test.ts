import assert from "node:assert/strict";
import test from "node:test";

import { getItem, listItems } from "../../src/store/rows.ts";
import { analyzerReply, createDreamEnv, type DreamEnv } from "../harness/dreaming.ts";

const TITLE = "Answer in English";

function preferenceCandidate(general: boolean, title = TITLE) {
    return {
        kind: "preference",
        title,
        body: "Reply in English.",
        trust: "user",
        general,
        evidence: ["e1"],
        updates: null,
    };
}

const promote = (evidence: string[]) => ({
    op: "promote",
    title: TITLE,
    body: "Reply in English.",
    from: [],
    evidence,
});

/** One session outside a project with a single user statement. */
async function runLoose(env: DreamEnv, text: string) {
    env.addSession({ id: "loose", events: [{ role: "user", text }] });
    env.route({
        analyzer: analyzerReply([preferenceCandidate(true)]),
        global: { summary: "", ops: [promote(["s1.c1"])] },
    });
    return env.pass();
}

test("a statement that names one service is scoped and is not promoted to Global Memory", async (t) => {
    const env = createDreamEnv(t);

    const summary = await runLoose(env, "For this service, always answer in English.");

    assert.equal(summary.global?.counts.promoted, 0);
    assert.equal(summary.global?.counts.rejected, 1);
    assert.match(summary.global?.warnings.join("\n") ?? "", /needs a general user statement/u);
    assert.equal(listItems(env.store, { scope: "global", kind: ["preference"] }).length, 0);
});

test("a statement about all of the user's projects is accepted as general", async (t) => {
    const env = createDreamEnv(t);

    const summary = await runLoose(env, "Across all of my projects, reply in Chinese.");

    assert.equal(summary.global?.counts.promoted, 1);
    assert.equal(listItems(env.store, { scope: "global", kind: ["preference"] }).length, 1);
});

/** An active global preference whose own source is an older, processed session. */
function seedGlobalEnglish(env: DreamEnv): void {
    env.addSession({
        id: "older",
        events: [
            { role: "user", text: "Always answer in English.", key: "older-k1", processed: true },
        ],
        processedRevision: 1,
    });
    env.addItem({
        id: "g-english",
        scope: "global",
        projectId: null,
        kind: "preference",
        title: TITLE,
        body: "Reply in English in every project.",
        general: true,
        sources: [{ kind: "event", harness: "claude", sessionId: "older", eventKey: "older-k1" }],
    });
}

/** A new session outside a project, and an Analyzer that makes only an ordinary candidate. */
function seedRetractingSession(env: DreamEnv, text: string, reply: Record<string, unknown>) {
    env.addSession({ id: "loose", events: [{ role: "user", text }] });
    env.route({
        analyzer: analyzerReply([
            {
                kind: "decision",
                title: "Chat in Chinese",
                body: "The user chose Chinese. It was chosen for a reason that the user gave.",
                trust: "user",
                general: false,
                evidence: ["e1"],
                updates: null,
            },
        ]),
        global: reply,
    });
}

test("a retraction outside a project triggers the global pass and is listed in its input", async (t) => {
    const env = createDreamEnv(t);
    seedGlobalEnglish(env);
    const text = "Stop answering in English; use Chinese instead.";
    seedRetractingSession(env, text, {
        summary: "",
        ops: [
            { op: "retire", id: "g-english", reason: "withdrawn", from: [], evidence: ["s1.e1"] },
        ],
    });

    const summary = await env.pass();

    assert.deepEqual(env.calledRoles(), ["analyzer", "global"]);
    const input = env.calls.find((call) => call.role === "global")?.user ?? "";
    const section = input.split("# Retractions from sessions outside a project")[1] ?? "";
    assert.ok(section.includes(text));
    assert.equal(summary.global?.counts.retired, 1);
    assert.equal(getItem(env.store, "g-english")?.status, "retired");
});

test("a retraction outside a project does not call the model when no global preference exists", async (t) => {
    const env = createDreamEnv(t);
    seedRetractingSession(env, "Stop answering in English; use Chinese instead.", {
        summary: "",
        ops: [],
    });

    await env.pass();

    assert.deepEqual(env.calledRoles(), ["analyzer"]);
});

test("a retire that cites an unrelated retraction is rejected", async (t) => {
    const env = createDreamEnv(t);
    seedGlobalEnglish(env);
    seedRetractingSession(env, "Stop using tabs.", {
        summary: "",
        ops: [
            { op: "retire", id: "g-english", reason: "withdrawn", from: [], evidence: ["s1.e1"] },
        ],
    });

    const summary = await env.pass();

    assert.equal(summary.global?.counts.rejected, 1);
    assert.equal(summary.global?.counts.retired, 0);
    assert.match(summary.global?.warnings.join("\n") ?? "", /Rejected retire/u);
    assert.equal(getItem(env.store, "g-english")?.status, "active");
});
