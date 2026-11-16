import assert from "node:assert/strict";
import test from "node:test";

import { refreshBranches } from "../../src/dreaming/branches.ts";
import { getItem, listItems } from "../../src/store/rows.ts";
import {
    analyzerReply,
    count,
    createDreamEnv,
    createGitRepo,
    createOp,
    type DreamEnv,
    type GitFixture,
} from "../harness/dreaming.ts";

function repoProject(env: DreamEnv): GitFixture {
    const repo = createGitRepo(env.home);
    env.addProject("p1", "Repo project", repo.root);
    return repo;
}

function branchRow(env: DreamEnv, name: string) {
    return env.store.get(
        "SELECT status, closed_at, handled_run FROM branches WHERE project_id = 'p1' AND name = ?",
        name,
    );
}

const progress = (title: string) => ({
    kind: "progress",
    title,
    body: `${title}. The parser is done and the tests are next.`,
    trust: "inference",
    general: false,
    evidence: ["e1"],
    updates: null,
});

test("Working State follows the Git branch of the cited session", async (t) => {
    const env = createDreamEnv(t);
    const repo = repoProject(env);
    repo.branch("feat/a");
    repo.branch("feat/b");
    env.addSession({
        id: "a",
        projectId: "p1",
        branch: "feat/a",
        idleHours: 20,
        events: [{ role: "user", text: "Work on A: the parser is done." }],
    });
    env.addSession({
        id: "b",
        projectId: "p1",
        branch: "feat/b",
        idleHours: 10,
        events: [{ role: "user", text: "Work on B: the exporter is started." }],
    });
    env.route({
        analyzer: (user) =>
            analyzerReply([progress(user.includes("Session: a") ? "State of A" : "State of B")]),
        organizer: {
            summary: "state",
            ops: [
                createOp("State of A", ["s1.c1"], { kind: "working_state" }),
                createOp("State of B", ["s2.c1"], { kind: "working_state" }),
            ],
        },
    });

    const summary = await env.pass();

    assert.equal(summary.status, "ok");
    const states = listItems(env.store, {
        scope: "project",
        projectId: "p1",
        kind: ["working_state"],
    });
    const actual = Object.fromEntries(states.map((item) => [item.title, item.branch]));
    assert.deepEqual(actual, { "State of A": "feat/a", "State of B": "feat/b" });
});

test("a merged branch closes: its Working State and open items retire after one Organizer call", async (t) => {
    const env = createDreamEnv(t);
    const repo = repoProject(env);
    repo.branch("feat/a");
    repo.run("merge", "-q", "feat/a");
    env.addBranch("p1", "feat/a");
    env.addBranch("p1", "main");
    env.addItem({
        id: "ws",
        kind: "working_state",
        title: "State of A",
        body: "Done.",
        projectId: "p1",
        branch: "feat/a",
    });
    env.addItem({
        id: "todo",
        kind: "open_item",
        title: "Todo on A",
        body: "Open.",
        projectId: "p1",
        branch: "feat/a",
    });
    env.addItem({ id: "keep", kind: "fact", title: "Fact", body: "Stays.", projectId: "p1" });
    env.route({ organizer: { summary: "closed", ops: [] } });

    const first = await env.pass();

    assert.deepEqual(first.closedBranches, ["p1:feat/a"]);
    assert.equal(first.status, "ok");
    assert.deepEqual(env.calledRoles(), ["organizer"]);
    assert.match(env.calls[0]?.user ?? "", /## feat\/a \(merged/u);
    assert.equal(getItem(env.store, "ws")?.status, "retired");
    assert.equal(getItem(env.store, "todo")?.status, "retired");
    assert.equal(getItem(env.store, "keep")?.status, "active");
    assert.equal(branchRow(env, "feat/a")?.status, "merged");
    assert.notEqual(branchRow(env, "feat/a")?.handled_run, null);
    assert.equal(branchRow(env, "main")?.status, "open");

    const second = await env.pass();

    assert.deepEqual(second.closedBranches, []);
    assert.equal(second.status, "idle");
    assert.equal(env.calls.length, 1);
});

test("a deleted branch with nothing left closes without a model", async (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = null;
    repoProject(env);
    env.addBranch("p1", "feat/gone");

    const summary = await env.pass();

    assert.deepEqual(summary.closedBranches, ["p1:feat/gone"]);
    assert.equal(summary.status, "ok");
    assert.equal(summary.called, false);
    assert.equal(branchRow(env, "feat/gone")?.status, "deleted");
    assert.notEqual(branchRow(env, "feat/gone")?.handled_run, null);
});

test("a closed branch with items and no model waits and the pass reports no-model", async (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = null;
    repoProject(env);
    env.addBranch("p1", "feat/gone");
    env.addItem({
        id: "ws",
        kind: "working_state",
        title: "State",
        body: "x",
        projectId: "p1",
        branch: "feat/gone",
    });

    const summary = await env.pass();

    assert.equal(summary.status, "no-model");
    assert.equal(getItem(env.store, "ws")?.status, "active");
    assert.equal(branchRow(env, "feat/gone")?.handled_run, null);
});

test("a closed branch reopens when a newer session uses it and Git reports it open", (t) => {
    const env = createDreamEnv(t);
    const repo = repoProject(env);
    repo.branch("feat/a");
    env.addBranch("p1", "feat/a", "merged");
    env.store.run("UPDATE branches SET handled_run = 7 WHERE name = 'feat/a'");
    // The session changed after the branch closed (closed 50h ago, session 10h ago).
    env.addSession({ id: "back", projectId: "p1", branch: "feat/a", idleHours: 10, events: [] });

    const actual = refreshBranches(env.store, "p1", Date.parse("2030-01-15T12:00:00.000Z"));

    assert.deepEqual(actual.reopened, ["feat/a"]);
    const row = branchRow(env, "feat/a");
    assert.equal(row?.status, "open");
    assert.equal(row?.closed_at, null);
    assert.equal(row?.handled_run, null);
});

test("a closed branch without newer sessions is not checked again", (t) => {
    const env = createDreamEnv(t);
    const repo = repoProject(env);
    repo.branch("feat/a");
    env.addBranch("p1", "feat/a", "merged");
    env.addSession({ id: "old", projectId: "p1", branch: "feat/a", idleHours: 80, events: [] });

    const actual = refreshBranches(env.store, "p1", Date.parse("2030-01-15T12:00:00.000Z"));

    assert.equal(actual.checked, 0);
    assert.equal(branchRow(env, "feat/a")?.status, "merged");
    assert.equal(count(env, "SELECT COUNT(*) AS n FROM branches WHERE status = 'open'"), 0);
});

test("an open branch whose ref is gone closes as deleted, and a mainline branch stays open", (t) => {
    const env = createDreamEnv(t);
    repoProject(env);
    env.addBranch("p1", "feat/missing");
    env.addBranch("p1", "main");

    const actual = refreshBranches(env.store, "p1");

    assert.deepEqual(actual.closed, ["feat/missing"]);
    assert.equal(branchRow(env, "feat/missing")?.status, "deleted");
    assert.equal(branchRow(env, "main")?.status, "open");
});
