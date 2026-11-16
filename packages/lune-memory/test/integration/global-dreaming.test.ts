import assert from "node:assert/strict";
import test from "node:test";

import { runGlobalPass } from "../../src/dreaming/global.ts";
import { createDreamingModel } from "../../src/dreaming/model.ts";
import { revertRun } from "../../src/memory/revert.ts";
import { getItem, listItems, startRun } from "../../src/store/rows.ts";
import {
    analyzerReply,
    createDreamEnv,
    createOp,
    NOW,
    oversizedBody,
    runCount,
    type DreamEnv,
} from "../harness/dreaming.ts";

const TITLE = "Answer in English";

/** A project preference with a user statement behind it. */
function seedPreference(
    env: DreamEnv,
    id: string,
    projectId: string,
    options: { general?: boolean; role?: "user" | "assistant"; title?: string } = {},
): void {
    if (!env.store.get("SELECT 1 AS n FROM projects WHERE id = ?", projectId)) {
        env.addProject(projectId, `Project ${projectId}`);
    }
    env.addSession({
        id: `sess-${id}`,
        projectId,
        events: [
            {
                role: options.role ?? "user",
                text: "Always answer in English.",
                key: `ev-${id}`,
                processed: true,
            },
        ],
        processedRevision: 1,
    });
    env.addItem({
        id,
        kind: "preference",
        title: options.title ?? TITLE,
        body: "Reply in English in every project.",
        projectId,
        general: options.general ?? false,
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

const promote = (from: string[], extra: Record<string, unknown> = {}) => ({
    op: "promote",
    title: TITLE,
    body: "Reply in English everywhere.",
    from,
    evidence: [],
    ...extra,
});

test("with no preference change and no general candidate the global pass makes no model call", async (t) => {
    const env = createDreamEnv(t);
    env.route({ global: { summary: "", ops: [] } });

    const actual = await runGlobal(env);

    assert.equal(actual.status, "skipped");
    assert.equal(actual.called, false);
    assert.equal(env.calls.length, 0);
    assert.equal(runCount(env, "global", "ok"), 0);
});

test("a changed project preference calls the model once, and an unchanged state does not call again", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1");
    env.route({ global: { summary: "nothing to promote", ops: [] } });

    const first = await runGlobal(env);
    const second = await runGlobal(env);

    assert.equal(first.status, "ok");
    assert.equal(first.called, true);
    assert.equal(second.status, "skipped");
    assert.equal(second.called, false);
    assert.equal(env.calls.length, 1);
    assert.match(env.calls[0]?.user ?? "", /\[pref1\]/u);
});

test("a general user statement promotes a project preference to Global Memory and retires the original", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1", { general: true });
    env.route({ global: { summary: "promoted", ops: [promote(["pref1"])] } });

    const actual = await runGlobal(env);

    assert.equal(actual.status, "ok");
    assert.equal(actual.counts.promoted, 1);
    const globals = listItems(env.store, { scope: "global", kind: ["preference"] });
    assert.equal(globals.length, 1);
    const [item] = globals;
    assert.equal(item?.origin, "dreaming");
    assert.equal(item?.status, "active");
    assert.equal(item?.trust, "user");
    assert.equal(item?.general, true);
    assert.equal(item?.projectId, null);
    assert.deepEqual(item?.sources, [
        { kind: "event", harness: "claude", sessionId: "sess-pref1", eventKey: "ev-pref1" },
    ]);
    assert.equal(getItem(env.store, "pref1")?.status, "retired");
    assert.equal(runCount(env, "global", "ok"), 1);
});

test("user statements in two projects support a promotion without a general statement", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pa", "pa", { title: "English A" });
    seedPreference(env, "pb", "pb", { title: "English B" });
    env.route({ global: { summary: "", ops: [promote(["pa", "pb"])] } });

    const actual = await runGlobal(env);

    assert.equal(actual.counts.promoted, 1);
    assert.equal(listItems(env.store, { scope: "global", kind: ["preference"] }).length, 1);
    assert.equal(getItem(env.store, "pa")?.status, "retired");
    assert.equal(getItem(env.store, "pb")?.status, "retired");
});

test("a promotion with one project and no general statement is rejected, not written", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1");
    env.route({ global: { summary: "", ops: [promote(["pref1"])] } });

    const actual = await runGlobal(env);

    assert.equal(actual.status, "ok");
    assert.equal(actual.counts.promoted, 0);
    assert.equal(actual.counts.rejected, 1);
    assert.match(
        actual.warnings.join("\n"),
        /needs a general user statement or user statements from two or more projects/u,
    );
    assert.equal(listItems(env.store, { scope: "global" }).length, 0);
    assert.equal(getItem(env.store, "pref1")?.status, "active");
});

test("a promotion backed only by an assistant event is rejected", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1", { general: true, role: "assistant" });
    env.route({ global: { summary: "", ops: [promote(["pref1"])] } });

    const actual = await runGlobal(env);

    assert.equal(actual.counts.rejected, 1);
    assert.equal(listItems(env.store, { scope: "global" }).length, 0);
});

test("a promotion that cites an unknown preference is rejected", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1", { general: true });
    env.route({ global: { summary: "", ops: [promote(["no-such-item"])] } });

    const actual = await runGlobal(env);

    assert.equal(actual.counts.rejected, 1);
    assert.match(actual.warnings.join("\n"), /no-such-item is not an active project preference/u);
});

test("a reply without JSON fails the global run and changes nothing", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1", { general: true });
    env.route({ global: "I have no changes." });

    const actual = await runGlobal(env);

    assert.equal(actual.status, "failed");
    assert.match(actual.error ?? "", /no JSON object/u);
    assert.equal(runCount(env, "global", "failed"), 1);
    assert.equal(listItems(env.store, { scope: "global" }).length, 0);
    assert.equal(getItem(env.store, "pref1")?.status, "active");
});

test("a budget error is retried once with feedback, and the retry can commit", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1", { general: true });
    env.route({
        global: [
            { summary: "big", ops: [promote(["pref1"], { body: oversizedBody() })] },
            { summary: "short", ops: [promote(["pref1"])] },
        ],
    });

    const actual = await runGlobal(env);

    assert.equal(actual.status, "ok");
    assert.equal(env.calls.length, 2);
    assert.match(env.calls[1]?.user ?? "", /The backend rejected your previous reply/u);
    assert.match(env.calls[1]?.user ?? "", /over the budget/u);
    const globals = listItems(env.store, { scope: "global", kind: ["preference"] });
    assert.deepEqual(
        globals.map((item) => item.body),
        ["Reply in English everywhere."],
    );
});

test("a second budget error fails the run after exactly one retry and rolls back", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1", { general: true });
    env.route({
        global: { summary: "big", ops: [promote(["pref1"], { body: oversizedBody() })] },
    });

    const actual = await runGlobal(env);

    assert.equal(actual.status, "failed");
    assert.match(actual.error ?? "", /over the budget/u);
    assert.equal(env.calls.length, 2);
    assert.equal(listItems(env.store, { scope: "global" }).length, 0);
    assert.equal(getItem(env.store, "pref1")?.status, "active");
    assert.equal(runCount(env, "global", "ok"), 0);
    assert.equal(runCount(env, "global", "failed"), 1);
});

test("a pass that creates a project preference runs the global pass once, then goes idle", async (t) => {
    const env = createDreamEnv(t);
    env.addProject("p1", "One");
    env.addSession({
        id: "s1",
        projectId: "p1",
        events: [{ role: "user", text: "In this project, always answer in English." }],
    });
    const candidate = {
        kind: "preference",
        title: TITLE,
        body: "Reply in English.",
        trust: "user",
        general: false,
        evidence: ["e1"],
        updates: null,
    };
    env.route({
        analyzer: analyzerReply([candidate]),
        organizer: {
            summary: "",
            ops: [createOp(TITLE, ["s1.c1"], { kind: "preference", body: "Reply in English." })],
        },
        global: { summary: "one project only", ops: [] },
    });

    const first = await env.pass();
    const second = await env.pass();

    assert.equal(first.status, "ok");
    assert.deepEqual(env.calledRoles(), ["analyzer", "organizer", "global"]);
    assert.equal(first.global?.status, "ok");
    assert.equal(first.global?.called, true);
    assert.equal(second.status, "idle");
    assert.equal(second.global, null);
    assert.equal(env.calls.length, 3);
});

test("a session outside a project with a general preference promotes to Global Memory", async (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "loose",
        events: [{ role: "user", text: "In every project, answer in English." }],
    });
    env.route({
        analyzer: analyzerReply([
            {
                kind: "preference",
                title: TITLE,
                body: "Reply in English in every project.",
                trust: "user",
                general: true,
                evidence: ["e1"],
                updates: null,
            },
        ]),
        global: { summary: "promoted", ops: [promote([], { evidence: ["s1.c1"] })] },
    });

    const summary = await env.pass();

    assert.equal(summary.status, "ok");
    assert.deepEqual(env.calledRoles(), ["analyzer", "global"]);
    assert.equal(summary.global?.counts.promoted, 1);
    const globals = listItems(env.store, { scope: "global", kind: ["preference"] });
    assert.equal(globals.length, 1);
    assert.equal(globals[0]?.trust, "user");
    assert.equal(summary.projection !== null, true);
});

test("a changed preference with no model configured reports no-model and writes nothing", async (t) => {
    const env = createDreamEnv(t);
    env.config.dreaming.model = null;
    seedPreference(env, "pref1", "p1", { general: true });

    const summary = await env.pass();

    assert.equal(summary.status, "no-model");
    assert.equal(summary.global, null);
    assert.equal(runCount(env, "global", "ok") + runCount(env, "global", "failed"), 0);
    assert.equal(listItems(env.store, { scope: "global" }).length, 0);
});

test("a reverted global run is not applied again by the next pass without new input", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1", { general: true });
    env.route({ global: { summary: "promoted", ops: [promote(["pref1"])] } });

    const first = await env.pass();

    assert.equal(first.global?.status, "ok");
    assert.equal(listItems(env.store, { scope: "global", kind: ["preference"] }).length, 1);
    const runId = first.global?.runId;
    assert.ok(runId);
    revertRun(env.store, env.paths, runId, { reprocess: false, generations: 3 });
    assert.equal(listItems(env.store, { scope: "global", kind: ["preference"] }).length, 0);
    const callsBefore = env.calls.length;

    const second = await env.pass();

    assert.equal(env.calls.length, callsBefore);
    assert.equal(second.global, null);
    assert.equal(listItems(env.store, { scope: "global", kind: ["preference"] }).length, 0);
    assert.equal(runCount(env, "global", "reverted"), 1);
    assert.equal(runCount(env, "global", "ok"), 0);
});

test("a project preference that changes after a reverted global run starts a new global pass", async (t) => {
    const env = createDreamEnv(t);
    seedPreference(env, "pref1", "p1", { general: true });
    env.route({ global: { summary: "promoted", ops: [promote(["pref1"])] } });
    const first = await env.pass();
    const runId = first.global?.runId;
    assert.ok(runId);
    revertRun(env.store, env.paths, runId, { reprocess: false, generations: 3 });
    // A later run changes the preference, so the global pass has new input.
    const later = startRun(env.store, { kind: "project", trigger: "test" });
    env.store.run("UPDATE items SET updated_run = ? WHERE id = 'pref1'", later);
    const callsBefore = env.calls.length;

    const second = await env.pass();

    assert.equal(second.global?.called, true);
    assert.equal(env.calls.length, callsBefore + 1);
});
