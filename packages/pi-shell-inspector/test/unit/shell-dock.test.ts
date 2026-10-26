/**
 * Unit tests for the shell dock and its summary line.
 *
 * `ShellDock` turns the shared `ShellManager` job list into the one-line widget pi shows below the
 * editor, and its private `shellDockSummary` decides what that line says for every combination of
 * job states: one running shell (command, elapsed seconds, refresh hint), one completed shell (its
 * runtime) or the per-status count list of a mixed job list. Every segment is requested in its own
 * status colour - accent while running, success when completed, error for failed and killed - and
 * the ` · ` separators plus the `/shell to open` hint stay dim, so the dock never reads as one
 * uniformly coloured block. The tests drive the real `shellManager`
 * singleton through a fake UI that records every `setWidget` and `theme.fg` call, so they assert
 * exactly what the extension asks pi to mount. How pi composes that widget with another extension's
 * widget is covered by `test/integration/subagent-widget.test.ts`; the real TUI is observed through
 * `test/tui`, where the `shelldocksum` scenario shows the same states by hand.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { ShellDock } from "../../src/shell/shell-dock.ts";
import { shellManager, type ShellJobStatus } from "../../src/shell/shell-manager.ts";
import {
    createFakeContext,
    createFakeUi,
    withoutMargin,
    type FakeExtensionUi,
} from "../harness.ts";

/**
 * Widget key the extension registers.
 *
 * pi keys widgets by this string, so it is part of the extension's external contract: changing it
 * changes where the dock appears relative to other extensions' widgets.
 */
const WIDGET_KEY = "pi-shell-inspector";

/** Start one job and settle it into `status`. */
function addJob(id: string, command: string, status: ShellJobStatus = "running"): void {
    shellManager.startJob({
        id,
        command,
        cwd: "/work",
        controller: new AbortController(),
    });

    switch (status) {
        case "running":
            return;
        case "completed":
            shellManager.settleJob(id, { type: "completed", exitCode: 0 });
            return;
        case "failed":
            shellManager.settleJob(id, {
                type: "failed",
                error: "Command exited with code 1",
                exitCode: 1,
            });
            return;
        case "killed":
            shellManager.settleJob(id, { type: "killed", error: "timeout:1" });
    }
}

/**
 * Move a job's timestamps into the past.
 *
 * The summary reads wall-clock elapsed seconds, so pinning `startedAt`/`finishedAt` relative to
 * `Date.now()` is what makes the rendered "Ns" deterministic without mocking the clock.
 */
function setJobTimes(id: string, startedAgoMs: number, finishedAgoMs?: number): void {
    const job = shellManager.getJob(id);
    assert.ok(job, `expected job ${id} to exist`);

    const mutable = job as { startedAt: number; finishedAt?: number };
    const now = Date.now();
    mutable.startedAt = now - startedAgoMs;
    if (finishedAgoMs !== undefined) {
        mutable.finishedAt = now - finishedAgoMs;
    }
}

/** Width wide enough that no part of any row below is left out. */
const WIDE = 200;

/** Terminal columns the standalone row reserves around its content: one margin column per side. */
const MARGIN_COLUMNS = 2;

describe("shell dock", () => {
    let dock: ShellDock;
    let ui: FakeExtensionUi;
    let ctx: ExtensionContext;

    beforeEach(() => {
        shellManager.clearAllJobs();
        dock = new ShellDock();
        ui = createFakeUi();
        ctx = createFakeContext("/work", { ui });
    });

    afterEach(() => {
        shellManager.clearAllJobs();
        // clear() also stops the refresh interval a running job started, so tests cannot leak a
        // timer into the next one.
        dock.clear();
    });

    /** Mount or refresh the dock through this test's context. */
    function render(): void {
        dock.setCtx(ctx);
        dock.render();
    }

    /** The row mounted below the editor, rendered at `width` exactly as pi would draw it. */
    function rowAt(width: number): string {
        const content = ui.renderedWidget("belowEditor", WIDGET_KEY, width);
        assert.ok(content, "the dock must be mounted");
        assert.equal(content.length, 1, "the dock must stay a single line");
        return content[0]!;
    }

    /** The dock line currently mounted below the editor, at a width that leaves nothing out. */
    function line(): string {
        return withoutMargin(rowAt(WIDE));
    }

    /** The row at `width` without its margin, with colour sequences removed. */
    function plainRowAt(width: number): string {
        return stripTerminalSequences(withoutMargin(rowAt(width)));
    }

    describe("render", () => {
        it("does nothing before a context is set", () => {
            addJob("job-1", "sleep 30");

            dock.render();

            assert.deepEqual(
                ui.widgetCalls,
                [],
                "a dock without a context must not touch the widget registry",
            );
        });

        it("does nothing without an interactive UI", () => {
            // Contract: a print/RPC session has no widget surface, so the dock must not touch it.
            addJob("job-1", "sleep 30");
            dock.setCtx(createFakeContext("/work", { ui, hasUI: false }));

            dock.render();
            dock.clear();

            assert.deepEqual(
                ui.widgetCalls,
                [],
                "a UI-less dock must not touch the widget registry",
            );
        });

        it("removes the widget when there is no job", () => {
            // Contract: an empty job list mounts nothing, which lets pi drop the row entirely.
            render();

            assert.deepEqual(
                ui.widgetCalls,
                [{ key: WIDGET_KEY, content: undefined, placement: undefined }],
                "an empty job list must clear the dock key",
            );
            assert.equal(
                ui.mountedWidget("belowEditor", WIDGET_KEY),
                undefined,
                "nothing may stay mounted for an empty list",
            );
        });

        it("mounts the single running shell below the editor", () => {
            // Contract: with exactly one running shell the line carries the command, the elapsed
            // seconds and the inspection hint, under the dock's own widget key.
            addJob("job-1", "sleep 30");
            setJobTimes("job-1", 400);

            render();

            const call = ui.widgetCalls.at(-1);
            assert.equal(call?.key, WIDGET_KEY, "the dock must use its own widget key");
            assert.equal(call?.placement, "belowEditor", "the dock must mount below the editor");
            assert.equal(
                typeof call?.content,
                "function",
                "the dock must mount a component, so it can fit its row to the width pi gives it",
            );
            assert.equal(
                line(),
                "1 running shell · sleep 30 · 0s · /shell to open",
                "the dock line must carry command, elapsed time and hint",
            );
            assert.deepEqual(
                ui.mountedKeys("belowEditor"),
                [WIDGET_KEY],
                "the dock must be the only below-editor widget",
            );
            assert.deepEqual(
                ui.mountedKeys("aboveEditor"),
                [],
                "the dock must not occupy the above-editor slot",
            );
        });

        it("shows the elapsed seconds of the single running shell", () => {
            addJob("job-1", "sleep 30");
            setJobTimes("job-1", 12_500);

            render();

            assert.equal(
                line(),
                "1 running shell · sleep 30 · 12s · /shell to open",
                "the elapsed segment must report whole seconds",
            );
        });

        it("does not let a command's control bytes break the dock's single line", () => {
            // Desired defensive contract: a command is data, so a newline or carriage return inside
            // it must not turn the one-line dock into a multi-line widget.
            addJob("job-1", "echo boom\nsecond line");
            setJobTimes("job-1", 100);

            render();

            const rendered = line();
            assert.equal(
                rendered.includes("\n"),
                false,
                `a command must not inject dock lines: ${JSON.stringify(rendered)}`,
            );
            assert.equal(
                rendered.includes("\r"),
                false,
                `a command must not inject carriage returns: ${JSON.stringify(rendered)}`,
            );
        });

        it("mounts the single completed shell with its runtime", () => {
            // Contract: once the only shell settled successfully, the docking line reports when it
            // completed; the kill hint stays, because the result is still worth inspecting.
            addJob("job-1", "echo done", "completed");
            setJobTimes("job-1", 5_000, 1_000);

            render();

            assert.equal(
                line(),
                "1 shell completed in 4s · /shell to open",
                "the completed shell must report its runtime",
            );
            assert.equal(
                ui.widgetCalls.at(-1)?.placement,
                "belowEditor",
                "the completed summary must stay below the editor",
            );
            assert.deepEqual(
                ui.fgCalls.filter((call) => call.color !== "dim" || call.text !== " · "),
                [
                    { color: "dim", text: "/shell to open" },
                    { color: "success", text: "1 shell completed" },
                ],
                "the completed count must be green and the hint dim",
            );
        });

        it("falls back to the count list when the running shell shares the list with settled shells", () => {
            // Contract: the dedicated running format is reserved for a list that holds nothing else;
            // as soon as another job settled, the summary switches to the count list and replaces the
            // command/elapsed segments.
            addJob("running", "sleep 30");
            addJob("completed-1", "echo one", "completed");
            addJob("completed-2", "echo two", "completed");

            render();

            assert.equal(
                line(),
                "3 shells · 1 running · 2 completed · /shell to open",
                "a mixed list must use the count summary",
            );
            assert.equal(
                line().includes("sleep 30"),
                false,
                "the count list must not carry a command",
            );
            assert.doesNotMatch(line(), /\d+s ·/, "the count list must not carry an elapsed time");
        });

        it("reports every status in running, completed, failed, killed order and omits empty ones", () => {
            addJob("running", "sleep 30", "running");
            addJob("completed", "echo done", "completed");
            addJob("failed", "exit 1", "failed");
            addJob("killed", "sleep 60", "killed");
            addJob("killed-2", "sleep 60", "killed");

            render();

            assert.equal(
                line(),
                "5 shells · 1 running · 1 completed · 1 failed · 2 killed · /shell to open",
                "the count list must follow running, completed, failed, killed order",
            );
        });

        it("shows no running segment when every shell settled", () => {
            addJob("completed", "echo done", "completed");
            addJob("failed", "exit 1", "failed");

            render();

            assert.equal(
                line(),
                "2 shells · 1 completed · 1 failed · /shell to open",
                "a settled-only list must omit the running segment",
            );
        });

        it("uses the count list for a single failed shell", () => {
            addJob("job-1", "exit 1", "failed");

            render();

            assert.equal(
                line(),
                "1 shell · 1 failed · /shell to open",
                "a single failed shell must use the count list",
            );
        });

        it("uses the count list for a single killed shell and marks it as an error", () => {
            // Contract: a killed shell has no dedicated single-job format, and its count is drawn in
            // the error colour like a failure - a killed background shell is worth noticing.
            addJob("job-1", "sleep 60", "killed");

            render();

            assert.equal(
                line(),
                "1 shell · 1 killed · /shell to open",
                "a single killed shell must use the count list",
            );
            assert.ok(
                ui.fgCalls.some((call) => call.color === "error" && call.text === "1 killed"),
                `the killed segment must be drawn in the error colour, got ${JSON.stringify(ui.fgCalls)}`,
            );
        });

        it("draws the count list in the status colours of its segments", () => {
            // Contract: the count list keeps the status colours of the mixed single-format cases and
            // joins them with a dim separator; only the hint is dim as a whole.
            addJob("running", "sleep 30");
            addJob("completed", "echo done", "completed");
            addJob("failed", "exit 1", "failed");
            addJob("killed", "sleep 60", "killed");

            render();

            assert.ok(
                ui.fgCalls.some((call) => call.color === "accent" && call.text === "1 running"),
                `the running segment must be accented, got ${JSON.stringify(ui.fgCalls)}`,
            );
            assert.ok(
                ui.fgCalls.some((call) => call.color === "success" && call.text === "1 completed"),
                `the completed segment must be green, got ${JSON.stringify(ui.fgCalls)}`,
            );
            assert.ok(
                ui.fgCalls.some((call) => call.color === "error" && call.text === "1 failed"),
                `the failed segment must be red, got ${JSON.stringify(ui.fgCalls)}`,
            );
            assert.ok(
                ui.fgCalls.some((call) => call.color === "error" && call.text === "1 killed"),
                `the killed segment must be red, got ${JSON.stringify(ui.fgCalls)}`,
            );
            assert.ok(
                ui.fgCalls.some((call) => call.color === "dim" && call.text === " · "),
                `the count segments must be joined with a dim separator, got ${JSON.stringify(ui.fgCalls)}`,
            );
            assert.ok(
                ui.fgCalls.some((call) => call.color === "dim" && call.text === "/shell to open"),
                `the hint must be dim, got ${JSON.stringify(ui.fgCalls)}`,
            );
            assert.ok(
                line().endsWith("/shell to open"),
                "the count list must still end with the hint",
            );
        });

        it("re-mounts the same key with updated content on every render", () => {
            // Contract: each render replaces the dock content under the same key; pi keeps one widget
            // per key, so later renders do not stack duplicate lines.
            addJob("job-1", "sleep 30", "running");
            addJob("job-2", "sleep 60", "running");
            render();
            assert.equal(
                line(),
                "2 shells · 2 running · /shell to open",
                "two running shells must use the count summary",
            );

            shellManager.settleJob("job-2", { type: "completed", exitCode: 0 });
            render();

            assert.equal(
                line(),
                "2 shells · 1 running · 1 completed · /shell to open",
                "the re-render must reflect the settled shell",
            );
            assert.deepEqual(
                ui.mountedKeys("belowEditor"),
                [WIDGET_KEY],
                "the re-render must not stack widget keys",
            );
        });

        it("keeps the command and elapsed seconds of the single running shell uncoloured", () => {
            // Contract: only the running count is accented; the command and elapsed seconds are plain
            // and the separators dim, so the summary is not one uniformly coloured block.
            addJob("job-1", "sleep 30");
            setJobTimes("job-1", 100);

            render();

            assert.deepEqual(
                ui.fgCalls.filter((call) => call.color !== "dim"),
                [{ color: "accent", text: "1 running shell" }],
                "only the running count may be accented; command and elapsed time stay plain",
            );
            assert.deepEqual(
                [
                    ...new Set(
                        ui.fgCalls.filter((call) => call.color === "dim").map((c) => c.text),
                    ),
                ].sort(),
                [" · ", "/shell to open"],
                "only the separators and the hint may be dim",
            );
        });

        it("refreshes the elapsed seconds every second and stops once nothing runs", () => {
            // Contract: while a shell runs, the dock re-renders on a one-second interval so the
            // elapsed segment advances without any other job event; the interval is torn down again
            // when the count reaches zero.
            mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
            try {
                addJob("job-1", "sleep 30");
                render();
                assert.equal(
                    line(),
                    "1 running shell · sleep 30 · 0s · /shell to open",
                    "the elapsed segment must start at zero seconds",
                );

                mock.timers.tick(1_000);
                assert.equal(
                    line(),
                    "1 running shell · sleep 30 · 1s · /shell to open",
                    "the interval must advance the elapsed segment by one second",
                );

                mock.timers.tick(3_000);
                assert.equal(
                    line(),
                    "1 running shell · sleep 30 · 4s · /shell to open",
                    "the elapsed segment must follow every tick",
                );

                shellManager.settleJob("job-1", { type: "completed", exitCode: 0 });
                render();
                const callsAfterSettle = ui.widgetCalls.length;
                mock.timers.tick(5_000);
                assert.equal(
                    ui.widgetCalls.length,
                    callsAfterSettle,
                    "the timer must stop when no shell runs",
                );
            } finally {
                shellManager.clearAllJobs();
                render();
                mock.timers.reset();
            }
        });
    });

    describe("width", () => {
        /** Render `expected` rows at their own width and one column narrower, in order. */
        function assertRowsShrinkInOrder(rows: readonly string[]): void {
            rows.forEach((expected, index) => {
                const width = visibleWidth(expected) + MARGIN_COLUMNS;
                assert.equal(
                    plainRowAt(width),
                    expected,
                    `at ${width} columns the row must keep exactly: ${expected}`,
                );

                const narrower = rows[index + 1];
                if (narrower !== undefined) {
                    assert.equal(
                        plainRowAt(width - 1),
                        narrower,
                        `one column below ${width} the row must leave out one whole part`,
                    );
                }
            });
        }

        it("shows the whole command of the single running shell instead of cutting it", () => {
            const command = `echo ${"x".repeat(60)}`;
            addJob("job-1", command);
            setJobTimes("job-1", 100);

            render();

            const actual = plainRowAt(WIDE);
            assert.equal(actual, `1 running shell · ${command} · 0s · /shell to open`);
            assert.equal(actual.includes("…"), false, "no part may be cut with an ellipsis");
        });

        it("leaves out hint, elapsed seconds and command of a running shell in that order", () => {
            addJob("job-1", "echo hello world");
            setJobTimes("job-1", 5_000);

            render();

            assertRowsShrinkInOrder([
                "1 running shell · echo hello world · 5s · /shell to open",
                "1 running shell · echo hello world · 5s",
                "1 running shell · echo hello world",
                "1 running shell",
            ]);
        });

        it("leaves out the hint of a completed shell before anything else", () => {
            addJob("job-1", "echo done", "completed");
            setJobTimes("job-1", 5_000, 1_000);

            render();

            assertRowsShrinkInOrder([
                "1 shell completed in 4s · /shell to open",
                "1 shell completed in 4s",
            ]);
        });

        it("leaves out counts by rank, keeping failures longest", () => {
            addJob("running", "sleep 30", "running");
            addJob("completed", "echo done", "completed");
            addJob("failed", "exit 1", "failed");
            addJob("killed", "sleep 60", "killed");
            addJob("killed-2", "sleep 60", "killed");

            render();

            // Hint first, then completed, running, killed, failed; the kept counts keep their order.
            assertRowsShrinkInOrder([
                "5 shells · 1 running · 1 completed · 1 failed · 2 killed · /shell to open",
                "5 shells · 1 running · 1 completed · 1 failed · 2 killed",
                "5 shells · 1 running · 1 failed · 2 killed",
                "5 shells · 1 failed · 2 killed",
                "5 shells · 1 failed",
                "5 shells",
            ]);
        });

        it("keeps the lead and falls back to the bare margin when even the lead does not fit", () => {
            addJob("job-1", "sleep 30");
            setJobTimes("job-1", 100);

            render();

            const leadWidth = visibleWidth("1 running shell");
            for (let width = 0; width < leadWidth + MARGIN_COLUMNS; width++) {
                assert.equal(rowAt(width), " ", `at ${width} columns only the margin may remain`);
            }
            assert.equal(plainRowAt(leadWidth + MARGIN_COLUMNS), "1 running shell");
        });

        it("never renders more than one line wider than the width or cut with an ellipsis", () => {
            // Every row shape at every width: whole parts or nothing, never a partial one.
            const scenarios: Array<[string, () => void]> = [
                [
                    "running",
                    () => addJob("a", "echo 运行测试脚本并输出结果 🚀 and more", "running"),
                ],
                ["completed", () => addJob("a", "echo done", "completed")],
                [
                    "mixed",
                    () => {
                        addJob("a", "sleep 30", "running");
                        addJob("b", "exit 1", "failed");
                        addJob("c", "sleep 60", "killed");
                    },
                ],
            ];

            for (const [name, setup] of scenarios) {
                shellManager.clearAllJobs();
                setup();
                setJobTimes("a", 5_000, 1_000);
                render();

                for (let width = 0; width <= 100; width++) {
                    const row = rowAt(width);
                    assert.equal(row.includes("\n"), false, `${name}@${width}: one line only`);
                    assert.ok(
                        visibleWidth(row) <= Math.max(width, 1),
                        `${name}@${width}: row too wide: ${JSON.stringify(row)}`,
                    );
                    assert.equal(
                        stripTerminalSequences(row).includes("…"),
                        false,
                        `${name}@${width}: no part may be cut with an ellipsis`,
                    );
                }
            }
        });
    });

    describe("clear", () => {
        it("removes only the dock widget", () => {
            addJob("job-1", "sleep 30");
            render();

            dock.clear();

            assert.equal(
                ui.mountedWidget("belowEditor", WIDGET_KEY),
                undefined,
                "clearing must unmount the dock key",
            );
            assert.deepEqual(
                ui.widgetCalls.at(-1),
                {
                    key: WIDGET_KEY,
                    content: undefined,
                    placement: undefined,
                },
                "the clear must be a setWidget(undefined) for the dock key",
            );
            assert.equal(dock.isSelected(), false, "clearing the dock must drop the selection");
        });

        it("does nothing without an interactive UI", () => {
            addJob("job-1", "sleep 30");
            dock.setCtx(createFakeContext("/work", { ui, hasUI: false }));

            dock.clear();

            assert.deepEqual(
                ui.widgetCalls,
                [],
                "a UI-less clear must not touch the widget registry",
            );
        });
    });
});
