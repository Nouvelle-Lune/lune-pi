import assert from "node:assert/strict";
import { test } from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import {
    createFixture,
    errorResponse,
    gatedResponse,
    liveSessionOf,
    reportResponse,
    startGated,
    textResponse,
    waitForState,
    waitForTurns,
} from "../harness/fixture.ts";
import { displayedStatus } from "../../src/notify/notification-box.ts";
import { createGate } from "../harness/wait.ts";

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

test("a turn that ends without report has no task status, never done", async (t) => {
    const { run, content } = await runOnce(t, textResponse("I looked around and found nothing."));

    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.report, undefined);
    assert.equal(run.lastTurn?.unreportedMessage, "I looked around and found nothing.");
    assert.match(content, /No task status: the turn ended without a report\./);
    assert.doesNotMatch(content, /unreported/i);
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

test("a steer during the report batch continues the turn; the first report is kept as earlier", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const { run, gate } = await startGated(
        fx,
        manager,
        { task: "work" },
        reportResponse("blocked", "First try.", { reason: "No key." }),
    );

    fx.faux.appendResponses([reportResponse("done", "Second try.")]);
    await manager.send(run, "one more thing", "main-agent");

    gate.open();
    await waitForTurns(manager, run, 1);

    const [sent] = await fx.pi.waitForMessages(1);
    const content = String(sent!.message.content);

    assert.equal(run.turns, 1);
    assert.equal(run.lastTurn?.report?.summary, "Second try.");
    assert.deepEqual(run.lastTurn?.earlierReports, [
        { status: "blocked", summary: "First try.", reason: "No key." },
    ]);
    assert.match(content, /Earlier report in this turn: blocked\./);
    assert.match(content, /Report: done/);
});

test("a turn with one report has no earlier reports", async (t) => {
    const { run } = await runOnce(t, reportResponse("done", "Only one."));

    assert.equal(run.lastTurn?.earlierReports, undefined);
});

test("the manager passes the main agent's settle on to confirm its notices", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.state.idle = false;
    fx.faux.setResponses([reportResponse("done", "Finished.")]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    // The session never received the notice, so the second settle sends it again.
    manager.mainAgentSettled(false);
    manager.mainAgentSettled(false);

    const sent = await fx.pi.waitForMessages(2);

    assert.deepEqual(sent[1]!.options, { triggerTurn: true, deliverAs: "steer" });
});

test("an aborted settle of the interactive main agent sends a queued notice for the next turn", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.state.idle = false;
    fx.faux.setResponses([reportResponse("done", "Finished.")]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);
    manager.mainAgentSettled(true);

    const sent = await fx.pi.waitForMessages(2);

    assert.deepEqual(sent[1]!.options, { deliverAs: "nextTurn" });
});

/**
 * Pi drops a `length` reply that ended below the model's output limit from the session to recover:
 * it retries only if compaction succeeds, and in a short session compaction declines, so nothing
 * retries and the session no longer holds the reply. A reply that used the whole limit is kept; a
 * one-token limit makes every faux reply do so.
 */
async function runCutAtLimit(t: Parameters<typeof createFixture>[0], text: string) {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.models.first.maxTokens = 1;
    fx.faux.setResponses([fauxAssistantMessage(text, { stopReason: "length" })]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);

    const [sent] = await fx.pi.waitForMessages(1);

    return { fx, manager, run, content: String(sent!.message.content) };
}

test("a reply cut at the token limit without a report is cut short and keeps its text", async (t) => {
    const { run, content } = await runCutAtLimit(t, "I was in the middle of");

    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.state, "idle");
    assert.equal(run.lastTurn?.report, undefined);
    assert.equal(run.lastTurn?.cutShort, true);
    assert.equal(run.lastTurn?.unreportedMessage, "I was in the middle of");
    // The main agent's text is the same as for any turn without a report.
    assert.match(content, /No task status: the turn ended without a report\./);
    assert.match(content, /I was in the middle of/);
    assert.doesNotMatch(content, /Report: done/);
});

test("a turn that left no text without a report is cut short and says the run left no message", async (t) => {
    const { run, content } = await runOnce(t, textResponse(""));

    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.cutShort, true);
    assert.equal(run.lastTurn?.unreportedMessage, "");
    assert.match(content, /No task status: the turn ended without a report\./);
    assert.match(content, /The run left no message\./);
});

test("a normal turn without a report is not cut short", async (t) => {
    const { run } = await runOnce(t, textResponse("All checked."));

    assert.equal(run.lastTurn?.state, "idle");
    assert.equal(run.lastTurn?.unreportedMessage, "All checked.");
    assert.equal(run.lastTurn?.cutShort, undefined);
});

test("a report in the turn wins even when the last reply was cut at the token limit", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.models.first.maxTokens = 1;

    const { run, gate } = await startGated(
        fx,
        manager,
        { task: "work" },
        reportResponse("blocked", "Did half.", { reason: "No network." }),
    );

    // A steer continues the turn; its reply is cut, but the turn already holds a report.
    fx.faux.appendResponses([fauxAssistantMessage("and then", { stopReason: "length" })]);
    await manager.send(run, "one more thing", "main-agent");

    gate.open();
    await waitForTurns(manager, run, 1);

    const [sent] = await fx.pi.waitForMessages(1);

    assert.equal(run.lastTurn?.report?.status, "blocked");
    assert.equal(run.lastTurn?.cutShort, undefined);
    assert.match(String(sent!.message.content), /Report: blocked/);
});

test("a cut-short turn is still cut short after the run is restored from its file", async (t) => {
    const { fx, manager: first, run } = await runCutAtLimit(t, "Cut here");

    await first.shutdown();

    const second = fx.createManager();

    second.restore();

    const restored = second.branchRun(run.id)!;

    assert.equal(restored.state, "idle");
    assert.equal(restored.lastTurn?.cutShort, true);
    assert.equal(restored.lastTurn?.unreportedMessage, "Cut here");
});

// A reply text with a tool call, so the turn continues into a second model request.
function textWithToolCall(text: string) {
    return fauxAssistantMessage(
        [{ type: "text", text }, fauxToolCall("read", { path: "missing.txt" })],
        {
            stopReason: "toolUse",
        },
    );
}

function assistantTexts(messages: ReadonlyArray<{ role: string; content?: unknown }>): string[] {
    return messages
        .filter((message) => message.role === "assistant")
        .map((message) =>
            (message.content as Array<{ type: string; text?: string }>)
                .map((part) => (part.type === "text" ? part.text : ""))
                .join(""),
        );
}

test("a dropped length reply after a tool round is the turn's message, not the older reply", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([
        textWithToolCall("Checking the file first."),
        fauxAssistantMessage("The answer is cut off mid", { stopReason: "length" }),
    ]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    // Pi dropped the cut reply, so only the older reply is left in the session.
    const held = assistantTexts(liveSessionOf(run).session.messages);

    assert.deepEqual(held, ["Checking the file first."]);
    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.report, undefined);
    assert.equal(run.lastTurn?.cutShort, true);
    assert.equal(run.lastTurn?.unreportedMessage, "The answer is cut off mid");
});

test("a follow-up turn whose only reply is a dropped length reply is cut short with that reply's text", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([textResponse("First turn text.")]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    fx.faux.setResponses([fauxAssistantMessage("Second turn cut off", { stopReason: "length" })]);
    await manager.send(run, "continue", "main-agent");
    await waitForTurns(manager, run, 2);

    assert.deepEqual(assistantTexts(liveSessionOf(run).session.messages), ["First turn text."]);
    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.cutShort, true);
    assert.equal(run.lastTurn?.unreportedMessage, "Second turn cut off");
});

test("a dropped length reply with no text leaves an empty message, not the older text", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([
        textWithToolCall("Checking the file first."),
        fauxAssistantMessage([], { stopReason: "length" }),
    ]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.cutShort, true);
    assert.equal(run.lastTurn?.unreportedMessage, "");
});

test("an interrupted turn whose aborted reply is empty keeps the earlier text and is not cut short", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const gate = createGate();
    const reached = createGate();

    fx.faux.setResponses([
        textWithToolCall("Checking the file first."),
        gatedResponse(gate, reached.open),
    ]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await reached.opened;
    await manager.stop(run, "main-agent");
    await waitForState(manager, run, "interrupted");

    assert.equal(run.lastTurn?.state, "interrupted");
    assert.equal(run.lastTurn?.cutShort, undefined);
    assert.equal(run.lastTurn?.unreportedMessage, "Checking the file first.");
});

test("a length reply that Pi retries after a successful compaction ends the turn with the retried reply", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    // Two long messages give compaction an earlier part to summarize, below the compaction threshold.
    const long = (word: string) => `${word} `.repeat(24_000);

    fx.faux.setResponses([textResponse("First turn text.")]);

    const run = await manager.start({ task: `work ${long("word")}` }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    // Compaction summarizes the history and the split turn prefix with one model call each.
    fx.faux.setResponses([
        fauxAssistantMessage("Cut off text", { stopReason: "length" }),
        textResponse("## Summary\nsummary of the history"),
        textResponse("## Summary\nsummary of the turn prefix"),
        textResponse("Retried reply."),
    ]);
    await manager.send(run, `continue ${long("more")}`, "main-agent");
    await waitForTurns(manager, run, 2);

    const entries = liveSessionOf(run).session.sessionManager.getEntries();

    assert.ok(entries.some((entry) => entry.type === "compaction"));
    assert.deepEqual(assistantTexts(liveSessionOf(run).session.messages), ["Retried reply."]);
    assert.equal(fx.faux.getPendingResponseCount(), 0);
    assert.equal(run.state, "idle");
    assert.equal(run.lastTurn?.cutShort, undefined);
    assert.equal(run.lastTurn?.unreportedMessage, "Retried reply.");
});

const OVERFLOW = "prompt is too long";

function overflowResponse() {
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
}

// Two long messages give compaction an earlier part to summarize, below the compaction threshold.
async function longSession(
    t: Parameters<typeof createFixture>[0],
    followUps: Parameters<Awaited<ReturnType<typeof createFixture>>["faux"]["setResponses"]>[0],
) {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const long = (word: string) => `${word} `.repeat(24_000);

    fx.faux.setResponses([textResponse("First turn text.")]);

    const run = await manager.start({ task: `work ${long("word")}` }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);
    fx.faux.setResponses(followUps);
    await manager.send(run, `continue ${long("more")}`, "main-agent");
    await waitForTurns(manager, run, 2);

    return { fx, run };
}

function assertFailedWithOverflow(run: Awaited<ReturnType<typeof longSession>>["run"]) {
    const turn = run.lastTurn;

    assert.equal(turn?.state, "failed");
    assert.equal(turn?.error, OVERFLOW);
    assert.equal(turn?.cutShort, undefined);
    assert.equal(turn?.unreportedMessage, "");
    assert.equal(displayedStatus(run.state, turn?.report?.status, turn?.cutShort), undefined);
}

test("an overflow error after a tool round fails the turn with its error and forwards no older text", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([textWithToolCall("Checking the file first."), overflowResponse()]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    assert.equal(run.state, "failed");
    assertFailedWithOverflow(run);
});

test("an overflow error in a follow-up turn fails that turn and does not forward the first turn's text", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([textResponse("First answer")]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);
    fx.faux.setResponses([overflowResponse()]);
    await manager.send(run, "continue", "main-agent");
    await waitForTurns(manager, run, 2);

    assert.equal(run.state, "failed");
    assertFailedWithOverflow(run);
});

test("an overflow error whose compaction summary request fails still fails the turn with its error", async (t) => {
    const { run } = await longSession(t, [
        overflowResponse(),
        errorResponse("summary request failed"),
        errorResponse("summary request failed"),
    ]);

    assert.equal(run.state, "failed");
    assertFailedWithOverflow(run);
});

test("a follow-up turn with a dropped length reply after a failed turn is cut short without the earlier error", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([errorResponse("boom")]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    assert.equal(run.lastTurn?.error, "boom");

    fx.faux.setResponses([fauxAssistantMessage("Second turn cut off", { stopReason: "length" })]);
    await manager.send(run, "continue", "main-agent");
    await waitForTurns(manager, run, 2);

    const turn = run.lastTurn;

    assert.equal(run.state, "idle");
    assert.equal(turn?.state, "idle");
    assert.equal(turn?.error, undefined);
    assert.equal(turn?.cutShort, true);
    assert.equal(turn?.unreportedMessage, "Second turn cut off");
    assert.equal(displayedStatus(run.state, turn?.report?.status, turn?.cutShort), undefined);
});

test("a follow-up turn with a normal reply after a failed turn is idle, shown as done, and has no error", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([errorResponse("boom")]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    fx.faux.setResponses([textResponse("Recovered answer.")]);
    await manager.send(run, "continue", "main-agent");
    await waitForTurns(manager, run, 2);

    const turn = run.lastTurn;

    assert.equal(run.state, "idle");
    assert.equal(turn?.state, "idle");
    assert.equal(turn?.error, undefined);
    assert.equal(turn?.cutShort, undefined);
    assert.equal(turn?.unreportedMessage, "Recovered answer.");
    assert.equal(displayedStatus(run.state, turn?.report?.status, turn?.cutShort), "done");
});

test("a follow-up the session rejects before its run begins fails the turn and keeps the earlier text", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([textResponse("First turn text.")]);

    const run = await manager.start({ task: "work" }, fx.ctx);

    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    // Without its provider the session finds no credentials and rejects the prompt before a run begins.
    fx.runtime.unregisterProvider("faux");
    await fx.runtime.refresh({ allowNetwork: false });

    await assert.rejects(manager.send(run, "continue", "main-agent"), /No API key found/);

    const turn = run.lastTurn;

    assert.equal(run.turns, 2);
    assert.equal(run.state, "failed");
    assert.equal(turn?.state, "failed");
    assert.match(turn?.error ?? "", /No API key found/);
    assert.equal(turn?.report, undefined);
    assert.equal(turn?.cutShort, undefined);
    assert.equal(turn?.unreportedMessage, "First turn text.");
});
