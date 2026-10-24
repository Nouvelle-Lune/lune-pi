import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { getDockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";

import {
    SUBAGENT_CONTRIBUTION_ID,
    SubagentDockContribution,
} from "../../src/dock/dock-contribution.ts";
import type { RunManager } from "../../src/run/run-manager.ts";
import type { Run } from "../../src/run/run.ts";
import {
    fakeCtx,
    fakeTheme,
    parentSession,
    tempAgentDir,
    turn,
    type RunFileSpec,
} from "./support.ts";

const WIDTH = 200;

/** Attaches the contribution to a TUI context that has a shared Dock host, then reads its snapshot. */
function fixture(t: TestContext, specs: Record<string, RunFileSpec>) {
    const agentDir = tempAgentDir(t);
    const session = parentSession(t, agentDir);

    for (const [runId, spec] of Object.entries(specs)) {
        session.spawn(runId, spec);
    }

    const manager: RunManager = session.manager();
    const { ctx } = fakeCtx({ sessionManager: session.sessionManager, theme: fakeTheme() });
    const dock = new SubagentDockContribution(async () => undefined);
    const release = getDockRegistry().attachHost(ctx.ui, { invalidate() {} });

    dock.attach(ctx, manager);
    t.after(() => {
        dock.detach({ retired: true });
        release();
    });

    const run = (id: string): Run => manager.branchRuns().find((candidate) => candidate.id === id)!;
    const snapshot = () => {
        const mounted = getDockRegistry()
            .getContributions(ctx.ui)
            .find((entry) => entry.id === SUBAGENT_CONTRIBUTION_ID)!;

        // The registry holds the snapshot taken at the last refresh.
        return mounted.snapshot;
    };
    const text = (level: "base" | "detail" | "full") =>
        (snapshot()[level] ?? snapshot().base).render(WIDTH)[0]!;

    return { dock, manager, run, text, sessionManager: session.sessionManager };
}

test("the base line counts running runs and runs that need input", (t) => {
    const { dock, run, text } = fixture(t, {
        a: {},
        b: {},
        c: { turns: [turn({ report: { status: "needs_input", summary: "?", question: "Q?" } })] },
    });

    run("a").state = "running";
    run("b").state = "running";
    dock.refresh();

    assert.equal(text("base"), "? Agents 2 running · 1 needs input");
});

test("the detail and full lines show each run with its state and report status", (t) => {
    const { run, text } = fixture(t, {
        reviewer: {
            snapshot: { name: "reviewer", isolation: "worktree" },
            turns: [turn({ report: { status: "done", summary: "ok" } })],
        },
    });

    assert.equal(text("detail"), "● Agents · reviewer idle done");
    assert.equal(text("full"), `● Agents · reviewer idle done worktree ${run("reviewer").id}`);
});

test("without runs the base line is the bare title", (t) => {
    const { text } = fixture(t, {});

    assert.equal(text("base"), "○ Agents");
});

test("a failed run stays red until it is acknowledged, and fails again on a later turn", (t) => {
    const { dock, run, text } = fixture(t, {
        a: { turns: [turn({ state: "failed", error: "boom" })] },
    });

    assert.equal(text("base"), "✕ Agents 1 need attention");

    dock.acknowledge(run("a"));

    assert.equal(text("base"), "● Agents");

    // A later failure is a new turn, which the earlier acknowledgement did not cover.
    run("a").turns += 1;
    dock.refresh();

    assert.equal(text("base"), "✕ Agents 1 need attention");
});

test("a blocked run keeps attention until acknowledged even though its session is idle", (t) => {
    const { dock, run, text } = fixture(t, {
        a: {
            turns: [turn({ report: { status: "blocked", summary: "No.", reason: "No access." } })],
        },
    });

    assert.equal(run("a").state, "idle");
    assert.equal(text("base"), "✕ Agents 1 need attention");

    dock.acknowledge(run("a"));

    assert.equal(text("base"), "● Agents");
});

test("needs_input is highlighted separately from attention and is not acknowledged away", (t) => {
    const { dock, run, text } = fixture(t, {
        a: { turns: [turn({ report: { status: "needs_input", summary: "?", question: "Q?" } })] },
    });

    dock.acknowledge(run("a"));

    assert.equal(text("base"), "? Agents 1 needs input");
});

test("a run on another branch shows only once its ended turn waits for that branch", (t) => {
    const { dock, manager, run, text, sessionManager } = fixture(t, {
        a: { turns: [turn({ report: { status: "done", summary: "ok" } })] },
    });
    const target = run("a");

    // An empty leaf puts every run on another branch.
    sessionManager.resetLeaf();
    dock.refresh();

    assert.equal(manager.branchRuns().length, 0);
    assert.equal(text("base"), "○ Agents");

    manager.onTurnEnd(target, turn());
    dock.refresh();

    assert.match(text("detail"), /on another branch/);
});
