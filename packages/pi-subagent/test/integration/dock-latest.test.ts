import assert from "node:assert/strict";
import { test } from "node:test";

import { getDockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";

import {
    SUBAGENT_CONTRIBUTION_ID,
    SubagentDockContribution,
} from "../../src/dock/dock-contribution.ts";
import { createFixture, gatedResponse, reportResponse, waitForTurns } from "../harness/fixture.ts";
import { createGate, within } from "../harness/wait.ts";

test("a running run counts from the start of its current turn, which can be later than another run's end", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "a1")]);
    const runA = await manager.start({ task: "first" }, fx.ctx);
    await waitForTurns(manager, runA, 1);

    fx.faux.setResponses([reportResponse("done", "b1")]);
    const runB = await manager.start({ task: "second" }, fx.ctx);
    await waitForTurns(manager, runB, 1);

    // Equal times resolve to the later run in the list (B), so A's turn must start strictly later.
    const endedB = Date.parse(runB.lastTurn!.endedAt);

    while (Date.now() <= endedB) {
        await new Promise((resolve) => setImmediate(resolve));
    }

    const gate = createGate();
    const reached = createGate();

    t.after(() => gate.open());
    fx.faux.setResponses([gatedResponse(gate, reached.open)]);
    await manager.send(runA, "again", "main-agent");
    await within(reached.opened, `run ${runA.id} to reach the model`);

    assert.equal(runA.state, "running");
    assert.ok(Date.parse(runA.lastTurn!.endedAt) < endedB);

    // The harness context has no mode and its UI no widgets; the Dock only joins a shared host in
    // a TUI context, and detaching clears the standalone widget.
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
    const line = mounted.snapshot.full!.render(300)[0]!;

    assert.match(line, new RegExp(`latest: ${runA.name} running$`));
});
