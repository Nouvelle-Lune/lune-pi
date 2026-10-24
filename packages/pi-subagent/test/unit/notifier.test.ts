import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import {
    buildRunNotification,
    RUN_NOTIFICATION_TYPE,
    RunNotifier,
    type NoticeRouting,
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

/** Mocked timers make the batching windows exact without sleeping. */
function fixture(t: TestContext, deliverable?: (notice: RunNotice) => boolean) {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const pi = fakePi();
    const { ui, notified } = fakeUi();
    const { routing: noticeRouting, held } = routing(deliverable);
    const notifier = new RunNotifier(pi.api, ui, noticeRouting);

    t.after(() => notifier.dispose());

    return { pi, notifier, notified, held, tick: (ms: number) => t.mock.timers.tick(ms) };
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
            "Subagent run reviewer (r1) ended its turn: idle.",
            "Report: done",
            "",
            "Summary:",
            "No problems.",
        ].join("\n"),
    );
    assert.equal(details.runs[0]!.durationMs, 4200);
    assert.equal(details.runs[0]!.reportStatus, "done");
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

    assert.match(
        content,
        /The user copied the last turn of subagent run a \(r1\) from another branch/,
    );
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
    const notifier = new RunNotifier(pi.api, undefined, routing().routing);

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
