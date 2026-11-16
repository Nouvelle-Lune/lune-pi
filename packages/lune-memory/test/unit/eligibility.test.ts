import assert from "node:assert/strict";
import test from "node:test";

import { findEligible, markTrivial } from "../../src/dreaming/eligibility.ts";
import { getSession } from "../../src/store/rows.ts";
import { createDreamEnv, NOW, type DreamEnv } from "../harness/dreaming.ts";

const user = (text: string) => ({ role: "user" as const, text });

function labels(result: ReturnType<typeof findEligible>): string[] {
    return result.eligible.map((snapshot) => snapshot.session.id).sort();
}

function find(env: DreamEnv, options: Parameters<typeof findEligible>[2] = {}) {
    return findEligible(env.store, env.config.dreaming, { now: NOW, ...options });
}

test("a session stable for six hours with an unprocessed revision is eligible", (t) => {
    const env = createDreamEnv(t);
    env.addSession({ id: "stable", idleHours: 6.5, events: [user("hello")] });

    const actual = find(env);

    assert.deepEqual(labels(actual), ["stable"]);
    assert.equal(actual.waiting, 0);
});

test("a session that changed within the idle window waits", (t) => {
    const env = createDreamEnv(t);
    env.addSession({ id: "fresh", idleHours: 5, events: [user("hello")] });

    const actual = find(env);

    assert.deepEqual(labels(actual), []);
    assert.equal(actual.waiting, 1);
});

test("force skips the idle window", (t) => {
    const env = createDreamEnv(t);
    env.addSession({ id: "fresh", idleHours: 0.1, events: [user("hello")] });

    const actual = find(env, { force: true });

    assert.deepEqual(labels(actual), ["fresh"]);
    assert.equal(actual.waiting, 0);
});

test("a revision at the attempt limit is stopped, and force skips the limit", (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "stuck",
        revision: 4,
        attempts: env.config.dreaming.maxAttempts,
        attemptRevision: 4,
        events: [user("hello")],
    });

    const normal = find(env);
    const forced = find(env, { force: true });

    assert.equal(normal.stopped, 1);
    assert.deepEqual(labels(normal), []);
    assert.deepEqual(labels(forced), ["stuck"]);
});

test("attempts of an older revision do not stop a new revision", (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "retry",
        revision: 5,
        attempts: env.config.dreaming.maxAttempts,
        attemptRevision: 4,
        events: [user("hello")],
    });

    const actual = find(env);

    assert.deepEqual(labels(actual), ["retry"]);
    assert.equal(actual.stopped, 0);
});

test("a processed session is not selected until it has a new revision or event", (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "done",
        revision: 2,
        processedRevision: 2,
        events: [{ role: "user", text: "hello", processed: true }],
    });
    env.addSession({
        id: "newrev",
        revision: 3,
        processedRevision: 2,
        events: [user("changed")],
    });

    const actual = find(env);

    assert.deepEqual(labels(actual), ["newrev"]);
    assert.equal(actual.trivial.length, 0);
});

test("a new revision without unprocessed evidence is trivial and needs no model", (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "quiet",
        revision: 2,
        processedRevision: 1,
        events: [
            { role: "user", text: "old", processed: true },
            { role: "assistant", text: "from memory", memoryDerived: true },
            { role: "user", text: "inactive", active: false },
        ],
    });

    const actual = find(env);
    const marked = markTrivial(env.store, actual.trivial);

    assert.deepEqual(labels(actual), []);
    assert.deepEqual(
        actual.trivial.map((session) => session.id),
        ["quiet"],
    );
    assert.equal(marked, 1);
    assert.equal(getSession(env.store, "claude", "quiet")?.processedRevision, 2);
});

test("sessions with an import error are never eligible", (t) => {
    const env = createDreamEnv(t);
    env.addSession({ id: "broken", status: "error", events: [user("hello")] });

    assert.deepEqual(labels(find(env)), []);
});

test("the pass budget defers sessions over maxSessionsPerPass, oldest change first", (t) => {
    const env = createDreamEnv(t, { maxSessionsPerPass: 2 });
    env.addSession({ id: "s3", idleHours: 8, events: [user("c")] });
    env.addSession({ id: "s1", idleHours: 30, events: [user("a")] });
    env.addSession({ id: "s2", idleHours: 20, events: [user("b")] });

    const actual = find(env);

    assert.deepEqual(labels(actual), ["s1", "s2"]);
    assert.equal(actual.deferred, 1);
});

test("projectId and sessions filters narrow the selection", (t) => {
    const env = createDreamEnv(t);
    env.addProject("p1", "One");
    env.addSession({ id: "in-p1", projectId: "p1", events: [user("a")] });
    env.addSession({ id: "loose", projectId: null, events: [user("b")] });
    env.addSession({ id: "other", harness: "codex", projectId: "p1", events: [user("c")] });

    assert.deepEqual(labels(find(env, { projectId: "p1" })), ["in-p1", "other"]);
    assert.deepEqual(labels(find(env, { projectId: null })), ["loose"]);
    assert.deepEqual(labels(find(env, { sessions: ["codex:other"] })), ["other"]);
});

test("the snapshot covers new events, adds context, and is partial over the character budget", (t) => {
    const env = createDreamEnv(t, { maxCharsPerSession: 100 });
    const big = "x".repeat(2500);
    env.addSession({
        id: "long",
        events: [
            { role: "user", text: "already seen", processed: true },
            { role: "user", text: big },
            { role: "user", text: big },
        ],
    });

    const [snapshot] = find(env).eligible;

    assert.ok(snapshot);
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.covered.size, 1);
    assert.deepEqual(
        snapshot.events.map((entry) => entry.role),
        ["context", "new"],
    );
    assert.equal(snapshot.events[1]?.truncated, true);
});
