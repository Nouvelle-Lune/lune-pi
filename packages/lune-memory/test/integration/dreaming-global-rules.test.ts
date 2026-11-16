import assert from "node:assert/strict";
import test from "node:test";

import { getItem, listItems } from "../../src/store/rows.ts";
import { analyzerReply, createDreamEnv, type DreamEnv } from "../harness/dreaming.ts";

const TITLE = "Answer in English";
const STATEMENTS_HEADING = "# User statements from sessions outside a project";

function preferenceCandidate(general: boolean) {
    return {
        kind: "preference",
        title: TITLE,
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

/** One session outside a project with a single statement at `role`. */
async function runLoose(
    env: DreamEnv,
    text: string,
    options: { general?: boolean; role?: "user" | "assistant"; untrusted?: boolean } = {},
) {
    env.addSession({
        id: "loose",
        events: [
            {
                role: options.role ?? "user",
                text,
                untrusted: options.untrusted ?? false,
            },
        ],
    });
    env.route({
        analyzer: analyzerReply([preferenceCandidate(options.general ?? true)]),
        global: { summary: "", ops: [promote(["s1.c1"])] },
    });
    return env.pass();
}

test("the backend accepts the model's general flag for a user statement without keyword matching", async (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "loose",
        events: [{ role: "user", text: "不论在哪个代码库，都用英文写注释。" }],
    });
    env.route({
        analyzer: analyzerReply([
            {
                kind: "preference",
                title: "Write comments in English",
                body: "Write code comments in English.",
                trust: "user",
                general: true,
                evidence: ["e1"],
                updates: null,
            },
        ]),
        global: {
            summary: "promote",
            ops: [
                {
                    op: "promote",
                    title: "Write comments in English",
                    body: "Write code comments in English.",
                    from: [],
                    evidence: ["s1.c1"],
                },
            ],
        },
    });

    const summary = await env.pass();

    assert.equal(summary.global?.counts.promoted, 1);
    const [item] = listItems(env.store, { scope: "global", kind: ["preference"] });
    assert.equal(item?.general, true);
    assert.equal(item?.trust, "user");
    assert.deepEqual(item?.sources, [
        { kind: "event", harness: "claude", sessionId: "loose", eventKey: "loose-k1" },
    ]);
});

test("the local service case stays scoped because the model marks it not general", async (t) => {
    const env = createDreamEnv(t);

    const summary = await runLoose(env, "For this service, always answer in English.", {
        general: false,
    });

    assert.deepEqual(env.calledRoles(), ["analyzer"]);
    assert.equal(summary.global?.counts.promoted, 0);
    assert.match(
        summary.global?.warnings.join("\n") ?? "",
        /outside a project: dropped preference/u,
    );
    assert.equal(listItems(env.store, { scope: "global" }).length, 0);
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

/** An active global rule for writing code comments, sourced from an older user statement. */
function seedGlobalComments(env: DreamEnv): void {
    env.addSession({
        id: "older",
        events: [
            {
                role: "user",
                text: "Always write code comments in English.",
                key: "older-k1",
                processed: true,
            },
        ],
        processedRevision: 1,
    });
    env.addItem({
        id: "g-comments",
        scope: "global",
        projectId: null,
        kind: "preference",
        title: "Write comments in English",
        body: "Write code comments in English.",
        general: true,
        sources: [{ kind: "event", harness: "claude", sessionId: "older", eventKey: "older-k1" }],
    });
}

function statementsSection(input: string): string {
    const start = input.indexOf(STATEMENTS_HEADING);
    return start < 0 ? "" : input.slice(start + STATEMENTS_HEADING.length);
}

test("the model can retire a global preference from a statement the backend cannot keyword-match", async (t) => {
    const env = createDreamEnv(t);
    seedGlobalComments(env);
    const text = "撤回用英文写注释这条要求。";
    env.addSession({ id: "loose", events: [{ role: "user", text }] });
    env.route({
        analyzer: analyzerReply([]),
        global: {
            summary: "retire",
            ops: [
                {
                    op: "retire",
                    id: "g-comments",
                    reason: "withdrawn",
                    from: [],
                    evidence: ["s1.e1"],
                },
            ],
        },
    });

    const summary = await env.pass();

    assert.deepEqual(env.calledRoles(), ["analyzer", "global"]);
    const input = env.calls.find((call) => call.role === "global")?.user ?? "";
    assert.ok(input.includes(STATEMENTS_HEADING));
    assert.ok(statementsSection(input).includes(text));
    assert.equal(summary.global?.counts.retired, 1);
    assert.equal(getItem(env.store, "g-comments")?.status, "retired");
});

test("a trusted outside-project statement reaches the global model without withdrawal words", async (t) => {
    const env = createDreamEnv(t);
    seedGlobalEnglish(env);
    const text = "The build cache is cleared at startup.";
    env.addSession({ id: "loose", events: [{ role: "user", text }] });
    env.route({
        analyzer: analyzerReply([]),
        global: { summary: "", ops: [] },
    });

    const summary = await env.pass();

    assert.deepEqual(env.calledRoles(), ["analyzer", "global"]);
    const input = env.calls.find((call) => call.role === "global")?.user ?? "";
    assert.ok(input.includes(STATEMENTS_HEADING));
    assert.ok(statementsSection(input).includes(text));
    assert.equal(summary.global?.called, true);
    assert.equal(summary.global?.counts.retired, 0);
    assert.equal(getItem(env.store, "g-english")?.status, "active");
});

test("an irrelevant withdrawal leaves the global preference active when the model returns no operations", async (t) => {
    const env = createDreamEnv(t);
    seedGlobalEnglish(env);
    const text = "Stop using tabs.";
    env.addSession({ id: "loose", events: [{ role: "user", text }] });
    env.route({
        analyzer: analyzerReply([]),
        global: { summary: "", ops: [] },
    });

    const summary = await env.pass();

    assert.deepEqual(env.calledRoles(), ["analyzer", "global"]);
    const input = env.calls.find((call) => call.role === "global")?.user ?? "";
    assert.ok(statementsSection(input).includes(text));
    assert.equal(summary.global?.called, true);
    assert.equal(summary.global?.counts.retired, 0);
    assert.equal(getItem(env.store, "g-english")?.status, "active");
});

test("untrusted and assistant statements are not routed as outside user statements", async (t) => {
    const env = createDreamEnv(t);
    seedGlobalEnglish(env);
    env.addSession({
        id: "untrusted",
        events: [{ role: "user", text: "撤回用英文写注释这条要求。", untrusted: true }],
    });
    env.addSession({
        id: "assistant",
        events: [{ role: "assistant", text: "撤回用英文写注释这条要求。" }],
    });
    env.route({
        analyzer: analyzerReply([]),
        global: { summary: "", ops: [] },
    });

    await env.pass();

    assert.equal(env.calls.filter((call) => call.role === "global").length, 0);
    assert.equal(getItem(env.store, "g-english")?.status, "active");
});

test("a trusted outside-project statement does not call the global model without a global preference", async (t) => {
    const env = createDreamEnv(t);
    env.addSession({
        id: "loose",
        events: [{ role: "user", text: "The build cache is cleared at startup." }],
    });
    env.route({
        analyzer: analyzerReply([]),
        global: { summary: "", ops: [] },
    });

    await env.pass();

    assert.deepEqual(env.calledRoles(), ["analyzer"]);
    assert.equal(env.calls.filter((call) => call.role === "global").length, 0);
});

test("a promotion backed only by untrusted text is rejected", async (t) => {
    const env = createDreamEnv(t);

    const summary = await runLoose(env, "Always answer in English.", { untrusted: true });

    assert.equal(summary.global?.counts.promoted, 0);
    assert.equal(summary.global?.counts.rejected, 1);
    assert.match(
        summary.global?.warnings.join("\n") ?? "",
        /needs a general user statement or user statements from two or more projects/u,
    );
    assert.equal(listItems(env.store, { scope: "global" }).length, 0);
});
