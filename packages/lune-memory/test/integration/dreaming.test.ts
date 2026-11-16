import assert from "node:assert/strict";
import { existsSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DreamingBusyError, takeDreamLock, type DreamEvent } from "../../src/dreaming/index.ts";
import { getSession, listRuns } from "../../src/store/rows.ts";
import {
    analyzerReply,
    count,
    createDreamEnv,
    createOp,
    decisionCandidate,
    dreamingItems,
    oversizedBody,
    runCount,
    sessionOf,
    viewsContain,
    type DreamEnv,
} from "../harness/dreaming.ts";

const TITLE = "Use SQLite for storage";

/** One project with one session whose first event states a decision. */
function seedDecision(env: DreamEnv, sessionId = "s1", projectId = "p1"): void {
    if (!env.store.get("SELECT 1 AS n FROM projects WHERE id = ?", projectId)) {
        env.addProject(projectId, `Project ${projectId}`);
    }
    env.addSession({
        id: sessionId,
        projectId,
        events: [
            { role: "user", text: "We decided to use SQLite because the store is local." },
            { role: "assistant", text: "Noted." },
        ],
    });
}

function decisionScript(env: DreamEnv, title = TITLE): void {
    env.route({
        analyzer: analyzerReply([decisionCandidate(title)]),
        organizer: { summary: "Added a decision.", ops: [createOp(title, ["s1.c1"])] },
    });
}

test("a full pass analyzes, organizes and commits one decision with evidence", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    decisionScript(env);

    const summary = await env.pass();

    assert.equal(summary.status, "ok");
    assert.equal(summary.called, true);
    assert.equal(summary.eligible, 1);
    assert.deepEqual(env.calledRoles(), ["analyzer", "organizer"]);
    assert.equal(summary.projects.length, 1);
    assert.equal(summary.projects[0]?.status, "ok");
    assert.equal(summary.projects[0]?.counts?.created, 1);
    assert.equal(summary.usage.calls, 2);

    const items = dreamingItems(env, "p1");
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item?.kind, "decision");
    assert.equal(item?.title, TITLE);
    assert.equal(item?.status, "active");
    assert.equal(item?.trust, "user");
    assert.deepEqual(item?.sources, [
        { kind: "event", harness: "claude", sessionId: "s1", eventKey: "s1-k1" },
    ]);

    // The session and its events count as processed.
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision, 1);
    assert.equal(count(env, "SELECT COUNT(*) AS n FROM events WHERE processed_hash IS NULL"), 0);
    assert.equal(runCount(env, "project", "ok"), 1);
    assert.equal(summary.projection !== null, true);
    assert.equal(viewsContain(env, TITLE), true);
});

test("a second pass without a new revision does nothing", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    decisionScript(env);
    await env.pass();
    const generation = readlinkSync(env.paths.views);
    const runsBefore = listRuns(env.store, 100).length;
    const callsBefore = env.calls.length;

    const summary = await env.pass();

    assert.equal(summary.status, "idle");
    assert.equal(summary.called, false);
    assert.equal(summary.eligible, 0);
    assert.equal(summary.projection, null);
    assert.equal(env.calls.length, callsBefore);
    assert.equal(listRuns(env.store, 100).length, runsBefore);
    assert.equal(readlinkSync(env.paths.views), generation);
    assert.equal(dreamingItems(env, "p1").length, 1);
});

test("a new event on a processed session is analyzed again, and a repeated item is not duplicated", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    decisionScript(env);
    await env.pass();
    env.store.run("UPDATE sessions SET revision = 2 WHERE id = 's1'");
    // Same session id: an event row that the first pass has not seen.
    env.store.run(
        `INSERT INTO events (harness, session_id, key, seq, role, text, memory_derived, untrusted,
            active, hash) VALUES ('claude', 's1', 's1-k3', 3, 'user', 'More detail.', 0, 0, 1, 'h-s1-k3')`,
    );

    const summary = await env.pass();

    assert.equal(summary.eligible, 1);
    assert.equal(summary.called, true);
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision, 2);
    assert.equal(dreamingItems(env, "p1").length, 1);
});

test("each commit unit gets one run: a project run per project, one global run for sessions outside a project", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env, "a1", "pa");
    seedDecision(env, "a2", "pa");
    seedDecision(env, "b1", "pb");
    env.addSession({
        id: "loose",
        events: [{ role: "user", text: "Plain chat outside a project." }],
    });
    env.route({
        analyzer: (user) =>
            sessionOf(user) === "loose"
                ? analyzerReply([decisionCandidate("Dropped outside project")])
                : analyzerReply([decisionCandidate(`Decision of ${sessionOf(user)}`)]),
        organizer: (user) => {
            const refs = [...user.matchAll(/\[(s\d+)\.c1\]/gu)].map((match) => match[1]);
            return {
                summary: "ok",
                ops: refs.map((ref) =>
                    createOp(`Item ${ref} of ${user.includes("Name: Project pa") ? "pa" : "pb"}`, [
                        `${ref}.c1`,
                    ]),
                ),
            };
        },
    });

    const summary = await env.pass();

    assert.equal(summary.status, "ok");
    assert.equal(runCount(env, "project", "ok"), 2);
    assert.equal(runCount(env, "global", "ok"), 1);
    const runs = listRuns(env.store, 10).filter((run) => run.kind === "project");
    const sessionsByProject = new Map(runs.map((run) => [run.projectId, run.sessions.sort()]));
    assert.deepEqual(sessionsByProject.get("pa"), ["claude:a1", "claude:a2"]);
    assert.deepEqual(sessionsByProject.get("pb"), ["claude:b1"]);
    assert.equal(dreamingItems(env, "pa").length, 2);
    assert.equal(dreamingItems(env, "pb").length, 1);
    // A session outside a project keeps only general preferences. Its other candidates drop.
    assert.equal(dreamingItems(env, null).length, 0);
    assert.equal(getSession(env.store, "claude", "loose")?.processedRevision, 1);
    assert.deepEqual(
        env.calls.filter((call) => call.role === "global"),
        [],
    );
    const globalWarnings = summary.global?.warnings.join("\n") ?? "";
    assert.match(globalWarnings, /outside a project: dropped decision/u);
});

test("invalid JSON from the Analyzer fails that session and commits nothing for it", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    env.route({ analyzer: "this is not json", organizer: { summary: "", ops: [] } });

    const summary = await env.pass();

    assert.equal(summary.status, "failed");
    assert.deepEqual(summary.failedSessions, ["claude:s1"]);
    assert.deepEqual(env.calledRoles(), ["analyzer"]);
    assert.equal(dreamingItems(env, "p1").length, 0);
    assert.equal(runCount(env, "project", "failed"), 1);
    assert.equal(runCount(env, "project", "ok"), 0);
    const session = getSession(env.store, "claude", "s1");
    assert.equal(session?.processedRevision, null);
    assert.equal(session?.attempts, 1);
    assert.match(session?.lastError ?? "", /Analyzer: Model reply has no JSON object/u);
    assert.equal(
        count(env, "SELECT COUNT(*) AS n FROM events WHERE processed_hash IS NOT NULL"),
        0,
    );
    // A failed pass regenerates no projection.
    assert.equal(summary.projection, null);
    assert.equal(existsSync(env.paths.views), false);
});

test("a failing session does not block the other sessions of its project", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env, "bad");
    seedDecision(env, "good");
    env.route({
        analyzer: (user) =>
            sessionOf(user) === "bad" ? "oops" : analyzerReply([decisionCandidate(TITLE)]),
        organizer: { summary: "ok", ops: [createOp(TITLE, ["s1.c1"])] },
    });

    const summary = await env.pass();

    assert.equal(summary.status, "partial");
    assert.deepEqual(summary.failedSessions, ["claude:bad"]);
    assert.equal(dreamingItems(env, "p1").length, 1);
    assert.equal(getSession(env.store, "claude", "good")?.processedRevision, 1);
    assert.equal(getSession(env.store, "claude", "bad")?.processedRevision, null);
    assert.equal(summary.projection !== null, true);
});

test("an Organizer reply without a JSON object fails the project and leaves no partial state", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    env.route({
        analyzer: analyzerReply([decisionCandidate(TITLE)]),
        organizer: "I cannot organize this project.",
    });

    const summary = await env.pass();

    assert.equal(summary.status, "failed");
    assert.equal(summary.projects[0]?.status, "failed");
    assert.match(summary.projects[0]?.error ?? "", /Organizer: Model reply has no JSON object/u);
    assert.equal(dreamingItems(env, "p1").length, 0);
    assert.equal(runCount(env, "project", "failed"), 1);
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision, null);
    assert.equal(
        count(env, "SELECT COUNT(*) AS n FROM events WHERE processed_hash IS NOT NULL"),
        0,
    );
    assert.equal(summary.projection, null);
});

test("out-of-schema operations are dropped or rejected with warnings and create nothing", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    env.route({
        analyzer: analyzerReply([
            decisionCandidate(TITLE),
            { kind: "mystery", title: "x", body: "y", evidence: ["e1"] },
            { kind: "fact", title: "No evidence", body: "y", evidence: ["e99"] },
        ]),
        organizer: {
            summary: "mixed",
            ops: [
                { op: "explode" },
                { op: "create", kind: "decision", title: "", body: "no title" },
                createOp("Cites nothing", ["s9.c1"]),
                { op: "retire", id: "no-such-item", reason: "x" },
            ],
        },
    });

    const summary = await env.pass();

    const project = summary.projects[0];
    assert.equal(project?.status, "ok");
    assert.equal(project?.counts?.created, 0);
    assert.equal(project?.counts?.rejected, 2);
    const warnings = (project?.warnings ?? []).join("\n");
    assert.match(warnings, /unknown kind mystery/u);
    assert.match(warnings, /unknown op explode/u);
    assert.match(warnings, /create needs a title and a body/u);
    assert.match(warnings, /Rejected create: "Cites nothing" has no evidence/u);
    assert.match(warnings, /Rejected retire: item no-such-item is not an item of this project/u);
    assert.equal(dreamingItems(env, "p1").length, 0);
});

test("a commit over the startup-context budget rolls back every operation, after one retry with feedback", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    const oversized = {
        summary: "too big",
        ops: [
            createOp(TITLE, ["s1.c1"]),
            { op: "create", kind: "index", title: "Index", body: oversizedBody(), evidence: [] },
        ],
    };
    env.route({ analyzer: analyzerReply([decisionCandidate(TITLE)]), organizer: oversized });

    const summary = await env.pass();

    assert.equal(summary.status, "failed");
    assert.deepEqual(env.calledRoles(), ["analyzer", "organizer", "organizer"]);
    assert.match(env.calls[2]?.user ?? "", /The backend rejected your previous reply/u);
    assert.match(env.calls[2]?.user ?? "", /over the budget/u);
    assert.match(summary.projects[0]?.error ?? "", /over the budget/u);
    // The valid create in the same commit is not kept either.
    assert.equal(dreamingItems(env, "p1").length, 0);
    assert.equal(runCount(env, "project", "ok"), 0);
    assert.equal(runCount(env, "project", "failed"), 1);
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision, null);
    assert.equal(summary.projection, null);
});

test("an Organizer retry after a budget error can succeed", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    env.route({
        analyzer: analyzerReply([decisionCandidate(TITLE)]),
        organizer: [
            {
                summary: "too big",
                ops: [
                    {
                        op: "create",
                        kind: "index",
                        title: "I",
                        body: oversizedBody(),
                        evidence: [],
                    },
                ],
            },
            { summary: "short", ops: [createOp(TITLE, ["s1.c1"])] },
        ],
    });

    const summary = await env.pass();

    assert.equal(summary.status, "ok");
    assert.deepEqual(env.calledRoles(), ["analyzer", "organizer", "organizer"]);
    assert.deepEqual(
        dreamingItems(env, "p1").map((item) => item.title),
        [TITLE],
    );
});

test("a revision that fails maxAttempts times stops until force or a new revision", async (t) => {
    const env = createDreamEnv(t, { maxAttempts: 2 });
    seedDecision(env);
    env.route({ analyzer: "not json", organizer: { summary: "", ops: [] } });

    await env.pass();
    await env.pass();
    const stopped = await env.pass();

    assert.equal(stopped.stopped, 1);
    assert.equal(stopped.eligible, 0);
    assert.equal(stopped.called, false);
    assert.equal(env.calls.length, 2);

    const forced = await env.pass({ force: true });
    assert.equal(forced.eligible, 1);
    assert.equal(env.calls.length, 3);

    // A new revision resets the attempt count, so the session is eligible without force.
    env.store.run("UPDATE sessions SET revision = 2 WHERE id = 's1'");
    const next = await env.pass();
    assert.equal(next.eligible, 1);
    assert.equal(getSession(env.store, "claude", "s1")?.attempts, 1);
});

test("a recent session waits unless the pass is forced", async (t) => {
    const env = createDreamEnv(t);
    env.addProject("p1", "One");
    env.addSession({
        id: "fresh",
        projectId: "p1",
        idleHours: 1,
        events: [{ role: "user", text: "We decided to use SQLite." }],
    });
    decisionScript(env);

    const waiting = await env.pass();
    const forced = await env.pass({ force: true });

    assert.equal(waiting.waiting, 1);
    assert.equal(waiting.called, false);
    assert.equal(waiting.status, "idle");
    assert.equal(forced.eligible, 1);
    assert.equal(forced.status, "ok");
});

test("without a configured model the pass reports no-model and changes nothing", async (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = null;
    seedDecision(env);
    env.route({});

    const summary = await env.pass();

    assert.equal(summary.status, "no-model");
    assert.equal(summary.called, false);
    assert.match(summary.errors.join("\n"), /no model is configured/u);
    assert.equal(env.calls.length, 0);
    assert.equal(listRuns(env.store, 10).length, 0);
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision, null);
});

test("an unknown configured model also reports no-model without throwing", async (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = "faux-dream/missing";
    seedDecision(env);

    const summary = await env.pass();

    assert.equal(summary.status, "no-model");
    assert.match(summary.errors.join("\n"), /Unknown Dreaming model: faux-dream\/missing/u);
});

test("without a model and without work the pass is idle, not an error", async (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = null;

    const summary = await env.pass();

    assert.equal(summary.status, "idle");
    assert.deepEqual(summary.errors, []);
});

test("an explicit model override is used instead of the configured one", async (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = null;
    seedDecision(env);
    const seen: string[] = [];
    const model = {
        ref: "override/model",
        async complete(system: string) {
            seen.push(system.slice(0, 30));
            const text = system.startsWith("You are the Session Analyzer")
                ? JSON.stringify(analyzerReply([decisionCandidate(TITLE)]))
                : JSON.stringify({ summary: "", ops: [createOp(TITLE, ["s1.c1"])] });
            return { text, usage: { calls: 1 } };
        },
    };

    const summary = await env.pass({ model });

    assert.equal(summary.status, "ok");
    assert.equal(seen.length, 2);
    assert.equal(listRuns(env.store, 1)[0]?.model, "override/model");
});

test("the Dream lock gives DreamingBusyError to a second holder and frees on release", (t) => {
    const env = createDreamEnv(t);

    const release = takeDreamLock(env.paths);
    assert.throws(() => takeDreamLock(env.paths), DreamingBusyError);
    release();

    const again = takeDreamLock(env.paths);
    again();
});

test("a lock left by a stopped process is taken over", (t) => {
    const env = createDreamEnv(t);
    takeDreamLock(env.paths)();
    writeFileSync(join(env.paths.home, "dream.lock"), "2147483646");

    const release = takeDreamLock(env.paths);

    release();
    assert.equal(existsSync(join(env.paths.home, "dream.lock")), false);
});

test("a pass while the lock is held reports busy and calls no model", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    decisionScript(env);
    const release = takeDreamLock(env.paths);

    const summary = await env.pass();
    release();

    assert.equal(summary.status, "busy");
    assert.equal(env.calls.length, 0);
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision, null);
    const after = await env.pass();
    assert.equal(after.status, "ok");
});

test("the pass releases its lock, even after a failure", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    env.route({ analyzer: "not json" });

    await env.pass();

    assert.equal(existsSync(join(env.paths.home, "dream.lock")), false);
});

test("events are emitted in order and a throwing listener does not stop the pass", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env);
    decisionScript(env);
    const types: string[] = [];

    const summary = await env.pass({
        onEvent: (event: DreamEvent) => {
            types.push(event.type);
            throw new Error("listener failure");
        },
    });

    assert.equal(summary.status, "ok");
    assert.deepEqual(types, [
        "pass_started",
        "session_analyzed",
        "project_committed",
        "projection_written",
        "pass_finished",
    ]);
});

test("the sessions option limits a pass to the named sessions", async (t) => {
    const env = createDreamEnv(t);
    seedDecision(env, "s1");
    seedDecision(env, "s2");
    decisionScript(env);

    const summary = await env.pass({ sessions: ["claude:s2"] });

    assert.equal(summary.eligible, 1);
    assert.equal(getSession(env.store, "claude", "s2")?.processedRevision, 1);
    assert.equal(getSession(env.store, "claude", "s1")?.processedRevision, null);
});
