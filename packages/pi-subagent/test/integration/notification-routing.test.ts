import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";

import type { RunManager } from "../../src/run/run-manager.ts";
import type { Run } from "../../src/run/run.ts";
import {
    createFixture,
    startGated,
    treeEvent,
    waitForTurns,
    type Fixture,
} from "../harness/fixture.ts";
import { within } from "../harness/wait.ts";

/**
 * The notifier's 300 ms quiet delay is driven by mocked timers, enabled once the run waits at the
 * model so the run itself keeps real timers. A negative assertion then needs no sleeping.
 */
function mockNotifierTimers(t: TestContext): (ms: number) => void {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    return (ms) => t.mock.timers.tick(ms);
}

function baseEntry(fx: Fixture): string {
    return fx.parent.appendMessage({ role: "user", content: "hello", timestamp: 1 });
}

/** Resolves once a turn notice of `run` waits for its branch. */
function waitForDeferred(manager: RunManager, run: Run): Promise<void> {
    return within(
        new Promise<void>((resolve) => {
            if (manager.hasDeferred(run)) {
                resolve();
                return;
            }

            const unsubscribe = manager.subscribe(() => {
                if (manager.hasDeferred(run)) {
                    unsubscribe();
                    resolve();
                }
            });
        }),
        `a deferred notice of run ${run.id}`,
    );
}

/** A navigation that leaves nothing behind: the common ancestor is the current leaf. */
function stayingEvent(fx: Fixture, signal?: AbortSignal): SessionBeforeTreeEvent {
    const event = treeEvent({
        oldLeafId: fx.parent.getLeafId(),
        commonAncestorId: fx.parent.getLeafId(),
    });

    return signal ? ({ ...event, signal } as SessionBeforeTreeEvent) : event;
}

test("a notice whose branch became inactive before the batch went out is deferred, then sent when the branch is active again", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const { run, gate } = await startGated(fx, manager, { task: "work" });
    const tick = mockNotifierTimers(t);

    gate.open();
    await waitForTurns(manager, run, 1);

    // The turn ended on the active branch, so the notice is buffered, not deferred.
    assert.equal(manager.hasDeferred(run), false);

    fx.parent.branch(base);
    tick(300);

    assert.equal(fx.pi.sent.length, 0);
    assert.equal(manager.hasDeferred(run), true);

    fx.parent.branch(run.spawnEntryId);
    manager.afterTree();
    tick(300);

    assert.equal(fx.pi.sent.length, 1);
    assert.equal(manager.hasDeferred(run), false);
    assert.match(String(fx.pi.sent[0]!.message.content), new RegExp(run.id));
});

for (const [release, act] of [
    ["afterTree", (_fx, manager) => manager.afterTree()],
    ["resumeNotifications", (_fx, manager) => manager.resumeNotifications()],
    ["an abort of the event's signal", (_fx, _manager, abort) => abort.abort()],
] as Array<[string, (fx: Fixture, manager: RunManager, abort: AbortController) => void]>) {
    test(`after beforeTree, a turn end on the current branch sends nothing until ${release}`, async (t) => {
        const fx = await createFixture(t);
        const manager = fx.createManager();
        const { run, gate } = await startGated(fx, manager, { task: "work" });
        const abort = new AbortController();
        const tick = mockNotifierTimers(t);

        const result = await manager.beforeTree(stayingEvent(fx, abort.signal), fx.ctx);

        assert.equal(result, undefined);

        gate.open();
        await waitForTurns(manager, run, 1);
        tick(5000);

        assert.equal(fx.pi.sent.length, 0);
        // The notice is held in the notifier, not deferred: its branch is still active.
        assert.equal(manager.hasDeferred(run), false);

        act(fx, manager, abort);
        tick(300);

        assert.equal(fx.pi.sent.length, 1);
        assert.match(String(fx.pi.sent[0]!.message.content), new RegExp(run.id));
    });
}

test("Stop them: the interrupted turns are deferred while another branch is active and sent when theirs returns", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const first = await startGated(fx, manager, { task: "one" });
    const second = await startGated(fx, manager, { task: "two" });
    const tick = mockNotifierTimers(t);

    fx.state.selectAnswer = "Stop them";

    await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: base }),
        fx.ctx,
    );
    tick(5000);

    assert.equal(first.run.state, "interrupted");
    assert.equal(second.run.state, "interrupted");
    assert.equal(fx.pi.sent.length, 0);

    fx.parent.branch(base);
    manager.afterTree();
    tick(300);

    assert.equal(fx.pi.sent.length, 0);
    assert.equal(manager.hasDeferred(first.run), true);
    assert.equal(manager.hasDeferred(second.run), true);

    fx.parent.branch(second.run.spawnEntryId);
    manager.afterTree();
    tick(300);

    // The second run started after the first, so its branch contains both spawn entries.
    assert.equal(fx.pi.sent.length, 1);

    const content = String(fx.pi.sent[0]!.message.content);

    assert.match(content, new RegExp(first.run.id));
    assert.match(content, new RegExp(second.run.id));
    assert.equal(content.match(/stopped when the user left its branch/g)?.length, 2);
    assert.equal(manager.hasDeferred(first.run), false);
    assert.equal(manager.hasDeferred(second.run), false);
});

test("a cancelled dialog does not hold notifications", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const { run, gate } = await startGated(fx, manager, { task: "work" });
    const tick = mockNotifierTimers(t);

    fx.state.selectAnswer = undefined;

    const result = await manager.beforeTree(
        treeEvent({ oldLeafId: fx.parent.getLeafId(), commonAncestorId: base }),
        fx.ctx,
    );

    assert.deepEqual(result, { cancel: true });
    assert.equal(run.state, "running");

    gate.open();
    await waitForTurns(manager, run, 1);
    tick(300);

    assert.equal(fx.pi.sent.length, 1);
});

test("a deferred notice waits for the run's own branch even when the notifier is released", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const base = baseEntry(fx);
    const { run, gate } = await startGated(fx, manager, { task: "work" });
    const tick = mockNotifierTimers(t);

    fx.parent.branch(base);
    gate.open();
    await waitForTurns(manager, run, 1);
    await waitForDeferred(manager, run);
    manager.resumeNotifications();
    tick(5000);

    assert.equal(fx.pi.sent.length, 0);
    assert.equal(manager.hasDeferred(run), true);
});
