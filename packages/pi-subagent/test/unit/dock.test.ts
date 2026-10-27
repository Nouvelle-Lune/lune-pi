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
/** One second after the shared `turn()` fixture ends: inside the 10 s alert window. */
const SHORTLY_AFTER_TURN = "2026-01-01T00:00:05.000Z";
const ALERT_MS = 10_000;

/**
 * Attaches the contribution to a TUI context that has a shared Dock host, then reads its snapshot.
 * With `mode: "print"` no host is attached and the standalone row is drawn instead.
 */
function fixture(
    t: TestContext,
    specs: Record<string, RunFileSpec>,
    options: { mode?: string; now?: string; tag?: boolean } = {},
) {
    // A controlled clock keeps the fixed turn times of the specs inside or outside the alert window.
    if (options.now !== undefined) {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse(options.now) });
    }

    const agentDir = tempAgentDir(t);
    const session = parentSession(t, agentDir);

    for (const [runId, spec] of Object.entries(specs)) {
        session.spawn(runId, spec);
    }

    const manager: RunManager = session.manager();
    const { ctx, ui } = fakeCtx({
        sessionManager: session.sessionManager,
        theme: fakeTheme({ tag: options.tag }),
        mode: options.mode,
    });
    const dock = new SubagentDockContribution(async () => undefined);
    let invalidations = 0;
    const release =
        options.mode === undefined
            ? getDockRegistry().attachHost(ctx.ui, {
                  invalidate() {
                      invalidations++;
                  },
              })
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

    return {
        dock,
        manager,
        run,
        text,
        ui,
        sessionManager: session.sessionManager,
        invalidations: () => invalidations,
    };
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
    const { dock, run, text } = fixture(
        t,
        {
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
        },
        { now: SHORTLY_AFTER_TURN },
    );

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
    const { dock, run, text } = fixture(
        t,
        { a: { turns: [turn({ state: "failed", error: "boom" })] } },
        { now: SHORTLY_AFTER_TURN },
    );

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
    const { dock, run, text } = fixture(
        t,
        {
            a: {
                turns: [
                    turn({ report: { status: "blocked", summary: "No.", reason: "No access." } }),
                ],
            },
        },
        { now: SHORTLY_AFTER_TURN },
    );

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
        { ...options, now: "2026-01-01T00:10:05.000Z" },
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

const FAILED_TURN = { state: "failed", error: "boom" } as const;
// The shared `turn()` fixture ends at 00:00:04.200.
const TURN_END_MS = Date.parse("2026-01-01T00:00:04.200Z");

test("a failure shows the red marker for 10 seconds, then the dock redraws without it", (t) => {
    const { text, invalidations } = fixture(
        t,
        { a: { turns: [turn(FAILED_TURN)] } },
        { now: SHORTLY_AFTER_TURN },
    );

    assert.equal(text("base"), "✕ Agents");
    const before = invalidations();

    // The turn ended 0.8 s ago, so 9.2 s of the window remain.
    t.mock.timers.tick(TURN_END_MS + ALERT_MS - Date.parse(SHORTLY_AFTER_TURN) - 1);
    assert.equal(invalidations(), before, "no redraw while the window is open");

    t.mock.timers.tick(1);

    assert.equal(invalidations(), before + 1, "the host is invalidated when the window ends");
    assert.equal(text("base"), "● Agents");
    assert.equal(text("detail"), "● Agents · 1 failed");
});

test("acknowledging inside the window clears the marker at once", (t) => {
    const { dock, run, text } = fixture(
        t,
        { a: { turns: [turn(FAILED_TURN)] } },
        { now: SHORTLY_AFTER_TURN },
    );

    assert.equal(text("base"), "✕ Agents");

    dock.acknowledge(run("a"));

    assert.equal(text("base"), "● Agents");
});

test("a later turn that fails again raises a new alert after the first one expired", (t) => {
    const { dock, run, text, invalidations } = fixture(
        t,
        { a: { turns: [turn(FAILED_TURN)] } },
        { now: SHORTLY_AFTER_TURN },
    );

    t.mock.timers.tick(ALERT_MS);
    assert.equal(text("base"), "● Agents");

    // The second failed turn ended just now.
    const lastTurn = run("a").lastTurn!;
    run("a").lastTurn = { ...lastTurn, endedAt: new Date(Date.now()).toISOString() };
    run("a").turns += 1;
    dock.refresh();

    assert.equal(text("base"), "✕ Agents");
    const before = invalidations();

    t.mock.timers.tick(ALERT_MS);

    assert.equal(invalidations(), before + 1);
    assert.equal(text("base"), "● Agents");
});

test("a restored failure whose turn ended long ago is muted and never red", (t) => {
    const { text, invalidations } = fixture(
        t,
        { a: { turns: [turn(FAILED_TURN)] } },
        { now: "2026-01-01T01:00:00.000Z" },
    );
    const before = invalidations();

    assert.equal(text("base"), "● Agents");

    t.mock.timers.tick(ALERT_MS * 3);

    assert.equal(invalidations(), before, "an expired failure schedules no redraw");
    assert.equal(text("base"), "● Agents");
});

test("a failure without a turn time starts its window when the dock first checks it", (t) => {
    const { dock, run, text, invalidations } = fixture(t, { a: {} }, { now: SHORTLY_AFTER_TURN });

    t.mock.timers.tick(60_000);
    run("a").state = "failed";
    dock.refresh();

    assert.equal(run("a").lastTurn, undefined);
    assert.equal(text("base"), "✕ Agents");
    const before = invalidations();

    t.mock.timers.tick(ALERT_MS);

    assert.equal(invalidations(), before + 1);
    assert.equal(text("base"), "● Agents");
});

test("needs-input outranks a settled failure but not a failure inside its window", (t) => {
    const { text } = fixture(
        t,
        {
            a: { turns: [turn(FAILED_TURN)] },
            b: { turns: [turn({ report: NEEDS_INPUT })] },
        },
        { now: SHORTLY_AFTER_TURN },
    );

    assert.equal(text("base"), "✕ Agents");

    t.mock.timers.tick(ALERT_MS);

    assert.equal(text("base"), "? Agents");
});

test("a settled failure beside a done run keeps the muted marker", (t) => {
    const done = { status: "done", summary: "ok" } as const;
    const { text } = fixture(
        t,
        { a: { turns: [turn(FAILED_TURN)] }, b: { turns: [turn({ report: done })] } },
        { now: "2026-01-01T01:00:00.000Z", tag: true },
    );

    assert.equal(text("base"), "<muted:●> Agents");
});

test("nothing redraws after the dock detaches", (t) => {
    const { dock, text } = fixture(
        t,
        { a: { turns: [turn(FAILED_TURN)] } },
        { now: SHORTLY_AFTER_TURN },
    );

    assert.equal(text("base"), "✕ Agents");
    dock.detach({ retired: true });
    const redraw = t.mock.method(dock, "refresh");

    t.mock.timers.tick(ALERT_MS * 2);

    assert.equal(redraw.mock.callCount(), 0);
});

test("the marker colors follow the priority: error in the window, then muted, then success", (t) => {
    const done = { status: "done", summary: "ok" } as const;
    const failing = fixture(
        t,
        { a: { turns: [turn(FAILED_TURN)] } },
        { now: SHORTLY_AFTER_TURN, tag: true },
    );

    assert.equal(failing.text("base"), "<error:✕> Agents");

    t.mock.timers.tick(ALERT_MS);

    assert.equal(failing.text("base"), "<muted:●> Agents");

    const healthy = fixture(t, { b: { turns: [turn({ report: done })] } }, { tag: true });

    assert.equal(healthy.text("base"), "<success:●> Agents");
});
