import assert from "node:assert/strict";
import { test } from "node:test";

import {
    createFixture,
    liveSessionOf,
    reportResponse,
    startGated,
    textResponse,
    waitForState,
    waitForTurns,
} from "../harness/fixture.ts";

function userTexts(
    messages: ReturnType<ReturnType<typeof liveSessionOf>["session"]["messages"]["slice"]>,
) {
    return messages.flatMap((message) =>
        message.role !== "user"
            ? []
            : [
                  typeof message.content === "string"
                      ? message.content
                      : message.content
                            .map((part) => (part.type === "text" ? part.text : ""))
                            .join(""),
              ],
    );
}

test("send to an idle run starts a new turn in the same session", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "first")]);
    const run = await manager.start({ task: "first task" }, fx.ctx);
    await waitForTurns(manager, run, 1);
    // Notifications of turns that end close together go out as one batch.
    await fx.pi.waitForMessages(1);
    const sessionId = liveSessionOf(run).session.sessionId;

    fx.faux.setResponses([reportResponse("done", "second")]);
    const outcome = await manager.send(run, "second task", "main-agent");
    await waitForTurns(manager, run, 2);

    assert.equal(outcome, "started");
    assert.equal(liveSessionOf(run).session.sessionId, sessionId);
    assert.deepEqual(userTexts(liveSessionOf(run).session.messages), ["first task", "second task"]);
    assert.equal(run.lastTurn?.report?.summary, "second");

    const sent = await fx.pi.waitForMessages(2);

    assert.match(String(sent[1]!.message.content), /second/);
});

test("send to a running run steers its current turn instead of starting another", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const { run, gate } = await startGated(
        fx,
        manager,
        { task: "first task" },
        textResponse("working"),
    );

    fx.faux.appendResponses([reportResponse("done", "after steer")]);
    const outcome = await manager.send(run, "also check B", "main-agent");

    assert.equal(outcome, "steered");
    assert.equal(run.state, "running");

    gate.open();
    await waitForTurns(manager, run, 1);

    assert.equal(run.turns, 1);
    assert.equal(run.lastTurn?.report?.summary, "after steer");
    assert.deepEqual(userTexts(liveSessionOf(run).session.messages), [
        "first task",
        "also check B",
    ]);

    const sent = await fx.pi.waitForMessages(1);

    assert.equal(sent.length, 1);
});

test("a user message is marked as coming from the user and flagged in the notification", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const { run, gate } = await startGated(
        fx,
        manager,
        { task: "first task" },
        textResponse("working"),
    );

    fx.faux.appendResponses([reportResponse("done", "answered the user")]);
    await manager.send(run, "why is it slow?", "user");
    gate.open();
    await waitForTurns(manager, run, 1);

    const [, userMessage] = userTexts(liveSessionOf(run).session.messages);
    const [sent] = await fx.pi.waitForMessages(1);

    assert.match(userMessage!, /^\[From the user\]/);
    assert.match(userMessage!, /why is it slow\?/);
    assert.equal(run.lastTurn?.userWrote, true);
    assert.match(String(sent!.message.content), /The user wrote to this run/);
});

test("stop interrupts the turn, resolves after it ended and sends no turn-end notification", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const { run } = await startGated(fx, manager, { task: "slow" });

    const stopped = await manager.stop(run, "main-agent");

    assert.equal(stopped, true);
    assert.equal(run.state, "interrupted");
    assert.equal(run.turns, 1);
    assert.equal(run.lastTurn?.state, "interrupted");
    assert.equal(run.lastTurn?.stoppedBy, "main-agent");
    assert.equal(run.isLive, true);

    // Notifications keep their order, so if the stopped turn had queued one it would precede this.
    fx.faux.setResponses([reportResponse("done", "other")]);
    const other = await manager.start({ task: "other" }, fx.ctx);
    const sent = await fx.pi.waitForMessages(1);

    assert.equal(sent.length, 1);
    assert.match(String(sent[0]!.message.content), new RegExp(other.id));
    assert.doesNotMatch(String(sent[0]!.message.content), new RegExp(run.id));
});

test("stop on a run that is not running changes nothing", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work" }, fx.ctx);
    await waitForTurns(manager, run, 1);

    assert.equal(await manager.stop(run, "main-agent"), false);
    assert.equal(run.state, "idle");
});

test("an interrupted run continues with send and keeps its session", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const { run } = await startGated(fx, manager, { task: "slow" });

    await manager.stop(run, "main-agent");
    await waitForState(manager, run, "interrupted");
    fx.faux.setResponses([reportResponse("done", "resumed")]);

    const outcome = await manager.send(run, "continue please", "main-agent");
    await waitForTurns(manager, run, 2);

    assert.equal(outcome, "started");
    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.report?.summary, "resumed");
});
