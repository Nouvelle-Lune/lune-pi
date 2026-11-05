import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
    buildRunNotification,
    deliveredTurns,
    RUN_NOTIFICATION_TYPE,
    RunNotifier,
    turnKey,
    type NoticeRouting,
    type ParentSession,
    type RunNotice,
} from "../../src/notify/notifier.ts";
import { fakePi, turn } from "./support.ts";

const done = (runId: string, name = runId, summary = "Finished."): RunNotice => ({
    runId,
    name,
    record: turn({ report: { status: "done", summary } }),
});

function fakeUi() {
    const notified: Array<{ message: string; type: string | undefined }> = [];
    const ui = {
        notify: (message: string, type?: string) => notified.push({ message, type }),
    } as unknown as ExtensionUIContext;

    return { ui, notified };
}

/** Delivers everything unless `deliverable` says otherwise; held notices are recorded. */
function routing(deliverable: (notice: RunNotice) => boolean = () => true) {
    const held: RunNotice[] = [];
    const noticeRouting: NoticeRouting = {
        deliverable,
        hold: (notice) => held.push(notice),
    };

    return { routing: noticeRouting, held };
}

/** The main agent as the notifier sees it; tests change the fields between calls. */
interface FakeParent extends ParentSession {
    isBusy: boolean;
    isAborting: boolean;
    clearsQueues: boolean;
    delivered: Set<string>;
}

function fakeParent(): FakeParent {
    const parent: FakeParent = {
        isBusy: true,
        isAborting: false,
        clearsQueues: true,
        delivered: new Set(),
        busy: () => parent.isBusy,
        aborting: () => parent.isAborting,
        abortClearsQueues: () => parent.clearsQueues,
        deliveredTurns: () => parent.delivered,
    };

    return parent;
}

/** Mocked timers make the batching windows exact without sleeping. */
function fixture(t: TestContext, deliverable?: (notice: RunNotice) => boolean) {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const pi = fakePi();
    const { ui, notified } = fakeUi();
    const { routing: noticeRouting, held } = routing(deliverable);
    const parent = fakeParent();
    const notifier = new RunNotifier(pi.api, ui, noticeRouting, parent);

    t.after(() => notifier.dispose());

    return { pi, notifier, notified, held, parent, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("a normal notice states the run, its state and the report", () => {
    const { content, details } = buildRunNotification([
        {
            runId: "r1",
            name: "reviewer",
            record: turn({ report: { status: "done", summary: "No problems." } }),
        },
    ]);

    assert.equal(
        content,
        [
            "Subagent run r1 ended its turn: idle.",
            "Report: done",
            "",
            "Summary:",
            "No problems.",
        ].join("\n"),
    );
    assert.equal(details.runs[0]!.durationMs, 4200);
    assert.equal(details.runs[0]!.reportStatus, "done");
});

test("a titled notice adds the title below the ID line", () => {
    const { content, details } = buildRunNotification([
        {
            runId: "r1",
            name: "reviewer",
            title: "Review the diff",
            record: turn({ report: { status: "done", summary: "No problems." } }),
        },
    ]);

    assert.equal(
        content,
        [
            "Subagent run r1 ended its turn: idle.",
            "Title: Review the diff",
            "Report: done",
            "",
            "Summary:",
            "No problems.",
        ].join("\n"),
    );
    assert.equal(details.runs[0]!.name, "Review the diff");
});

test("body offsets in details point at the summary inside the content", () => {
    const { content, details } = buildRunNotification([
        done("r1", "one", "First body."),
        done("r2", "two", "Second body."),
    ]);

    const bodies = details.runs.map((run) => content.slice(run.body.start, run.body.end));

    assert.deepEqual(bodies, ["First body.", "Second body."]);
});

test("a blocked report lists its reason and a needs_input report its question", () => {
    const { content } = buildRunNotification([
        {
            runId: "r1",
            name: "a",
            record: turn({ report: { status: "blocked", summary: "Partial.", reason: "No key." } }),
        },
        {
            runId: "r2",
            name: "b",
            record: turn({
                report: { status: "needs_input", summary: "Waiting.", question: "Which one?" },
            }),
        },
    ]);

    assert.match(content, /Report: blocked\nReason: No key\./);
    assert.match(content, /Report: needs_input\nQuestion: Which one\?/);
});

test("a turn without a report says it is unreported and quotes the last message", () => {
    const { content, details } = buildRunNotification([
        { runId: "r1", name: "a", record: turn({ unreportedMessage: "I stopped here." }) },
        { runId: "r2", name: "b", record: turn({ state: "failed", error: "boom" }) },
    ]);

    assert.match(content, /Unreported: the turn ended without a report/);
    assert.match(content, /The run's last message:\nI stopped here\./);
    assert.match(content, /Error: boom/);
    assert.match(content, /The run left no message\./);
    assert.equal(details.runs[1]!.reportStatus, undefined);
    assert.equal(details.runs[1]!.state, "failed");
});

test("stops by the user or a branch change and user chat are told to the main agent", () => {
    const { content } = buildRunNotification([
        { runId: "r1", name: "a", record: turn({ state: "interrupted", stoppedBy: "user" }) },
        { runId: "r2", name: "b", record: turn({ state: "interrupted", stoppedBy: "branch" }) },
        { runId: "r3", name: "c", record: turn({ userWrote: true }) },
    ]);

    assert.match(content, /The user stopped it from the inspector\./);
    assert.match(content, /stopped when the user left its branch/);
    assert.match(content, /The user wrote to this run during the turn/);
});

test("a copied notice says the run belongs to another branch", () => {
    const { content, details } = buildRunNotification([{ ...done("r1", "a"), copied: true }]);

    assert.match(content, /The user copied the last turn of subagent run r1 from another branch/);
    assert.match(content, /subagent tools cannot reach it from here/);
    assert.equal(details.runs[0]!.copied, true);
});

test("notices that arrive close together go out as one steer message that triggers a turn", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.push(done("r1"));
    tick(100);
    notifier.push(done("r2"));
    tick(299);

    assert.equal(pi.sent.length, 0);

    tick(1);

    assert.equal(pi.sent.length, 1);
    assert.deepEqual(pi.sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(pi.sent[0]!.message.customType, RUN_NOTIFICATION_TYPE);
    assert.equal(pi.sent[0]!.message.display, true);
    assert.deepEqual(
        pi.sent[0]!.message.details.runs.map((run) => run.runId),
        ["r1", "r2"],
    );
});

test("a steady stream is flushed at the maximum delay after the oldest arrival", (t) => {
    const { pi, notifier, tick } = fixture(t);

    // Pushes at 0, 250, 500 and 750 ms keep resetting the quiet-moment timer.
    for (let index = 0; index < 4; index += 1) {
        notifier.push(done(`r${index}`));
        tick(index === 3 ? 249 : 250);
    }

    assert.equal(pi.sent.length, 0);

    tick(1);

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0]!.message.details.runs.length, 4);
});

test("ten buffered notices are sent immediately", (t) => {
    const { pi, notifier } = fixture(t);

    for (let index = 0; index < 10; index += 1) {
        notifier.push(done(`r${index}`));
    }

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0]!.message.details.runs.length, 10);
});

test("a failed delivery is requeued, reported, and sent again on the next schedule", (t) => {
    const { pi, notifier, notified, tick } = fixture(t);

    pi.failSends(1);
    notifier.push(done("r1"));
    tick(300);

    assert.equal(pi.sent.length, 0);
    assert.equal(notified.length, 1);
    assert.equal(notified[0]!.type, "error");
    assert.match(notified[0]!.message, /Failed to send.*\[r1\].*stale runtime.*Requeued/);

    tick(300);

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0]!.message.details.runs[0]!.runId, "r1");
});

test("a notice is dropped after two retries and the failure says so", (t) => {
    const { pi, notifier, notified, tick } = fixture(t);

    pi.failSends(Infinity);
    notifier.push(done("r1"));
    tick(300);
    tick(300);
    tick(300);

    assert.equal(pi.sent.length, 0);
    assert.equal(notified.length, 3);
    assert.match(notified[2]!.message, /Permanently failed.*\[r1\].*Dropped/);

    // Nothing is scheduled any more.
    tick(5000);
    assert.equal(notified.length, 3);
});

test("a requeued notice goes out ahead of one pushed later", (t) => {
    const { pi, notifier, tick } = fixture(t);

    pi.failSends(1);
    notifier.push(done("r1"));
    tick(300);
    notifier.push(done("r2"));
    tick(300);

    assert.deepEqual(
        pi.sent[0]!.message.details.runs.map((run) => run.runId),
        ["r1", "r2"],
    );
});

test("without a UI a failure goes to the console", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const errors = t.mock.method(console, "error", () => undefined);
    const pi = fakePi();
    const notifier = new RunNotifier(pi.api, undefined, routing().routing, fakeParent());

    t.after(() => notifier.dispose());
    pi.failSends(1);
    notifier.push(done("r1"));
    t.mock.timers.tick(300);

    assert.equal(errors.mock.callCount(), 1);
});

test("dispose drops queued notices and ignores later pushes", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.push(done("r1"));
    notifier.dispose();
    notifier.push(done("r2"));
    tick(5000);

    assert.equal(pi.sent.length, 0);
});

test("at send time, a notice that is not deliverable is held and the others are sent", (t) => {
    const { pi, notifier, held, tick } = fixture(t, (notice) => notice.runId !== "away");

    notifier.push(done("here1"));
    notifier.push(done("away"));
    notifier.push(done("here2"));
    tick(300);

    assert.equal(pi.sent.length, 1);
    assert.deepEqual(
        pi.sent[0]!.message.details.runs.map((run) => run.runId),
        ["here1", "here2"],
    );
    assert.deepEqual(
        held.map((notice) => notice.runId),
        ["away"],
    );
});

test("a batch without a deliverable notice sends nothing and holds all of it", (t) => {
    const { pi, notifier, held, tick } = fixture(t, () => false);

    notifier.push(done("r1"));
    notifier.push(done("r2"));
    tick(300);

    assert.equal(pi.sent.length, 0);
    assert.deepEqual(
        held.map((notice) => notice.runId),
        ["r1", "r2"],
    );

    // Held notices left the buffer: nothing is retried later.
    tick(5000);
    assert.equal(pi.sent.length, 0);
    assert.equal(held.length, 2);
});

test("deliverability is decided when the batch goes out, not when the notice is pushed", (t) => {
    let active = true;
    const { pi, notifier, held, tick } = fixture(t, () => active);

    notifier.push(done("r1"));
    active = false;
    tick(300);

    assert.equal(pi.sent.length, 0);
    assert.equal(held.length, 1);
});

test("while paused, pushes are buffered without starting timers or sending", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.pause();
    notifier.push(done("r1"));
    tick(5000);

    assert.equal(pi.sent.length, 0);
});

test("while paused, ten buffered notices are not sent immediately", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.pause();

    for (let index = 0; index < 10; index += 1) {
        notifier.push(done(`r${index}`));
    }

    tick(5000);

    assert.equal(pi.sent.length, 0);
});

test("pause cancels timers that already run", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.push(done("r1"));
    tick(200);
    notifier.pause();
    tick(5000);

    assert.equal(pi.sent.length, 0);
});

test("flush does nothing while paused", (t) => {
    const { pi, notifier } = fixture(t);

    notifier.pause();
    notifier.push(done("r1"));
    notifier.flush();

    assert.equal(pi.sent.length, 0);
});

test("resume sends what was buffered after the usual quiet delay, in one message", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.pause();
    notifier.push(done("r1"));
    notifier.push(done("r2"));
    notifier.resume();
    tick(299);

    assert.equal(pi.sent.length, 0);

    tick(1);

    assert.equal(pi.sent.length, 1);
    assert.deepEqual(
        pi.sent[0]!.message.details.runs.map((run) => run.runId),
        ["r1", "r2"],
    );
});

test("after resume, new pushes are scheduled again", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.pause();
    notifier.resume();
    notifier.push(done("r1"));
    tick(300);

    assert.equal(pi.sent.length, 1);
});

test("resume without a pause does nothing", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.push(done("r1"));
    tick(200);
    notifier.resume();

    // The running quiet timer is untouched: it still fires 300 ms after the push.
    tick(99);
    assert.equal(pi.sent.length, 0);

    tick(1);
    assert.equal(pi.sent.length, 1);

    notifier.resume();
    tick(5000);
    assert.equal(pi.sent.length, 1);
});

test("resume with an empty buffer schedules nothing", (t) => {
    const { pi, notifier, tick } = fixture(t);

    notifier.pause();
    notifier.resume();
    tick(5000);

    assert.equal(pi.sent.length, 0);
});

test("a notice buffered while paused is routed when it goes out after resume", (t) => {
    let active = true;
    const { pi, notifier, held, tick } = fixture(t, () => active);

    notifier.pause();
    notifier.push(done("r1"));
    active = false;
    notifier.resume();
    tick(300);

    assert.equal(pi.sent.length, 0);
    assert.equal(held.length, 1);
});

// Delivery confirmation and resend

const key = (runId: string) => turnKey(runId, done(runId).record.endedAt);

/** Sends r1 through the quiet delay and returns the fixture with the notice in the outbox. */
function sentOnce(t: TestContext, runId = "r1") {
    const fx = fixture(t);

    fx.notifier.push(done(runId));
    fx.tick(300);

    return fx;
}

test("a sent notice that the session holds at the settle is not sent again", (t) => {
    const { pi, notifier, parent, tick } = sentOnce(t);

    parent.delivered.add(key("r1"));
    notifier.settled(false);
    notifier.settled(false);
    tick(5000);

    assert.equal(pi.sent.length, 1);
});

test("a notice still missing after one settle waits, and after the next it is sent again", (t) => {
    const { pi, notifier, tick } = sentOnce(t);

    notifier.settled(false);
    tick(5000);

    assert.equal(pi.sent.length, 1);

    notifier.settled(false);
    tick(299);

    assert.equal(pi.sent.length, 1);

    tick(1);

    assert.equal(pi.sent.length, 2);
    assert.deepEqual(pi.sent[1]!.options, { triggerTurn: true, deliverAs: "steer" });
    assert.deepEqual(
        pi.sent[1]!.message.details.runs.map((run) => run.runId),
        ["r1"],
    );
});

test("a notice delivered between the two settles is not sent again", (t) => {
    const { pi, notifier, parent, tick } = sentOnce(t);

    notifier.settled(false);
    parent.delivered.add(key("r1"));
    notifier.settled(false);
    tick(5000);

    assert.equal(pi.sent.length, 1);
});

test("an aborted settle in the interactive mode sends a clearable notice again at once", (t) => {
    const { pi, notifier, notified } = sentOnce(t);

    notifier.settled(true);

    assert.equal(pi.sent.length, 2);
    assert.deepEqual(pi.sent[1]!.options, { deliverAs: "nextTurn" });
    assert.equal(notified.length, 1);
    assert.equal(notified[0]!.type, "info");
    assert.match(notified[0]!.message, /interruption removed the queued report.*\[r1\]/);
    assert.match(notified[0]!.message, /with your next message/);
});

test("an aborted settle without queue clearing does not resend a fresh notice", (t) => {
    const { pi, notifier, parent, notified } = sentOnce(t);

    parent.clearsQueues = false;
    notifier.settled(true);

    assert.equal(pi.sent.length, 1);
    assert.equal(notified.length, 0);
});

test("an aborted settle does not resend a notice sent while the main agent was idle", (t) => {
    const fx = fixture(t);

    fx.parent.isBusy = false;
    fx.notifier.push(done("r1"));
    fx.tick(300);
    fx.notifier.settled(true);

    assert.equal(fx.pi.sent.length, 1);
});

test("an aborted settle does not resend a notice sent while the run was being aborted", (t) => {
    const fx = fixture(t);

    fx.parent.isAborting = true;
    fx.notifier.push(done("r1"));
    fx.tick(300);
    fx.notifier.settled(true);

    assert.equal(fx.pi.sent.length, 1);
});

test("an aborted settle does not resend a notice that the session holds", (t) => {
    const { pi, notifier, parent } = sentOnce(t);

    parent.delivered.add(key("r1"));
    notifier.settled(true);

    assert.equal(pi.sent.length, 1);
});

test("after two retries a lost notice is reported as failed and sent no more", (t) => {
    const { pi, notifier, notified, tick } = sentOnce(t);

    // Each loss is found one settle after the send: two retries, then the third loss is final.
    for (let round = 0; round < 2; round += 1) {
        notifier.settled(false);
        notifier.settled(false);
        tick(300);
    }

    assert.equal(pi.sent.length, 3);
    assert.equal(notified.length, 0);

    notifier.settled(false);
    notifier.settled(false);
    tick(5000);

    assert.equal(pi.sent.length, 3);
    assert.equal(notified.length, 1);
    assert.equal(notified[0]!.type, "error");
    assert.match(
        notified[0]!.message,
        /Subagent notification\(s\) \[r1\] did not reach the main agent after 2 retries\. subagent_status still returns the results\./,
    );
});

test("a resend after an abort also counts as a retry", (t) => {
    const { pi, notifier, notified } = sentOnce(t);

    // The first settle finds the loss; a quiet resend is not in a queue, so it is found one settle
    // after it was sent.
    notifier.settled(true);
    notifier.settled(true);
    notifier.settled(true);

    assert.equal(pi.sent.length, 3);

    notifier.settled(true);
    notifier.settled(true);

    assert.equal(pi.sent.length, 3);
    assert.ok(notified.some(({ type, message }) => type === "error" && /\[r1\]/.test(message)));
});

test("a lost notice resent while paused waits for the resume", (t) => {
    const { pi, notifier, tick } = sentOnce(t);

    notifier.settled(false);
    notifier.pause();
    notifier.settled(false);
    tick(5000);

    assert.equal(pi.sent.length, 1);

    notifier.resume();
    tick(300);

    assert.equal(pi.sent.length, 2);
});

test("an aborted resend while paused also waits for the resume", (t) => {
    const { pi, notifier, tick } = sentOnce(t);

    notifier.pause();
    notifier.settled(true);
    tick(5000);

    assert.equal(pi.sent.length, 1);

    notifier.resume();
    tick(300);

    assert.equal(pi.sent.length, 2);
});

test("a lost notice whose branch is no longer active is held, not sent again", (t) => {
    let active = true;
    const { pi, notifier, held, tick } = fixture(t, () => active);

    notifier.push(done("r1"));
    tick(300);
    notifier.settled(false);
    active = false;
    notifier.settled(false);
    tick(300);

    assert.equal(pi.sent.length, 1);
    assert.deepEqual(
        held.map((notice) => notice.runId),
        ["r1"],
    );
});

test("an aborted resend of a notice whose branch is no longer active is held", (t) => {
    let active = true;
    const { pi, notifier, held, tick } = fixture(t, () => active);

    notifier.push(done("r1"));
    tick(300);
    active = false;
    notifier.settled(true);

    assert.equal(pi.sent.length, 1);
    assert.deepEqual(
        held.map((notice) => notice.runId),
        ["r1"],
    );
});

test("dispose stops the resend of lost notices", (t) => {
    const { pi, notifier, tick } = sentOnce(t);

    notifier.settled(false);
    notifier.dispose();
    notifier.settled(false);
    notifier.settled(true);
    tick(5000);

    assert.equal(pi.sent.length, 1);
});

test("a resend keeps notices that are still missing apart from those that arrived", (t) => {
    const { pi, notifier, parent, tick } = sentOnce(t, "r1");

    notifier.push(done("r2"));
    tick(300);
    parent.delivered.add(key("r2"));
    notifier.settled(false);
    notifier.settled(false);
    tick(300);

    assert.deepEqual(
        pi.sent.at(-1)!.message.details.runs.map((run) => run.runId),
        ["r1"],
    );
});

// deliveredTurns

const noticeEntry = (runs: Array<Record<string, unknown>>, customType = RUN_NOTIFICATION_TYPE) =>
    ({ type: "custom_message", customType, details: { runs } }) as unknown as SessionEntry;

test("deliveredTurns names the turns of the notification messages in the session", () => {
    const expected = new Set(["r1@t1", "r2@t2", "r1@t3"]);
    const actual = deliveredTurns([
        noticeEntry([
            { runId: "r1", endedAt: "t1" },
            { runId: "r2", endedAt: "t2" },
        ]),
        noticeEntry([{ runId: "r1", endedAt: "t3" }]),
    ]);

    assert.deepEqual(actual, expected);
});

test("deliveredTurns ignores other message types and other entry types", () => {
    const actual = deliveredTurns([
        noticeEntry([{ runId: "r1", endedAt: "t1" }], "something-else"),
        { type: "custom", customType: RUN_NOTIFICATION_TYPE, data: {} } as unknown as SessionEntry,
        { type: "custom_message", customType: RUN_NOTIFICATION_TYPE } as unknown as SessionEntry,
    ]);

    assert.equal(actual.size, 0);
});

test("deliveredTurns skips copied runs and runs without an end time", () => {
    const expected = new Set(["r3@t3"]);
    const actual = deliveredTurns([
        noticeEntry([
            { runId: "r1", endedAt: "t1", copied: true },
            { runId: "r2" },
            { runId: "r3", endedAt: "t3" },
        ]),
    ]);

    assert.deepEqual(actual, expected);
});

test("a built notification names its turns the way deliveredTurns reads them", () => {
    const notice = done("r1");
    const { details } = buildRunNotification([notice]);
    const expected = new Set([turnKey("r1", notice.record.endedAt)]);
    const actual = deliveredTurns([
        noticeEntry(details.runs as unknown as Array<Record<string, unknown>>),
    ]);

    assert.deepEqual(actual, expected);
});

// Earlier reports

const withEarlier = (): RunNotice => ({
    runId: "r1",
    name: "a",
    record: turn({
        earlierReports: [
            { status: "blocked", summary: "First try.", reason: "No key." },
            { status: "needs_input", summary: "Second try.", question: "Which?" },
        ],
        report: { status: "done", summary: "Final." },
    }),
});

test("earlier reports of a turn are written before the final report, oldest first", () => {
    const { content } = buildRunNotification([withEarlier()]);

    assert.equal(
        content,
        [
            "Subagent run r1 ended its turn: idle.",
            "Earlier report in this turn: blocked. The run kept working, so a later report replaces it.",
            "Reason: No key.",
            "Summary:",
            "First try.",
            "",
            "Earlier report in this turn: needs_input. The run kept working, so a later report replaces it.",
            "Question: Which?",
            "Summary:",
            "Second try.",
            "",
            "Report: done",
            "",
            "Summary:",
            "Final.",
        ].join("\n"),
    );
});

test("the slices of earlier reports and of the body point at their summaries", () => {
    const { content, details } = buildRunNotification([done("r0", "z", "Zero."), withEarlier()]);
    const run = details.runs[1]!;
    const actual = run.earlierReports!.map((earlier) =>
        content.slice(earlier.summary.start, earlier.summary.end),
    );

    assert.deepEqual(actual, ["First try.", "Second try."]);
    assert.deepEqual(
        run.earlierReports!.map(({ status, reason, question }) => ({ status, reason, question })),
        [
            { status: "blocked", reason: "No key.", question: undefined },
            { status: "needs_input", reason: undefined, question: "Which?" },
        ],
    );
    assert.equal(content.slice(run.body.start, run.body.end), "Final.");
    assert.equal(run.reportStatus, "done");
});

test("a turn with a single report has no earlier reports in its details", () => {
    const { details } = buildRunNotification([done("r1")]);

    assert.equal(details.runs[0]!.earlierReports, undefined);
});
