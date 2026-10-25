import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
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
    type WidgetFactory,
} from "./support.ts";

const WIDTH = 200;

/**
 * Attaches the contribution to a TUI context that has a shared Dock host, then reads its snapshot.
 * With `mode: "print"` no host is attached and the standalone row is drawn instead.
 */
function fixture(
    t: TestContext,
    specs: Record<string, RunFileSpec>,
    options: { mode?: string } = {},
) {
    const agentDir = tempAgentDir(t);
    const session = parentSession(t, agentDir);

    for (const [runId, spec] of Object.entries(specs)) {
        session.spawn(runId, spec);
    }

    const manager: RunManager = session.manager();
    const { ctx, ui } = fakeCtx({
        sessionManager: session.sessionManager,
        theme: fakeTheme(),
        mode: options.mode,
    });
    const dock = new SubagentDockContribution(async () => undefined);
    const release =
        options.mode === undefined
            ? getDockRegistry().attachHost(ctx.ui, { invalidate() {} })
            : () => undefined;

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
    const text = (level: "base" | "detail" | "full", width = WIDTH) =>
        (snapshot()[level] ?? snapshot().base).render(width)[0]!;

    return { dock, manager, run, text, ui, sessionManager: session.sessionManager };
}

const NEEDS_INPUT = { status: "needs_input", summary: "?", question: "Q?" } as const;

test("the base line is only the marker and the title, whatever the runs do", (t) => {
    const { dock, run, text } = fixture(t, {
        a: {},
        b: { turns: [turn({ report: NEEDS_INPUT })] },
    });

    run("a").state = "running";
    dock.refresh();

    assert.equal(text("base"), "? Agents");
});

test("the detail line counts the runs by status in a fixed order", (t) => {
    const { dock, run, text } = fixture(t, {
        a: {},
        b: {},
        c: { turns: [turn({ report: NEEDS_INPUT })] },
        d: { turns: [turn({ report: { status: "blocked", summary: "No.", reason: "R" } })] },
        e: { turns: [turn({ state: "failed", error: "boom" })] },
        f: {},
        g: { turns: [turn()] },
        h: { turns: [turn({ report: { status: "done", summary: "ok" } })] },
        i: { turns: [turn({ report: { status: "done", summary: "ok" } })] },
        j: {},
    });

    run("a").state = "running";
    run("b").state = "running";
    run("f").state = "interrupted";
    dock.refresh();

    const expected =
        "✕ Agents · 2 running · 1 needs input · 1 blocked · 1 failed · 1 interrupted" +
        " · 1 unreported · 2 done · 1 idle";

    assert.equal(text("detail"), expected);
});

test("without runs every level is only the title", (t) => {
    const { text } = fixture(t, {});

    for (const level of ["base", "detail", "full"] as const) {
        assert.equal(text(level), "○ Agents");
    }
});

test("the full line adds the run whose turn ended last", (t) => {
    const { text } = fixture(t, {
        early: {
            turns: [turn({ endedAt: "2026-01-01T00:00:05.000Z", report: NEEDS_INPUT })],
        },
        late: {
            turns: [
                turn({
                    endedAt: "2026-01-01T00:00:09.000Z",
                    report: { status: "done", summary: "ok" },
                }),
            ],
        },
    });

    assert.equal(text("full"), "? Agents · 1 needs input · 1 done · latest: late done");
});

test("a run without any turn counts from its creation time for the latest part", (t) => {
    const { text } = fixture(t, {
        older: { snapshot: { createdAt: "2026-01-01T00:00:01.000Z" } },
        newer: { snapshot: { createdAt: "2026-01-01T00:00:02.000Z" } },
    });

    assert.equal(text("full"), "● Agents · 2 idle · latest: newer idle");
});

test("a failed run stays red until it is acknowledged, and fails again on a later turn", (t) => {
    const { dock, run, text } = fixture(t, {
        a: { turns: [turn({ state: "failed", error: "boom" })] },
    });

    assert.equal(text("base"), "✕ Agents");

    dock.acknowledge(run("a"));

    assert.equal(text("base"), "● Agents");
    assert.equal(text("detail"), "● Agents · 1 failed");

    // A later failure is a new turn, which the earlier acknowledgement did not cover.
    run("a").turns += 1;
    dock.refresh();

    assert.equal(text("base"), "✕ Agents");
});

test("a blocked run keeps attention until acknowledged even though its session is idle", (t) => {
    const { dock, run, text } = fixture(t, {
        a: {
            turns: [turn({ report: { status: "blocked", summary: "No.", reason: "No access." } })],
        },
    });

    assert.equal(run("a").state, "idle");
    assert.equal(text("base"), "✕ Agents");

    dock.acknowledge(run("a"));

    assert.equal(text("base"), "● Agents");
    assert.equal(text("detail"), "● Agents · 1 blocked");
});

test("needs_input is marked separately from attention and is not acknowledged away", (t) => {
    const { dock, run, text } = fixture(t, {
        a: { turns: [turn({ report: NEEDS_INPUT })] },
    });

    dock.acknowledge(run("a"));

    assert.equal(text("base"), "? Agents");
    assert.equal(text("detail"), "? Agents · 1 needs input");
});

test("a running run marks the item when nothing needs the user", (t) => {
    const { dock, run, text } = fixture(t, { a: {} });

    run("a").state = "running";
    dock.refresh();

    assert.equal(text("base"), "◐ Agents");
});

test("a run on another branch shows only once its ended turn waits for that branch", (t) => {
    const { dock, manager, text, sessionManager } = fixture(t, {
        a: { turns: [turn({ report: { status: "done", summary: "ok" } })] },
        b: { turns: [turn({ report: { status: "done", summary: "ok" } })] },
    });

    // An empty leaf puts every run on another branch.
    sessionManager.resetLeaf();
    dock.refresh();

    assert.equal(manager.branchRuns().length, 0);
    assert.equal(text("detail"), "○ Agents");

    manager.onTurnEnd(manager.otherBranchRuns()[0]!, turn());
    dock.refresh();

    assert.match(text("detail"), / · 1 on another branch$/);

    for (const other of manager.otherBranchRuns()) {
        manager.onTurnEnd(other, turn());
    }

    dock.refresh();

    assert.match(text("detail"), / · 2 on other branches$/);
});

// A failed, a running and a done run: the full line has every rank-driven part below.
function widthFixture(t: TestContext, options: { mode?: string } = {}) {
    const fx = fixture(
        t,
        {
            x: { turns: [turn({ state: "failed", error: "e", endedAt: "2026-01-01T00:10:00Z" })] },
            y: {
                turns: [
                    turn({
                        endedAt: "2026-01-01T00:11:00Z",
                        report: { status: "done", summary: "" },
                    }),
                ],
            },
            z: {},
        },
        options,
    );

    fx.run("z").state = "running";
    fx.dock.refresh();

    return fx;
}

test("a narrow cell drops whole parts by rank, then the title, and never cuts one", (t) => {
    const { text } = widthFixture(t);
    const steps = [
        "✕ Agents · 1 running · 1 failed · 1 done · latest: y done",
        "✕ Agents · 1 running · 1 failed · 1 done",
        "✕ Agents · 1 running · 1 failed",
        "✕ Agents · 1 failed",
        "✕ Agents",
        "✕",
    ];

    for (const expected of steps) {
        assert.equal(text("full", visibleWidth(expected)), expected);
    }

    // Between two steps the line stays at the richer step that still fits.
    assert.equal(text("full", visibleWidth(steps[0]!) - 1), steps[1]);
});

test("every level fits any width from 1 to 120", (t) => {
    const { text } = widthFixture(t);

    for (const level of ["base", "detail", "full"] as const) {
        for (let width = 1; width <= 120; width++) {
            const line = text(level, width);

            assert.ok(visibleWidth(line) <= width, `${level} at ${width}: "${line}"`);
        }
    }
});

test("the standalone row is a component factory with a space margin that fits its width", (t) => {
    const { ui } = widthFixture(t, { mode: "print" });
    const widget = ui.widgets.at(-1)!;

    assert.equal(widget.key, "pi-subagent");
    assert.deepEqual(widget.options, { placement: "belowEditor" });
    assert.equal(typeof widget.content, "function");

    const component = (widget.content as WidgetFactory)();
    const full = " ✕ Agents · 1 running · 1 failed · 1 done · latest: y done";

    assert.deepEqual(component.render(200), [`${full} · /agents to open`]);
    // The hint has the lowest rank, so it goes before the latest part.
    assert.deepEqual(component.render(visibleWidth(full) + 2), [full]);

    for (let width = 3; width <= 120; width++) {
        const [line] = component.render(width);

        assert.ok(line!.startsWith(" "));
        assert.ok(visibleWidth(line!) <= width, `at ${width}: "${line}"`);
    }
});

test("the standalone row is hidden without runs", (t) => {
    const { ui } = fixture(t, {}, { mode: "print" });

    assert.equal(ui.widgets.at(-1)!.content, undefined);
});
