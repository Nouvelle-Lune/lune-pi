import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { RUN_ENTRY_TYPE } from "../../src/run/types.ts";
import {
    createFixture,
    definition,
    liveSessionOf,
    readJsonl,
    reportResponse,
    startGated,
    waitForTurns,
} from "../harness/fixture.ts";

test("a new manager over the same parent session restores runs, their state from the run file", async (t) => {
    const fx = await createFixture(t);
    const first = fx.createManager([definition({ name: "reviewer", body: "Be brief." })]);

    fx.faux.setResponses([
        reportResponse("needs_input", "Stuck.", { question: "Which file?" }),
        reportResponse("done", "fine"),
    ]);
    const asked = await first.start({ task: "one", agent: "reviewer" }, fx.ctx);
    const finished = await first.start({ task: "two" }, fx.ctx);
    await waitForTurns(first, asked, 1);
    await waitForTurns(first, finished, 1);
    await first.shutdown();

    const second = fx.createManager();

    second.restore();

    const restored = second.branchRuns();
    const byId = new Map(restored.map((run) => [run.id, run]));
    const askedAgain = byId.get(asked.id)!;
    const finishedAgain = byId.get(finished.id)!;

    assert.deepEqual(restored.map((run) => run.id).sort(), [asked.id, finished.id].sort());
    assert.equal(askedAgain.isLive, false);
    assert.equal(askedAgain.readOnly, false);
    assert.equal(askedAgain.name, "reviewer");
    assert.equal(askedAgain.state, "idle");
    assert.equal(askedAgain.needsInput, true);
    assert.equal(askedAgain.lastTurn?.report?.question, "Which file?");
    assert.deepEqual(askedAgain.snapshot?.definition?.body, "Be brief.");
    assert.equal(finishedAgain.lastTurn?.report?.summary, "fine");
    assert.equal(finishedAgain.turns, 1);
    assert.ok(finishedAgain.usage.total > 0);
});

test("a restored idle run accepts send and reopens its session", async (t) => {
    const fx = await createFixture(t);
    const first = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "first")]);
    const original = await first.start({ task: "one" }, fx.ctx);
    await waitForTurns(first, original, 1);
    await first.shutdown();

    const second = fx.createManager();

    second.restore();

    const run = second.branchRun(original.id);

    fx.faux.setResponses([reportResponse("done", "after restart")]);
    const outcome = await second.send(run, "continue", "main-agent");
    await waitForTurns(second, run, 2);

    assert.equal(outcome, "started");
    assert.equal(run.isLive, true);
    assert.equal(run.lastTurn?.report?.summary, "after restart");
    assert.deepEqual(
        liveSessionOf(run)
            .session.messages.filter((message) => message.role === "user")
            .map((message) =>
                typeof message.content === "string"
                    ? message.content
                    : message.content
                          .map((part) => (part.type === "text" ? part.text : ""))
                          .join(""),
            ),
        ["one", "continue"],
    );
});

test("a run stopped by the parent's shutdown is restored as interrupted", async (t) => {
    const fx = await createFixture(t);
    const first = fx.createManager();
    const { run } = await startGated(fx, first, { task: "slow" });

    await first.shutdown();

    assert.equal(run.state, "interrupted");

    const second = fx.createManager();

    second.restore();

    const restored = second.branchRun(run.id);

    assert.equal(restored.state, "interrupted");
    assert.equal(restored.lastTurn?.stoppedBy, "shutdown");
});

test("runs inherited through /fork or /clone are read-only and cannot be continued", async (t) => {
    const fx = await createFixture(t);
    const first = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "original work")]);
    const original = await first.start({ task: "one" }, fx.ctx);
    await waitForTurns(first, original, 1);
    await first.shutdown();

    // A forked session carries the parent's entries but has an ID of its own.
    const forked = SessionManager.create(fx.cwd, `${fx.root}/forked-sessions`);

    for (const entry of fx.parent.getEntries()) {
        if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE) {
            forked.appendCustomEntry(entry.customType, entry.data);
        }
    }

    const forkCtx = Object.create(fx.ctx, {
        sessionManager: { value: forked },
    }) as ExtensionContext;
    const second = fx.createManager([], forkCtx);

    second.restore();

    const inherited = second.branchRun(original.id);

    assert.notEqual(forked.getSessionId(), fx.parent.getSessionId());
    assert.equal(inherited.readOnly, true);
    assert.equal(inherited.parentSessionId, fx.parent.getSessionId());
    assert.equal(inherited.lastTurn?.report?.summary, "original work");
    await assert.rejects(second.send(inherited, "go on", "user"), /read-only/);
    assert.equal(inherited.isLive, false);
});

test("an inline run started after a restore does not reuse an inherited run's name", async (t) => {
    const fx = await createFixture(t);
    const first = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "ok"), reportResponse("done", "ok")]);
    await first.start({ task: "a" }, fx.ctx);
    await first.start({ task: "b" }, fx.ctx);
    await first.shutdown();

    const second = fx.createManager();

    second.restore();
    fx.faux.setResponses([reportResponse("done", "ok")]);

    const next = await second.start({ task: "c" }, fx.ctx);

    assert.equal(next.name, "run-3");
});

test("shutdown interrupts running runs, closes every session and sends no notification", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "idle one")]);
    const idle = await manager.start({ task: "quick" }, fx.ctx);
    await waitForTurns(manager, idle, 1);
    // Spy on the idle run's extension shutdown: the built-ins must close their connections.
    const emitted: string[] = [];
    const runner = liveSessionOf(idle).session.extensionRunner;
    const emit = runner.emit.bind(runner);

    runner.emit = (async (event: { type: string }) => {
        emitted.push(event.type);

        return emit(event as never);
    }) as typeof runner.emit;

    const { run: running } = await startGated(fx, manager, { task: "slow" });
    const sentBefore = fx.pi.sent.length;

    await manager.shutdown();

    assert.equal(running.state, "interrupted");
    assert.equal(running.lastTurn?.stoppedBy, "shutdown");
    assert.equal(idle.isLive, false);
    assert.equal(running.isLive, false);
    assert.ok(emitted.includes("session_shutdown"), "the idle run's built-ins were not shut down");

    const recorded = readJsonl(running.file).filter(
        (line) => line["customType"] === "lune-subagent-turn",
    );

    assert.equal(recorded.length, 1);
    assert.equal((recorded[0]!["data"] as { state: string }).state, "interrupted");

    // Nothing is delivered once the shutdown began, queued notifications included.
    assert.equal(fx.pi.sent.length, sentBefore);
    await assert.rejects(manager.start({ task: "late" }, fx.ctx), /shutting down/);
});
