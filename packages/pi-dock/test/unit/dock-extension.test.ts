import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import type { LuneDockSnapshot } from "@lune_99/pi-lune-extensions-core/dock";
import { getDockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";
import { getSettingsPanelRegistry } from "@lune_99/pi-lune-extensions-core/panel/host";

import { DockComponent } from "../../src/dock-controller.ts";
import luneDock from "../../src/index.ts";
import {
    FakeDockUi,
    assistantMessage,
    createAgentFixture,
    createMainEditor,
    createSessionContext,
    createUsage,
    identityTheme,
    keys,
    settle,
    textComponent,
    textSnapshot,
    waitFor,
    waitForIo,
} from "../harness.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** Hosts Core's settings panel the way Pi's custom UI does: it stays open until `done`. */
class ExtensionUi extends FakeDockUi {
    panel: Component | undefined;
    customCalls = 0;
    async custom(
        factory: (tui: TUI, theme: unknown, keybindings: unknown, done: () => void) => Component,
    ): Promise<void> {
        this.customCalls++;
        this.tui.overlay = true;
        await new Promise<void>((resolve) => {
            this.panel = factory(this.tui as unknown as TUI, identityTheme, {}, resolve);
        });
        this.panel = undefined;
        this.tui.overlay = false;
    }
}

interface StartOptions {
    global?: object;
    project?: object;
    mode?: string;
}

/** Loads the extension against a faked `pi`, real Core settings and an isolated agent directory. */
async function loadExtension(t: TestContext, options: StartOptions = {}) {
    const fixture = await createAgentFixture(t);
    if (options.global) await fixture.writeScope("global", options.global);
    if (options.project) await fixture.writeScope("project", options.project);

    const ui = new ExtensionUi(createMainEditor());
    const { ctx, session } = createSessionContext({ ui, cwd: fixture.cwd });
    Object.assign(ctx, { mode: options.mode ?? "tui" });
    const handlers = new Map<string, Set<Handler>>();
    const commands = new Map<string, CommandHandler>();
    const pi = {
        on(name: string, handler: Handler) {
            const group = handlers.get(name) ?? new Set();
            group.add(handler);
            handlers.set(name, group);
            return () => void group.delete(handler);
        },
        registerCommand(name: string, definition: { handler: CommandHandler }) {
            commands.set(name, definition.handler);
        },
    } as unknown as ExtensionAPI;

    const emit = async (name: string, payload: Record<string, unknown> = {}) => {
        const event = { type: name, ...payload };
        for (const handler of [...(handlers.get(name) ?? [])]) await handler(event, ctx);
    };
    t.after(() => emit("session_shutdown"));

    await luneDock(pi);

    const field = (id: string) => {
        const found = getSettingsPanelRegistry()
            .getSections(ui)
            .find(({ id: section }) => section === "dock")
            ?.fields.find((candidate) => candidate.id === id);
        assert.ok(found, `the Dock panel section must expose "${id}"`);
        return found;
    };

    return {
        ...fixture,
        ui,
        ctx,
        session,
        handlers,
        commands,
        emit,
        field,
        start: () => emit("session_start"),
        command: (name: string) => {
            const handler = commands.get(name);
            assert.ok(handler, `the /${name} command must be registered`);
            return handler("", ctx as ExtensionCommandContext);
        },
        subscriptionCount: () =>
            [...handlers.values()].reduce((total, group) => total + group.size, 0),
        isAttached: () => getDockRegistry().hasHost(ui),
        widget: () => {
            assert.ok(ui.component instanceof DockComponent, "the dock widget must be mounted");
            return ui.component;
        },
        render: (width = 100) =>
            (ui.component as DockComponent).render(width).map(stripTerminalSequences),
    };
}

function registerContribution(
    t: TestContext,
    ui: object,
    id: string,
    snapshot: () => LuneDockSnapshot = () => textSnapshot(id),
): void {
    const release = getDockRegistry().registerContribution(ui, {
        id,
        getSnapshot: snapshot,
        subscribe: () => () => {},
        activate: () => undefined,
    });
    t.after(release);
}

describe("dock extension startup", () => {
    it("attaches the dock when it is enabled", async (t) => {
        const f = await loadExtension(t);

        await f.start();

        assert.equal(f.isAttached(), true);
        assert.ok(f.ui.footer, "the default ruled style takes over Pi's footer");
        assert.equal(f.render().length, 5);
        assert.ok(f.ui.inputHandler, "the live dock owns terminal input");
    });

    it("registers the Dock panel for this UI and the /dock command", async (t) => {
        const f = await loadExtension(t);

        await f.start();

        const sections = getSettingsPanelRegistry().getSections(f.ui);
        assert.deepEqual(
            sections.map(({ id, label }) => [id, label]),
            [["dock", "Dock"]],
        );
        assert.ok(f.commands.has("dock"));
    });

    it("stays detached when the setting is off, but keeps the panel to turn it back on", async (t) => {
        const f = await loadExtension(t, { global: { enabled: false } });

        await f.start();

        assert.equal(f.isAttached(), false);
        assert.equal(f.ui.footerCalls.length, 0);
        assert.equal(f.ui.widgetCalls.length, 0);
        assert.equal(f.field("enabled").inspect().value, false);
    });

    it("lets a project override win over the global setting", async (t) => {
        const f = await loadExtension(t, {
            global: { style: "compact" },
            project: { style: "boxed" },
        });

        await f.start();

        assert.match(f.render(80)[0]!, /^╭─+╮$/);
    });

    it("lets a project override disable a dock that is enabled globally", async (t) => {
        const f = await loadExtension(t, {
            global: { enabled: true },
            project: { enabled: false },
        });

        await f.start();

        assert.equal(f.isAttached(), false);
    });

    it("reads every stored global value when the first session starts", async (t) => {
        const f = await loadExtension(t, { global: { enabled: false, displayMode: "full" } });

        await f.start();

        assert.equal(f.isAttached(), false, "the stored 'off' choice applies");
        assert.equal(f.field("displayMode").inspect().value, "full");
    });

    it("refuses to start the session on an invalid stored value and leaves the file alone", async (t) => {
        const stored = JSON.stringify({ style: "neon" });
        const f = await loadExtension(t);
        await f.writeRaw(f.settingsPath("global"), stored);

        await assert.rejects(f.start(), /style/);

        assert.equal(f.isAttached(), false);
        assert.equal(await f.readRaw(f.settingsPath("global")), stored);
    });

    it("starts the dock again, with current settings, when the session restarts", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        const first = f.widget();

        await f.field("style").set("compact", "global");
        await f.start();

        assert.equal(f.isAttached(), true);
        assert.notStrictEqual(f.widget(), first, "a restart mounts a fresh widget");
        assert.equal(f.render().length, 2, "the restarted dock draws the saved compact style");
    });
});

describe("dock extension live settings", () => {
    it("re-renders for a changed style without attaching the dock again", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        const widget = f.widget();
        const widgetCalls = f.ui.widgetCalls.length;
        const footerCalls = f.ui.footerCalls.length;
        assert.equal(f.render().length, 5);

        await f.field("style").set("compact", "global");

        assert.strictEqual(f.widget(), widget);
        assert.equal(f.ui.widgetCalls.length, widgetCalls);
        assert.equal(
            f.ui.footerCalls.length,
            footerCalls,
            "ruled and compact both replace the footer",
        );
        assert.equal(f.render().length, 2);
    });

    it("hands Pi's footer back when the style becomes classic", async (t) => {
        const f = await loadExtension(t);
        await f.start();

        await f.field("style").set("classic", "global");

        assert.equal(f.ui.footer, undefined);
        assert.equal(f.isAttached(), true);
    });

    it("applies hidden plugins and their order as soon as they are saved", async (t) => {
        const f = await loadExtension(t);
        registerContribution(t, f.ui, "shells");
        registerContribution(t, f.ui, "questions");
        await f.start();
        await settle();
        assert.match(f.render()[1]!, /^ shells │ questions/);

        await f.field("order").set({ questions: -1 }, "global");
        assert.match(f.render()[1]!, /^ questions │ shells/);

        await f.field("hidden").set(["shells"], "global");
        assert.match(f.render()[1]!, /questions/);
        assert.doesNotMatch(f.render()[1]!, /shells/);
    });

    it("applies the saved presentation level", async (t) => {
        const f = await loadExtension(t);
        registerContribution(t, f.ui, "shells", () => ({
            base: textComponent("base text"),
            detail: textComponent("detail text"),
            full: textComponent("full text"),
        }));
        await f.start();
        await settle();
        assert.match(f.render()[1]!, /detail text/);

        await f.field("displayMode").set("full", "global");

        assert.match(f.render()[1]!, /full text/);
    });

    it("detaches and restores Pi's footer when the dock is switched off", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        assert.ok(f.ui.footer);

        await f.field("enabled").set(false, "global");

        assert.equal(f.isAttached(), false);
        assert.equal(f.ui.footer, undefined);
        assert.equal(f.ui.component, undefined, "the widget is removed");
        assert.equal(f.ui.inputHandler, undefined, "terminal input is released");
    });

    it("attaches again when the dock is switched back on", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        await f.field("enabled").set(false, "global");

        await f.field("enabled").set(true, "global");

        assert.equal(f.isAttached(), true);
        assert.ok(f.ui.footer);
        assert.equal(f.render().length, 5);
    });

    it("does not touch the footer when an unrelated setting changes after another extension replaced it", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        const foreign: Component = { render: () => ["foreign footer"], invalidate() {} };
        f.ui.setFooter(() => foreign);

        await f.field("showModel").set(false, "global");

        assert.strictEqual(f.ui.footer, foreign);
    });
});

describe("dock extension session events", () => {
    it("drops dock focus before a tree navigation", async (t) => {
        const f = await loadExtension(t);
        registerContribution(t, f.ui, "shells");
        await f.start();
        await settle();
        assert.deepEqual(f.ui.sendInput(keys.down), { consume: true });
        assert.equal(f.widget().focused, true);

        await f.emit("session_before_tree");

        assert.equal(f.widget().focused, false);
    });

    it("redraws the dock after a tree navigation", async (t) => {
        const f = await loadExtension(t);
        registerContribution(t, f.ui, "shells");
        await f.start();
        await settle();
        const before = f.ui.tui.renderRequests;

        await f.emit("session_tree");
        await settle();

        assert.ok(f.ui.tui.renderRequests > before, "a tree navigation must request a fresh frame");
    });

    it("shows the measured token speed only after the response ends", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        const request = { timestamp: 1000 };

        await f.emit("message_start", { message: assistantMessage(createUsage(), request) });
        const generating = f.render(120)[1]!;
        await f.emit("message_update", {
            message: assistantMessage(createUsage({ output: 400 }), request),
        });
        const streaming = f.render(120)[1]!;
        await f.emit("message_end", {
            message: assistantMessage(createUsage({ output: 500 }), {
                ...request,
                durationMs: 2000,
            }),
        });
        const ended = f.render(120)[1]!;

        assert.match(generating, /claude-test • medium$/);
        assert.doesNotMatch(generating, /tok\/s|—/);
        assert.equal(streaming, generating, "partial usage stays unknown while streaming");
        assert.match(ended, /claude-test • medium · 250\.0 tok\/s$/);
        assert.doesNotMatch(ended, /—/);
    });

    it("resets the token speed after a completed tree navigation", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        await f.emit("message_end", {
            message: assistantMessage(createUsage({ output: 500 }), { durationMs: 2000 }),
        });
        assert.match(f.render(120)[1]!, /250\.0 tok\/s/);

        await f.emit("session_tree");

        assert.doesNotMatch(f.render(120)[1]!, /tok\/s|250\.0/);
    });

    it("resets the token speed when the session starts again", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        await f.emit("message_end", {
            message: assistantMessage(createUsage({ output: 500 }), { durationMs: 2000 }),
        });
        assert.match(f.render(120)[1]!, /250\.0 tok\/s/);

        await f.start();

        assert.doesNotMatch(f.render(120)[1]!, /tok\/s|250\.0/);
    });

    it("detaches the dock and removes every subscription on shutdown", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        assert.ok(f.subscriptionCount() > 0);

        await f.emit("session_shutdown");

        assert.equal(f.isAttached(), false);
        assert.equal(f.ui.footer, undefined);
        assert.equal(f.ui.component, undefined);
        assert.equal(f.ui.inputHandler, undefined);
        assert.deepEqual(getSettingsPanelRegistry().getSections(f.ui), []);
        assert.equal(f.subscriptionCount(), 0);
    });

    it("shuts down cleanly more than once", async (t) => {
        const f = await loadExtension(t);
        await f.start();

        await f.emit("session_shutdown");
        await f.emit("session_shutdown");

        assert.equal(f.isAttached(), false);
    });
});

describe("dock extension /dock command", () => {
    it("opens the settings panel on the Dock section", async (t) => {
        const f = await loadExtension(t);
        await f.start();

        const opening = f.command("dock");
        await waitFor(() => f.ui.panel !== undefined, "open the settings panel");
        const text = f.ui.panel!.render(110).map(stripTerminalSequences).join("\n");

        assert.match(text, /Lune settings/);
        assert.match(text, /Style/);
        assert.match(text, /Hidden plugins/);
        assert.match(text, /Plugin order/);

        f.ui.panel!.handleInput?.(keys.escape);
        await opening;
        assert.equal(f.ui.customCalls, 1);
    });

    it("applies a change made in the panel to the live dock", async (t) => {
        const f = await loadExtension(t);
        await f.start();
        const opening = f.command("dock");
        await waitFor(() => f.ui.panel !== undefined, "open the settings panel");
        const panelText = () => f.ui.panel!.render(110).map(stripTerminalSequences).join("\n");
        assert.match(panelText(), /Dock\s+on/);

        f.ui.panel!.handleInput?.(keys.enter);
        await waitForIo(() => !f.isAttached(), "detach after being switched off in the panel");
        assert.equal(f.ui.footer, undefined);
        await waitForIo(() => /Dock\s+off/.test(panelText()), "show the dock as off");

        f.ui.panel!.handleInput?.(keys.enter);
        await waitForIo(() => f.isAttached(), "attach after being switched on in the panel");
        assert.ok(f.ui.footer);

        f.ui.panel!.handleInput?.(keys.escape);
        await opening;
    });

    it("only warns outside the interactive terminal", async (t) => {
        for (const mode of ["rpc", "print"]) {
            const f = await loadExtension(t, { mode });
            await f.start();

            await f.command("dock");

            assert.deepEqual(f.ui.notifications, [
                { message: "Dock settings require interactive TUI mode", type: "warning" },
            ]);
            assert.equal(f.ui.customCalls, 0, mode);
        }
    });

    it("mounts neither the dock nor its panel outside the interactive terminal", async (t) => {
        const f = await loadExtension(t, { mode: "rpc" });

        await f.start();

        assert.equal(f.isAttached(), false);
        assert.equal(f.ui.footerCalls.length, 0);
        assert.deepEqual(getSettingsPanelRegistry().getSections(f.ui), []);
    });
});
