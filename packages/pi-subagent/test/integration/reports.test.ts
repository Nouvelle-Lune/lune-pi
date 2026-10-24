import assert from "node:assert/strict";
import { test } from "node:test";

import {
    createFixture,
    errorResponse,
    reportResponse,
    textResponse,
    waitForTurns,
} from "../harness/fixture.ts";

async function runOnce(
    t: Parameters<typeof createFixture>[0],
    response: Parameters<
        Awaited<ReturnType<typeof createFixture>>["faux"]["setResponses"]
    >[0][number],
) {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([response]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);

    const [sent] = await fx.pi.waitForMessages(1);

    return { fx, run, content: String(sent!.message.content) };
}

test("a blocked report carries its reason; the run is idle and needs attention", async (t) => {
    const { run, content } = await runOnce(
        t,
        reportResponse("blocked", "Did half.", { reason: "No network access." }),
    );

    assert.equal(run.state, "idle");
    assert.deepEqual(run.lastTurn?.report, {
        status: "blocked",
        summary: "Did half.",
        reason: "No network access.",
    });
    assert.equal(run.needsAttention, true);
    assert.match(content, /Report: blocked/);
    assert.match(content, /Reason: No network access\./);
});

test("a needs_input report carries its question to the main agent", async (t) => {
    const { run, content } = await runOnce(
        t,
        reportResponse("needs_input", "Stopped early.", { question: "Which branch?" }),
    );

    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.report?.question, "Which branch?");
    assert.equal(run.needsInput, true);
    assert.match(content, /Report: needs_input/);
    assert.match(content, /Question: Which branch\?/);
});

test("a blocked report without a reason is rejected and the run can report again", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([
        reportResponse("blocked", "Cannot."),
        reportResponse("blocked", "Cannot.", { reason: "Out of scope." }),
    ]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);

    assert.equal(run.lastTurn?.report?.reason, "Out of scope.");
    assert.equal(run.turns, 1);
});

test("a turn that ends without report is unreported, never done", async (t) => {
    const { run, content } = await runOnce(t, textResponse("I looked around and found nothing."));

    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.report, undefined);
    assert.equal(run.lastTurn?.unreportedMessage, "I looked around and found nothing.");
    assert.match(content, /Unreported/);
    assert.match(content, /I looked around and found nothing\./);
    assert.doesNotMatch(content, /Report: done/);
});

test("a failed turn gives the failed state with the error and notifies the main agent", async (t) => {
    const { run, content } = await runOnce(t, errorResponse("provider exploded"));

    assert.equal(run.state, "failed");
    assert.equal(run.lastTurn?.state, "failed");
    assert.equal(run.lastTurn?.error, "provider exploded");
    assert.equal(run.needsAttention, true);
    assert.match(content, /failed/);
    assert.match(content, /Error: provider exploded/);
});

test("a run records its token usage separately in its own session", async (t) => {
    const { run } = await runOnce(t, reportResponse("done", "ok"));

    assert.ok(run.usage.total > 0);
});
