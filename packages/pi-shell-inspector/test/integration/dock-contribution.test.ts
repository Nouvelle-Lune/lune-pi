import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDockRegistry, type DockHost } from "@lune_99/pi-lune-extensions-core/dock/host";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { installShellInspector } from "../../src/index.ts";
import { ShellDockContribution } from "../../src/shell/shell-dock-contribution.ts";
import { ShellManager, type ShellJobStatus } from "../../src/shell/shell-manager.ts";
import {
    createFakeContext,
    createFakeUi,
    type CustomCall,
    type FakeExtensionUi,
} from "../harness.ts";

const WIDGET_KEY = "pi-shell-inspector";
const liveSessions: ShellSession[] = [];
const directContributions: ShellDockContribution[] = [];

interface ShellSession {
    host: ShellHost;
    /** Shell manager of the extension load this session runs on. */
    manager: ShellManager;
    ui: FakeExtensionUi;
    ctx: ExtensionContext;
    closed: boolean;
}

type ShellHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface ShellHost {
    readonly manager: ShellManager;
    readonly commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>;
    fire(event: string, ctx: ExtensionContext): Promise<void>;
}

/** Register the real extension entry point against the smallest API surface its lifecycle uses. */
function createShellHost(): ShellHost {
    const handlers = new Map<string, ShellHandler[]>();
    const commands = new Map<
        string,
        { handler: (args: string, ctx: ExtensionContext) => unknown }
    >();
    const api = {
        on(event: string, handler: ShellHandler) {
            const registered = handlers.get(event) ?? [];
            registered.push(handler);
            handlers.set(event, registered);
            return () => {
                const index = registered.indexOf(handler);
                if (index >= 0) registered.splice(index, 1);
            };
        },
        registerTool() {},
        registerMessageRenderer() {},
        registerCommand(
            name: string,
            options: { handler: (args: string, ctx: ExtensionContext) => unknown },
        ) {
            commands.set(name, options);
        },
        appendEntry() {},
        sendMessage() {},
    } as unknown as ExtensionAPI;

    const manager = installShellInspector(api);

    return {
        manager,
        commands,
        async fire(event, ctx) {
            for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
        },
    };
}

/** Start a background-job record with the requested settled state. */
function addJob(manager: ShellManager, id: string, status: ShellJobStatus): void {
    manager.startJob({
        id,
        command: `echo ${id}`,
        cwd: "/work",
        controller: new AbortController(),
    });
    if (status === "running") return;
    if (status === "completed") {
        manager.settleJob(id, { type: "completed", exitCode: 0 });
        return;
    }
    if (status === "failed") {
        manager.settleJob(id, {
            type: "failed",
            error: "Command exited with code 1",
            exitCode: 1,
        });
        return;
    }
    manager.settleJob(id, { type: "killed", error: "killed by test" });
}

/** Start the real extension lifecycle with an isolated UI scope. */
async function startSession(ui = createFakeUi(), host = createShellHost()): Promise<ShellSession> {
    const ctx = createFakeContext("/work", { ui });
    await host.fire("session_start", ctx);
    const session = { host, manager: host.manager, ui, ctx, closed: false };
    liveSessions.push(session);
    return session;
}

/** Mount a dock host in one UI scope and count invalidations from that contribution. */
function attachHost(ui: object, onInvalidate: () => void = () => undefined): () => void {
    const host: DockHost = { invalidate: onInvalidate };
    return getDockRegistry().attachHost(ui, host);
}

/** Hold `ctx.ui.custom` open so a test can add failures before the inspector closes. */
function holdOverlayOpen(ui: FakeExtensionUi): { close(): void } {
    let finish: (() => void) | undefined;
    ui.custom = (factory, options) => {
        (ui.customCalls as CustomCall[]).push({ factory, options });
        return new Promise((resolve) => {
            finish = () => resolve(undefined);
        });
    };
    return {
        close() {
            assert.ok(finish, "the inspector overlay must have opened before it can close");
            finish();
        },
    };
}

function firstChar(contribution: ShellDockContribution): string {
    return stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0);
}

/** The theme color requested for the marker of a fresh snapshot. */
function markerColor(ui: FakeExtensionUi, contribution: ShellDockContribution): string {
    const before = ui.fgCalls.length;
    contribution.getSnapshot();
    const call = ui.fgCalls.slice(before).find((entry) => "✕◐●○".includes(entry.text));
    assert.ok(call, "the snapshot must color its marker");
    return call.color;
}

describe("shell dock contribution", () => {
    // Fresh job table for the contributions the tests build directly; sessions bring their own.
    let manager: ShellManager;

    beforeEach(() => {
        manager = new ShellManager();
    });

    afterEach(async () => {
        for (const session of liveSessions.splice(0)) {
            if (!session.closed) {
                await session.host.fire("session_shutdown", session.ctx);
                session.closed = true;
            }
        }
        for (const contribution of directContributions.splice(0)) contribution.detach();
        manager.clearAllJobs();
    });

    it("aggregates running, completed, failed, and killed jobs into the shared item status", () => {
        // Contract: the shell item counts tracked jobs and prioritizes unseen failures over running and completed work.
        const contribution = new ShellDockContribution(manager);
        directContributions.push(contribution);
        contribution.attach(createFakeContext("/work"));

        const idle = contribution.getSnapshot();
        for (const level of [idle.base, idle.detail!, idle.full!]) {
            assert.equal(stripTerminalSequences(level.render(100)[0]!), "○ Shell");
        }

        addJob(manager, "completed", "completed");
        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().detail!.render(100)[0]!),
            "● Shell · 1 completed",
        );

        addJob(manager, "running", "running");
        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "◐",
            "running work outranks completed work",
        );
        assert.match(
            stripTerminalSequences(contribution.getSnapshot().detail!.render(100)[0]!),
            /1 running · 1 completed/,
        );

        addJob(manager, "failed", "failed");
        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "✕",
            "a failed job outranks running work",
        );
        addJob(manager, "killed", "killed");
        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "✕",
            "a killed job also requires attention",
        );
        assert.match(
            stripTerminalSequences(contribution.getSnapshot().detail!.render(100)[0]!),
            /2 failed\/killed/,
        );
    });

    it("publishes complete passive single-line snapshots with command and elapsed time", async () => {
        const session = await startSession();
        addJob(session.manager, "latest", "completed");
        const mounted = getDockRegistry().getContributions(session.ui)[0]!;
        const previous = mounted.snapshot;
        assert.match(
            stripTerminalSequences(previous.full!.render(200)[0]!),
            /latest: echo latest · \d+s/,
        );
        for (const level of [previous.base, previous.detail!, previous.full!]) {
            for (const width of [0, 1, 8, 30, 120]) {
                const lines = level.render(width);
                assert.equal(lines.length, 1);
                assert.ok(visibleWidth(lines[0]!) <= width);
            }
        }
        addJob(session.manager, "second", "completed");
        assert.notStrictEqual(mounted.snapshot, previous);
        assert.match(stripTerminalSequences(previous.detail!.render(200)[0]!), /1 completed/);
        assert.match(
            stripTerminalSequences(mounted.snapshot.detail!.render(200)[0]!),
            /2 completed/,
        );
    });

    it("leaves out whole parts of the full line in rank order and never cuts one with an ellipsis", async () => {
        // Contract: elapsed goes first, then the latest command, completed, running, failed/killed,
        // the Shell title and finally the marker; the kept parts stay in their original order.
        const session = await startSession();
        addJob(session.manager, "r", "running");
        addJob(session.manager, "c", "completed");
        addJob(session.manager, "f", "failed");
        const full = getDockRegistry().getContributions(session.ui)[0]!.snapshot.full!;
        const levels = [
            "✕ Shell · 1 running · 1 completed · 1 failed/killed · latest: echo f",
            "✕ Shell · 1 running · 1 completed · 1 failed/killed",
            "✕ Shell · 1 running · 1 failed/killed",
            "✕ Shell · 1 failed/killed",
            "✕ Shell",
            "✕",
            "",
        ];

        assert.match(
            stripTerminalSequences(full.render(200)[0]!),
            /^✕ Shell · 1 running · 1 completed · 1 failed\/killed · latest: echo f · \d+s$/,
        );
        levels.forEach((expected, index) => {
            const rendered = stripTerminalSequences(full.render(visibleWidth(expected))[0]!);
            assert.equal(rendered, expected, `a row exactly this wide keeps: ${expected}`);
            assert.equal(rendered.includes("…"), false);
            if (index + 1 < levels.length) {
                const narrower = stripTerminalSequences(
                    full.render(visibleWidth(expected) - 1)[0]!,
                );
                assert.equal(narrower, levels[index + 1], "one column less drops one whole part");
            }
        });
    });

    it("keeps a newly failed job red when a successful inspector open acknowledges only its opening snapshot", async () => {
        // Contract: closing the inspector acknowledges only failures present when it opened, while completed work can then show green.
        const ui = createFakeUi();
        const ctx = createFakeContext("/work", { ui });
        const contribution = new ShellDockContribution(manager);
        directContributions.push(contribution);
        contribution.attach(ctx);
        addJob(manager, "old-failure", "failed");
        addJob(manager, "completed", "completed");
        const overlay = holdOverlayOpen(ui);

        const opening = contribution.open(ctx);
        addJob(manager, "new-failure", "failed");
        overlay.close();
        await opening;

        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "✕",
            "the failure that arrived while the panel was open remains unseen",
        );
        assert.equal(manager.clearJob("new-failure"), true);
        contribution.onManagerEvent({ type: "job-cleared", id: "new-failure" });
        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "●",
            "the original failure was acknowledged and only completed work remains",
        );
    });

    it("settles an only-failed item to a muted marker once its failure has been opened", async () => {
        // Contract: reading a failed job clears its alert; the item then shows the settled muted
        // marker instead of staying red or claiming success.
        const ui = createFakeUi();
        const ctx = createFakeContext("/work", { ui });
        const contribution = new ShellDockContribution(manager);
        directContributions.push(contribution);
        contribution.attach(ctx);
        addJob(manager, "only-failure", "failed");
        assert.equal(firstChar(contribution), "✕");
        const overlay = holdOverlayOpen(ui);

        const opening = contribution.open(ctx);
        overlay.close();
        await opening;

        assert.equal(firstChar(contribution), "●");
        assert.match(
            stripTerminalSequences(contribution.getSnapshot().detail!.render(100)[0]!),
            /1 failed\/killed/,
        );
        assert.equal(markerColor(ui, contribution), "muted");
    });

    describe("error marker window", () => {
        const ALERT_MS = 10_000;

        /** A contribution under a shared Dock host with a controlled clock, counting redraws. */
        function timedContribution(t: TestContext) {
            t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
            const ui = createFakeUi();
            const ctx = createFakeContext("/work", { ui });
            let invalidations = 0;
            const release = attachHost(ui, () => {
                invalidations++;
            });
            const contribution = new ShellDockContribution(manager);
            contribution.attach(ctx);
            t.after(() => {
                contribution.detach();
                release();
            });
            return {
                ui,
                ctx,
                contribution,
                invalidations: () => invalidations,
                marker: () => firstChar(contribution),
                color: () => markerColor(ui, contribution),
            };
        }

        it("shows the red marker for 10 seconds, then redraws the cell without it", (t) => {
            const fx = timedContribution(t);
            addJob(manager, "f", "failed");
            fx.contribution.onManagerEvent({ type: "job-failed", id: "f" });
            const mounted = getDockRegistry().getContributions(fx.ctx.ui)[0]!;
            assert.equal(
                stripTerminalSequences(mounted.snapshot.base.render(100)[0]!).charAt(0),
                "✕",
            );
            const before = fx.invalidations();

            t.mock.timers.tick(ALERT_MS - 1);
            assert.equal(fx.invalidations(), before, "no redraw before the window ends");
            assert.equal(fx.marker(), "✕");

            t.mock.timers.tick(1);

            assert.equal(fx.invalidations(), before + 1, "the host is invalidated at 10 s");
            assert.equal(
                stripTerminalSequences(mounted.snapshot.base.render(100)[0]!).charAt(0),
                "●",
                "the republished snapshot no longer carries the marker",
            );
            assert.equal(fx.color(), "muted");
        });

        it("measures the window from when the job finished, not from when the cell is drawn", (t) => {
            const fx = timedContribution(t);
            addJob(manager, "f", "failed");
            t.mock.timers.tick(ALERT_MS - 2_000);
            assert.equal(fx.marker(), "✕");
            const before = fx.invalidations();

            t.mock.timers.tick(2_000);

            assert.equal(fx.invalidations(), before + 1);
            assert.equal(fx.marker(), "●");
        });

        it("clears the marker at once when the failure is opened inside the window", async (t) => {
            const fx = timedContribution(t);
            addJob(manager, "f", "failed");
            addJob(manager, "ok", "completed");
            assert.equal(fx.marker(), "✕");
            const overlay = holdOverlayOpen(fx.ui);

            const opening = fx.contribution.open(fx.ctx);
            overlay.close();
            await opening;

            assert.equal(fx.marker(), "●");
            assert.equal(fx.color(), "muted", "an acknowledged failure is not green");
        });

        it("settles failed beside completed jobs to the muted marker and completed alone to success", (t) => {
            const fx = timedContribution(t);
            addJob(manager, "ok", "completed");
            assert.equal(fx.color(), "success");
            addJob(manager, "f", "failed");
            assert.equal(fx.color(), "error");

            t.mock.timers.tick(ALERT_MS);

            assert.equal(fx.marker(), "●");
            assert.equal(fx.color(), "muted");
        });

        it("shows the running marker over a settled failure and the muted one after it ends", (t) => {
            const fx = timedContribution(t);
            addJob(manager, "f", "failed");
            t.mock.timers.tick(ALERT_MS);
            addJob(manager, "run", "running");
            assert.equal(fx.marker(), "◐");
            assert.equal(fx.color(), "warning");

            manager.settleJob("run", { type: "killed", error: "killed by test" });
            assert.equal(fx.marker(), "✕", "the kill is a new failure with its own window");

            t.mock.timers.tick(ALERT_MS);

            assert.equal(fx.marker(), "●");
            assert.equal(fx.color(), "muted");
        });

        it("starts a new window for a later failure", (t) => {
            const fx = timedContribution(t);
            addJob(manager, "first", "failed");
            t.mock.timers.tick(ALERT_MS);
            assert.equal(fx.marker(), "●");

            addJob(manager, "second", "failed");

            assert.equal(fx.marker(), "✕");
            const before = fx.invalidations();
            t.mock.timers.tick(ALERT_MS);
            assert.equal(fx.invalidations(), before + 1);
            assert.equal(fx.marker(), "●");
        });

        it("stops the pending redraw when the contribution detaches", (t) => {
            const fx = timedContribution(t);
            addJob(manager, "f", "failed");
            assert.equal(fx.marker(), "✕");

            fx.contribution.detach();
            const redraw = t.mock.method(fx.contribution, "render");
            t.mock.timers.tick(ALERT_MS * 2);

            assert.equal(redraw.mock.callCount(), 0, "a detached item draws nothing late");
        });

        it("stops the pending redraw when the jobs are cleared", (t) => {
            const fx = timedContribution(t);
            addJob(manager, "f", "failed");
            assert.equal(fx.marker(), "✕");
            manager.clearAllJobs();
            fx.contribution.onManagerEvent({ type: "jobs-cleared" });
            const redraw = t.mock.method(fx.contribution, "render");

            t.mock.timers.tick(ALERT_MS * 2);

            assert.equal(redraw.mock.callCount(), 0, "nothing redraws for cleared jobs");
        });
    });

    it("does not acknowledge failures when opening the inspector rejects", async () => {
        // Contract: a failed panel launch did not expose the failed-job snapshot, so the alert must stay unseen.
        const ui = createFakeUi();
        ui.custom = () => Promise.reject(new Error("overlay failed"));
        const ctx = createFakeContext("/work", { ui });
        const contribution = new ShellDockContribution(manager);
        directContributions.push(contribution);
        contribution.attach(ctx);
        addJob(manager, "failed", "failed");

        await assert.rejects(contribution.open(ctx), /overlay failed/);
        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "✕",
        );
    });

    it("forgets acknowledged failure IDs when the manager is cleared", async () => {
        // Contract: clearing tracked jobs resets the acknowledgement set, so a later job reusing an ID is reported as a new failure.
        const ui = createFakeUi();
        const ctx = createFakeContext("/work", { ui });
        const contribution = new ShellDockContribution(manager);
        directContributions.push(contribution);
        contribution.attach(ctx);
        addJob(manager, "reused-id", "failed");
        addJob(manager, "completed", "completed");
        const overlay = holdOverlayOpen(ui);

        const opening = contribution.open(ctx);
        overlay.close();
        await opening;
        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "●",
            "the viewed failure is acknowledged beside completed history",
        );

        manager.clearAllJobs();
        contribution.onManagerEvent({ type: "jobs-cleared" });
        addJob(manager, "reused-id", "failed");

        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "✕",
            "a failure after the reset is unseen even when its ID was acknowledged before",
        );
    });

    it("returns from busy to healthy when the last running job completes beside completed history", () => {
        // Contract: running work keeps the aggregate busy until it settles, then completed history is healthy.
        const contribution = new ShellDockContribution(manager);
        directContributions.push(contribution);
        contribution.attach(createFakeContext("/work"));
        addJob(manager, "completed", "completed");
        addJob(manager, "running", "running");

        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "◐",
        );
        assert.equal(manager.settleJob("running", { type: "completed", exitCode: 0 }), true);
        assert.equal(
            stripTerminalSequences(contribution.getSnapshot().base.render(100)[0]!).charAt(0),
            "●",
        );
    });

    it("keeps a host scoped to another UI from hiding this session's fallback and restores the fallback when detached", async () => {
        // Contract: only a host attached to the contributor's UI scope may take over its widget, and detaching that host restores the standalone widget.
        const session = await startSession();
        const otherUi = createFakeUi();
        const before = session.ui.widgetCalls.length;
        addJob(session.manager, "visible", "completed");
        const otherHostRelease = attachHost(otherUi);

        assert.ok(
            session.ui.mountedWidget("belowEditor", WIDGET_KEY),
            "a host in another UI cannot claim this contribution",
        );
        assert.equal(getDockRegistry().getContributions(otherUi).length, 0);
        assert.equal(getDockRegistry().getContributions(session.ui).length, 1);

        const hostRelease = attachHost(session.ui);
        assert.equal(
            session.ui.mountedWidget("belowEditor", WIDGET_KEY),
            undefined,
            "the scoped host owns the compact representation",
        );
        hostRelease();
        assert.ok(
            session.ui.mountedWidget("belowEditor", WIDGET_KEY),
            "host removal restores the plugin's original widget",
        );
        assert.ok(session.ui.widgetCalls.length > before);

        otherHostRelease();
    });

    it("retires old registrations across repeated starts, reload, and shutdown without stale UI writes", async () => {
        // Contract: each session start owns one manager listener and one UI registration, and retired contexts receive no later writes.
        const first = await startSession();
        addJob(first.manager, "before-restart", "completed");
        const firstCallsAtRestart = first.ui.widgetCalls.length;
        const secondUi = createFakeUi();
        const secondCtx = createFakeContext("/work", { ui: secondUi });

        await first.host.fire("session_start", secondCtx);
        first.ctx = secondCtx;
        assert.equal(
            getDockRegistry().getContributions(first.ui).length,
            0,
            "the previous UI registration is released",
        );
        assert.equal(
            getDockRegistry().getContributions(secondUi).length,
            1,
            "the replacement session registers exactly once",
        );
        const firstCallsAfterRestart = first.ui.widgetCalls.length;

        addJob(first.manager, "after-restart", "completed");
        assert.equal(
            first.ui.widgetCalls.length,
            firstCallsAfterRestart,
            "the old UI receives no job event",
        );
        assert.ok(secondUi.widgetCalls.length > 0, "the active UI receives the job event");

        await first.host.fire("session_shutdown", secondCtx);
        first.closed = true;
        assert.equal(
            getDockRegistry().getContributions(secondUi).length,
            0,
            "shutdown releases the active registration",
        );
        const callsAfterShutdown = secondUi.widgetCalls.length;

        const reloaded = await startSession(secondUi);
        assert.equal(
            getDockRegistry().getContributions(secondUi).length,
            1,
            "a reloaded extension owns one fresh registration",
        );
        const callsBeforeReloadedJob = secondUi.widgetCalls.length;
        addJob(reloaded.manager, "after-reload", "completed");
        assert.equal(
            secondUi.widgetCalls.length,
            callsBeforeReloadedJob + 2,
            "the reloaded listener renders the start and settle events once each",
        );
        assert.ok(secondUi.widgetCalls.length > callsAfterShutdown);
        assert.equal(
            first.ui.widgetCalls.length,
            firstCallsAtRestart,
            "the retired UI remains untouched after reload",
        );

        await reloaded.host.fire("session_shutdown", reloaded.ctx);
        reloaded.closed = true;
    });
});
