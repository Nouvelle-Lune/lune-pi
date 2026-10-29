import assert from "node:assert/strict";
import { test } from "node:test";

import { getDockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";

import {
    SUBAGENT_CONTRIBUTION_ID,
    SubagentDockContribution,
} from "../../src/dock/dock-contribution.ts";
import {
    createFixture,
    definition,
    reportResponse,
    startGated,
    treeEvent,
    waitForTurns,
    type Fixture,
} from "../harness/fixture.ts";

/** An entry both branches share; a run started after it leaves with the branch. */
function baseEntry(fx: Fixture): string {
    return fx.parent.appendMessage({ role: "user", content: "hello", timestamp: 1 });
}

test("a run from another branch is unreachable; the error lists this branch's runs", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);

    fx.faux.setResponses([reportResponse("done", "a"), reportResponse("done", "b")]);
    const away = await manager.start({ task: "on branch one" }, fx.ctx);

    fx.parent.branch(base);

    const here = await manager.start({ task: "on branch two" }, fx.ctx);

    assert.deepEqual(
        manager.branchRuns().map((run) => run.id),
        [here.id],
    );
    assert.deepEqual(
        manager.otherBranchRuns().map((run) => run.id),
        [away.id],
    );
    assert.throws(
        () => manager.branchRun(away.id),
        (error: Error) =>
            error.message ===
            `No subagent run "${away.id}" on the current branch. Runs here: ${here.id}.`,
    );
    assert.equal(manager.branchRun(here.id), here);
});

test("an unknown runId that matches a run's name or title gets that run's ID", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager([definition({ name: "reviewer" })]);

    fx.faux.setResponses([reportResponse("done", "a"), reportResponse("done", "b")]);
    const named = await manager.start({ task: "named", agent: "reviewer" }, fx.ctx);
    const titled = await manager.start({ task: "titled", title: "Review the diff" }, fx.ctx);
    const known = manager
        .branchRuns()
        .map((run) => run.id)
        .join(", ");

    assert.throws(
        () => manager.branchRun("reviewer"),
        (error: Error) =>
            error.message ===
            `No subagent run "reviewer" on the current branch. "reviewer" is a run name, ` +
                `not an ID; pass ${named.id}. Runs here: ${known}.`,
    );
    assert.throws(
        () => manager.branchRun("Review the diff"),
        (error: Error) =>
            error.message ===
            `No subagent run "Review the diff" on the current branch. "Review the diff" is a ` +
                `run title, not an ID; pass ${titled.id}. Runs here: ${known}.`,
    );
});

test("on a branch without runs, the error says there are none", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);

    fx.faux.setResponses([reportResponse("done", "a")]);
    const away = await manager.start({ task: "work" }, fx.ctx);

    fx.parent.branch(base);

    assert.throws(() => manager.branchRun(away.id), /There are no runs here\./);
});

test("the turn-end notification of a run on another branch waits until its branch is active again", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const { run, gate } = await startGated(fx, manager, { task: "work" });

    fx.parent.branch(base);
    gate.open();
    await waitForTurns(manager, run, 1);

    assert.equal(manager.hasDeferred(run), true);
    assert.equal(fx.pi.sent.length, 0);

    // Still on the other branch: navigation events change nothing.
    manager.afterTree();
    assert.equal(manager.hasDeferred(run), true);

    fx.parent.branch(run.spawnEntryId);
    manager.afterTree();

    const sent = await fx.pi.waitForMessages(1);

    assert.equal(manager.hasDeferred(run), false);
    assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
    assert.match(String(sent[0]!.message.content), new RegExp(run.id));
});

test("copyReport sends a copied notification of another branch's run without triggering a turn", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);

    fx.faux.setResponses([reportResponse("done", "the findings")]);
    const run = await manager.start({ task: "work" }, fx.ctx);
    await waitForTurns(manager, run, 1);
    await fx.pi.waitForMessages(1);

    fx.parent.branch(base);
    manager.copyReport(run);

    const copy = fx.pi.sent[1]!;

    assert.equal(fx.pi.sent.length, 2);
    assert.equal(copy.options?.triggerTurn, undefined);
    assert.match(String(copy.message.content), /copied the last turn/);
    assert.match(String(copy.message.content), /the findings/);
    assert.deepEqual(
        (copy.message.details as { runs: Array<{ copied?: boolean }> }).runs.map(
            (entry) => entry.copied,
        ),
        [true],
    );
});

test("copyReport refuses a run of the current branch", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work" }, fx.ctx);
    await waitForTurns(manager, run, 1);

    assert.throws(() => manager.copyReport(run), /is on this branch/);
});

test("beforeTree asks once for all running runs that leave the branch and stops them on request", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const first = await startGated(fx, manager, { task: "one" });
    const second = await startGated(fx, manager, { task: "two" });

    fx.state.selectAnswer = "Stop them";

    const result = await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: base }),
        fx.ctx,
    );

    assert.equal(result, undefined);
    assert.equal(fx.state.selectCalls.length, 1);
    assert.deepEqual(fx.state.selectCalls[0]!.options, ["Keep them running", "Stop them"]);
    assert.match(fx.state.selectCalls[0]!.title, /2 subagent runs are still running/);
    assert.equal(first.run.state, "interrupted");
    assert.equal(second.run.state, "interrupted");
    assert.equal(first.run.lastTurn?.stoppedBy, "branch");
});

test("beforeTree keeps the runs running when asked to", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const { run } = await startGated(fx, manager, { task: "one" });

    fx.state.selectAnswer = "Keep them running";

    const result = await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: base }),
        fx.ctx,
    );

    assert.equal(result, undefined);
    assert.equal(run.state, "running");
});

test("a run kept running on a tree navigation shows in the Dock as running on another branch", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const { run, gate } = await startGated(fx, manager, { task: "one" });

    t.after(() => gate.open());
    fx.state.selectAnswer = "Keep them running";
    await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: base }),
        fx.ctx,
    );
    fx.parent.branch(base);

    // The Dock only joins a shared host in a TUI context.
    const ui = { ...fx.ctx.ui, setWidget: () => undefined };
    const ctx = Object.create(fx.ctx, {
        mode: { value: "tui" },
        ui: { value: ui },
    }) as typeof fx.ctx;
    const dock = new SubagentDockContribution(async () => undefined);
    const release = getDockRegistry().attachHost(ctx.ui, { invalidate() {} });

    dock.attach(ctx, manager);
    t.after(() => {
        dock.detach({ retired: true });
        release();
    });

    const mounted = getDockRegistry()
        .getContributions(ctx.ui)
        .find((entry) => entry.id === SUBAGENT_CONTRIBUTION_ID)!;
    const detail = (mounted.snapshot.detail ?? mounted.snapshot.base).render(200)[0]!;

    assert.equal(run.state, "running");
    assert.equal(manager.branchRuns().length, 0);
    assert.equal(detail, "◐ Agents · 1 running · 1 on another branch");
});

test("beforeTree cancels the navigation when the dialog is cancelled", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const { run } = await startGated(fx, manager, { task: "one" });

    fx.state.selectAnswer = undefined;

    const result = await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: base }),
        fx.ctx,
    );

    assert.deepEqual(result, { cancel: true });
    assert.equal(run.state, "running");
});

test("beforeTree asks nothing when no running run leaves the branch", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const finished = await manager.start({ task: "done soon" }, fx.ctx);
    await waitForTurns(manager, finished, 1);

    const idleLeaving = await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: base }),
        fx.ctx,
    );

    assert.equal(idleLeaving, undefined);

    // A running run that stays on the common path does not leave the branch.
    const { run } = await startGated(fx, manager, { task: "stays" });
    const staying = await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: fx.parent.getLeafId() }),
        fx.ctx,
    );

    assert.equal(staying, undefined);
    assert.equal(run.state, "running");
    assert.equal(fx.state.selectCalls.length, 0);
});

test("without a UI, beforeTree asks nothing and the runs keep running", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const { run } = await startGated(fx, manager, { task: "one" });

    fx.state.hasUI = false;

    const result = await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: base }),
        fx.ctx,
    );

    assert.equal(result, undefined);
    assert.equal(fx.state.selectCalls.length, 0);
    assert.equal(run.state, "running");
});
