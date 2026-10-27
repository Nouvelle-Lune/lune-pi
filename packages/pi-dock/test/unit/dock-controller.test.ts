import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";

import type { LuneDockSnapshot } from "@lune_99/pi-lune-extensions-core/dock";
import { createDockRegistry, type DockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";

import { DockComponent, DockController, WIDGET_ID } from "../../src/dock-controller.ts";
import { DOCK_STYLES } from "../../src/dock-footer.ts";
import { DockStatusSource } from "../../src/dock-status.ts";
import {
    FakeDockUi,
    FakeTui,
    assistantMessage,
    createCompactionReader,
    createControllerSettings,
    createMainEditor,
    createModel,
    createSessionContext,
    createTestContext,
    createUsage,
    keys,
    settle,
    textComponent,
    textSnapshot,
    waitFor,
} from "../harness.ts";

interface ContributionOptions {
    snapshot?: () => LuneDockSnapshot;
    subscribe?: (listener: (snapshot: LuneDockSnapshot) => void) => () => void;
    activate?: () => void | Promise<void>;
}

/** Registers a protocol contribution; by default it publishes its id as a single base line. */
function registerContribution(
    registry: DockRegistry,
    scope: object,
    id: string,
    options: ContributionOptions = {},
): () => void {
    return registry.registerContribution(scope, {
        id,
        getSnapshot: options.snapshot ?? (() => textSnapshot(id)),
        subscribe: options.subscribe ?? (() => () => {}),
        activate: options.activate ?? (() => undefined),
    });
}

function componentOf(ui: FakeDockUi): DockComponent {
    assert.ok(
        ui.component instanceof DockComponent,
        "the dock widget factory must mount its component",
    );
    return ui.component;
}

/** The dock row of the footer block; the rows around it are the rules and the info rows. */
function dockRowOf(component: DockComponent, width = 100): string {
    return stripTerminalSequences(component.render(width)[1]!);
}

/** Down on an empty main editor, or Super+Down over a draft, is the documented way into the dock. */
function focusDock(ui: FakeDockUi, entryKey: string = keys.down): DockComponent {
    assert.deepEqual(ui.sendInput(entryKey), { consume: true });
    const component = componentOf(ui);
    assert.equal(component.focused, true, "entering the dock must focus its component");
    return component;
}

describe("dock controller", () => {
    it("renders the visible contributions in the dock row of a below-editor block", async () => {
        const { ui, ctx, registry } = createTestContext();
        registerContribution(registry, ctx.ui, "shells", {
            snapshot: () => textSnapshot("2 shells"),
        });
        registerContribution(registry, ctx.ui, "questions", {
            snapshot: () => textSnapshot("1 question"),
        });
        await settle();

        const lines = componentOf(ui).render(100);

        assert.equal(lines.length, 5, "rule, dock row, rule, info row, rule");
        assert.match(
            dockRowOf(componentOf(ui)),
            /^ 2 shells │ 1 question +│ +claude-test • medium$/,
        );
        assert.deepEqual(
            ui.widgetCalls
                .filter((call) => call.content !== undefined)
                .map((call) => [call.key, call.placement]),
            [[WIDGET_ID, "belowEditor"]],
        );
    });

    it("keeps the selected contribution visible within a narrow terminal", () => {
        const { ui, ctx, registry, controller } = createTestContext();
        for (let index = 0; index < 8; index++)
            registerContribution(registry, ctx.ui, `module-${index}`);

        const component = focusDock(ui);
        assert.equal(controller.selectedId, "module-0");
        component.handleInput(keys.right);
        component.handleInput(keys.right);
        assert.equal(controller.selectedId, "module-2");

        const lines = component.render(14);

        for (const line of lines) {
            assert.ok(visibleWidth(line) <= 14, `row exceeds terminal width: ${line}`);
        }
        assert.match(dockRowOf(component, 14), /^❯/, "the dock row must still show the focus mark");
        assert.equal(component.focused, true, "overflow must preserve the dock's keyboard focus");
    });

    it("enters focus from Down only for a focused, empty editor without an overlay", () => {
        const { ui, ctx, registry, editor } = createTestContext();
        registerContribution(registry, ctx.ui, "shells");
        const component = componentOf(ui);

        ui.tui.focusedComponent = {
            render: () => [],
            handleInput: () => undefined,
            invalidate: () => undefined,
        };
        assert.equal(ui.sendInput(keys.down), undefined, "another component owns Down");
        assert.notEqual(ui.tui.focusedComponent, component);

        ui.tui.focusedComponent = editor;
        editor.isShowingAutocomplete = () => true;
        assert.equal(ui.sendInput(keys.down), undefined, "an open autocomplete owns Down");

        editor.isShowingAutocomplete = () => false;
        ui.tui.overlay = true;
        assert.equal(ui.sendInput(keys.down), undefined, "an overlay owns Down");

        ui.tui.overlay = false;
        ui.editorText = "keep this draft";
        assert.equal(
            ui.sendInput(keys.down),
            undefined,
            "Down with editor text belongs to the editor",
        );

        ui.editorText = "";
        focusDock(ui);
        assert.equal(ui.tui.focusedComponent, component);
    });

    it("enters focus with Super+Down while the editor holds a draft", () => {
        const { ui, ctx, registry } = createTestContext();
        registerContribution(registry, ctx.ui, "shells");
        const component = componentOf(ui);
        ui.editorText = "unfinished command";
        ui.tui.overlay = true;

        assert.equal(ui.sendInput(keys.superDown), undefined, "an overlay keeps its own input");
        assert.notEqual(ui.tui.focusedComponent, component);

        ui.tui.overlay = false;
        focusDock(ui, keys.superDown);
        assert.equal(ui.tui.focusedComponent, component);
    });

    it("never enters focus while every contribution is hidden", () => {
        const { ui, ctx, registry, editor, controller } = createTestContext();
        registerContribution(registry, ctx.ui, "shells");
        controller.configure(createControllerSettings({ hidden: ["shells"] }));
        const component = componentOf(ui);

        assert.equal(dockRowOf(component, 80).trim(), "claude-test • medium", "no cell may remain");
        assert.equal(ui.sendInput(keys.down), undefined);
        assert.equal(ui.tui.focusedComponent, editor);
    });

    it("moves the selection with Left and Right and wraps around both ends", () => {
        const { ui, ctx, registry, controller } = createTestContext();
        for (const id of ["shells", "questions", "goals"])
            registerContribution(registry, ctx.ui, id);

        const component = focusDock(ui);
        assert.equal(controller.selectedId, "shells");

        component.handleInput(keys.right);
        assert.equal(controller.selectedId, "questions");
        component.handleInput(keys.right);
        assert.equal(controller.selectedId, "goals");
        component.handleInput(keys.right);
        assert.equal(
            controller.selectedId,
            "shells",
            "Right at the end must wrap to the first item",
        );
        component.handleInput(keys.left);
        assert.equal(
            controller.selectedId,
            "goals",
            "Left at the start must wrap to the last item",
        );
        assert.equal(
            component.focused,
            true,
            "selection changes must preserve dock keyboard focus",
        );
    });

    it("jumps to the first and last contribution with Home and End", () => {
        const { ui, ctx, registry, controller } = createTestContext();
        for (const id of ["shells", "questions", "goals"])
            registerContribution(registry, ctx.ui, id);
        const component = focusDock(ui);

        component.handleInput(keys.end);
        assert.equal(controller.selectedId, "goals");
        component.handleInput(keys.home);
        assert.equal(controller.selectedId, "shells");
    });

    it("opens the selected contribution with Enter", async () => {
        const { ui, ctx, registry, controller } = createTestContext();
        const activated: string[] = [];
        for (const id of ["shells", "questions"]) {
            registerContribution(registry, ctx.ui, id, { activate: () => void activated.push(id) });
        }
        const component = focusDock(ui);

        component.handleInput(keys.right);
        assert.equal(controller.selectedId, "questions");
        component.handleInput(keys.enter);
        await settle();

        assert.deepEqual(
            activated,
            ["questions"],
            "Enter must open the selected contribution directly",
        );
    });

    it("releases dock focus while a panel is open and restores it when the panel closes", async () => {
        const { ui, ctx, registry, editor } = createTestContext();
        let closePanel!: () => void;
        const panelClosed = new Promise<void>((resolve) => {
            closePanel = resolve;
        });
        let panelOpened = false;
        registerContribution(registry, ctx.ui, "shells", {
            activate: async () => {
                ui.tui.overlay = true;
                panelOpened = true;
                await panelClosed;
                ui.tui.overlay = false;
            },
        });
        const component = focusDock(ui);

        component.handleInput(keys.enter);
        await waitFor(() => panelOpened, "open the panel");

        assert.equal(ui.tui.focusedComponent, editor, "an open panel owns the keyboard");
        assert.equal(ui.tui.overlay, true);

        closePanel();
        await waitFor(() => ui.tui.focusedComponent === component, "restore dock focus");

        assert.equal(ui.tui.overlay, false);
        assert.equal(component.focused, true);
    });

    it("consumes Up so returning to the editor cannot recall the draft", () => {
        const receivedInput: string[] = [];
        const { ui, ctx, registry, editor } = createTestContext({ receivedInput });
        registerContribution(registry, ctx.ui, "shells");
        ui.editorText = "unfinished draft";

        const component = focusDock(ui, keys.superDown);
        component.handleInput(keys.up);

        assert.equal(ui.tui.focusedComponent, editor);
        assert.equal(component.focused, false, "Up must leave the dock unfocused");
        assert.deepEqual(
            receivedInput,
            [],
            "Up must be consumed instead of reaching editor history",
        );
    });

    it("forwards printable, paste, and app-shortcut input to the editor unchanged", () => {
        const receivedInput: string[] = [];
        const { ui, ctx, registry } = createTestContext({ receivedInput });
        registerContribution(registry, ctx.ui, "shells");
        const component = focusDock(ui);
        const editorBound = ["x", keys.paste("pasted text"), keys.ctrlZ];

        for (const input of editorBound) {
            component.handleInput(input);
            assert.equal(
                component.focused,
                false,
                `${JSON.stringify(input)} must hand the keyboard back to the editor`,
            );
            focusDock(ui);
        }

        assert.deepEqual(receivedInput, editorBound, "editor-bound input must arrive unchanged");
    });

    it("leaves focus on Escape without sending Escape to the editor", () => {
        const receivedInput: string[] = [];
        const { ui, ctx, registry, editor } = createTestContext({ receivedInput });
        registerContribution(registry, ctx.ui, "shells");
        const component = focusDock(ui);

        component.handleInput(keys.escape);

        assert.equal(ui.tui.focusedComponent, editor);
        assert.equal(component.focused, false);
        assert.deepEqual(receivedInput, [], "Escape must remain a dock control key");
    });

    it("ignores key-release events instead of moving the selection or leaving focus", () => {
        const receivedInput: string[] = [];
        const { ui, ctx, registry, controller, editor } = createTestContext({ receivedInput });
        for (const id of ["shells", "questions", "goals"])
            registerContribution(registry, ctx.ui, id);

        assert.equal(
            ui.sendInput(keys.release.down),
            undefined,
            "a release must not enter the dock",
        );
        assert.equal(ui.tui.focusedComponent, editor);

        const component = focusDock(ui);
        assert.equal(controller.selectedId, "shells");

        component.handleInput(keys.release.left);
        assert.equal(controller.selectedId, "shells", "a release must not move the selection");
        component.handleInput(keys.release.printable);
        assert.equal(component.focused, true, "a release must not hand focus back to the editor");
        assert.equal(ui.tui.focusedComponent, component);
        assert.deepEqual(receivedInput, [], "a release must never reach the editor as typing");
    });

    it("selects the nearest surviving contribution when the selected one disappears", async () => {
        const { ui, ctx, registry, controller } = createTestContext();
        registerContribution(registry, ctx.ui, "first");
        const releaseSecond = registerContribution(registry, ctx.ui, "second");
        registerContribution(registry, ctx.ui, "third");
        const component = focusDock(ui);

        component.handleInput(keys.right);
        assert.equal(controller.selectedId, "second");

        releaseSecond();
        await settle();

        assert.equal(
            component.focused,
            true,
            "removing the selected item must preserve dock focus",
        );
        assert.equal(
            controller.selectedId,
            "third",
            "selection must move to the nearest surviving item",
        );
    });

    it("releases focus when the last visible contribution disappears", async () => {
        const { ui, ctx, registry, editor } = createTestContext();
        const release = registerContribution(registry, ctx.ui, "shells");
        const component = focusDock(ui);

        release();
        await settle();

        assert.equal(dockRowOf(component).trim(), "claude-test • medium", "no cell may remain");
        assert.equal(component.focused, false, "an empty dock must release keyboard focus");
        assert.equal(ui.tui.focusedComponent, editor);
    });

    it("releases focus when an unrelated overlay restores an empty dock", async () => {
        const { ui, ctx, registry, editor } = createTestContext();
        const release = registerContribution(registry, ctx.ui, "shells");
        const component = focusDock(ui);
        const overlay: Component & { focused: boolean } = {
            focused: false,
            render: () => [],
            handleInput: () => undefined,
            invalidate: () => undefined,
        };
        ui.tui.overlay = true;
        ui.tui.setFocus(overlay);

        release();
        await settle();

        assert.equal(ui.tui.getFocusedComponent(), overlay);
        assert.equal(dockRowOf(component).trim(), "claude-test • medium", "no cell may remain");

        ui.tui.overlay = false;
        ui.tui.setFocus(component);
        await settle();

        assert.equal(ui.tui.getFocusedComponent(), editor);
    });

    it("keeps navigating on the new TUI renderer after Pi migrates the dock", () => {
        const { ui, ctx, registry, editor, controller } = createTestContext();
        registerContribution(registry, ctx.ui, "shells");
        registerContribution(registry, ctx.ui, "questions");
        const oldComponent = focusDock(ui);

        const retiredTui = ui.tui;
        retiredTui.setFocus(null);
        const activeTui = new FakeTui(editor);
        activeTui.setFocus(oldComponent);
        ui.replaceTui(activeTui);

        oldComponent.handleInput(keys.right);

        const activeComponent = componentOf(ui);
        assert.notStrictEqual(
            activeComponent,
            oldComponent,
            "the active renderer must mount a fresh component",
        );
        assert.equal(activeTui.getFocusedComponent(), activeComponent);
        assert.equal(activeComponent.focused, true);
        assert.equal(
            controller.selectedId,
            "questions",
            "the migrated dock must preserve the selected contribution",
        );
    });

    it("ignores a panel continuation that started before a tree jump", async () => {
        const { ui, ctx, registry, controller, editor } = createTestContext();
        let closePanel!: () => void;
        const panelClosed = new Promise<void>((resolve) => {
            closePanel = resolve;
        });
        let panelOpened = false;
        registerContribution(registry, ctx.ui, "shells", {
            activate: async () => {
                panelOpened = true;
                await panelClosed;
            },
        });
        const component = focusDock(ui);

        component.handleInput(keys.enter);
        await waitFor(() => panelOpened, "open the panel");

        controller.resetInteraction();
        closePanel();
        await settle();

        assert.equal(
            ui.tui.getFocusedComponent(),
            editor,
            "a stale panel continuation must not recapture the new branch's focus",
        );
        assert.equal(component.focused, false);
    });

    it("reports an open failure and restores dock focus", async () => {
        const { ui, ctx, registry } = createTestContext();
        registerContribution(registry, ctx.ui, "shells", {
            activate: async () => {
                throw new Error("inspector failed");
            },
        });
        const component = focusDock(ui);

        component.handleInput(keys.enter);
        await settle();

        assert.deepEqual(ui.notifications, [
            { message: "Lune dock failed to open shells: inspector failed", type: "error" },
        ]);
        assert.equal(ui.tui.focusedComponent, component);
        assert.equal(component.focused, true);
    });

    it("keeps a hidden contribution subscribed and reveals it through settings", async () => {
        const { ui, ctx, registry, controller } = createTestContext();
        let publish!: (snapshot: LuneDockSnapshot) => void;
        registerContribution(registry, ctx.ui, "hidden", {
            snapshot: () => textSnapshot("old"),
            subscribe: (listener) => {
                publish = listener;
                return () => {};
            },
        });
        registerContribution(registry, ctx.ui, "other");
        controller.configure(
            createControllerSettings({
                displayMode: "full",
                hidden: ["hidden"],
                order: { hidden: -1 },
            }),
        );

        publish({
            base: textComponent("new base"),
            detail: textComponent("new detail"),
            full: textComponent("new full"),
        });
        await settle();
        assert.deepEqual(
            controller.items.map(({ id }) => id),
            ["other"],
            "a hidden contribution must stay out of the row",
        );

        controller.configure(
            createControllerSettings({ displayMode: "full", hidden: [], order: { hidden: -1 } }),
        );

        assert.deepEqual(
            controller.items.map(({ id }) => id),
            ["hidden", "other"],
            "settings order must place the revealed contribution first",
        );
        assert.match(dockRowOf(componentOf(ui), 80), /new full/);
    });

    it("invalidates every snapshot level of every provider, including hidden ones", () => {
        const { ui, ctx, registry, controller } = createTestContext();
        let invalidations = 0;
        const level = (text: string) => ({
            ...textComponent(text),
            invalidate() {
                invalidations++;
            },
        });
        registerContribution(registry, ctx.ui, "shells", {
            snapshot: () => ({
                base: level("base"),
                detail: level("detail"),
                full: level("full"),
            }),
        });
        registerContribution(registry, ctx.ui, "questions", {
            snapshot: () => ({ base: level("question") }),
        });
        controller.configure(
            createControllerSettings({
                displayMode: "full",
                hidden: ["questions"],
                order: { questions: 1 },
            }),
        );

        componentOf(ui).invalidate();

        assert.equal(invalidations, 4, "every level of every provider must be invalidated once");
    });

    it("activates the selected contribution without sending input to snapshots", async () => {
        const { ui, ctx, registry, controller } = createTestContext();
        const activated: string[] = [];
        let forwarded = 0;
        for (const id of ["shells", "questions"]) {
            registerContribution(registry, ctx.ui, id, {
                snapshot: () => ({
                    base: {
                        ...textComponent(id),
                        handleInput() {
                            forwarded++;
                        },
                    },
                }),
                activate: () => void activated.push(id),
            });
        }
        const component = focusDock(ui);

        component.handleInput(keys.right);
        assert.equal(controller.selectedId, "questions");
        component.handleInput(keys.enter);
        await settle();

        assert.deepEqual(activated, ["questions"]);
        assert.equal(forwarded, 0, "snapshot components never receive dock input");
    });

    it("unsubscribes terminal input and clears host state on detach", () => {
        const { ui, ctx, controller, registry } = createTestContext();

        controller.detach();

        assert.equal(ui.inputUnsubscribed, true);
        assert.equal(ui.sendInput(keys.down), undefined);
        assert.equal(registry.hasHost(ctx.ui), false);
        assert.deepEqual(controller.items, []);
        assert.equal(controller.selectedId, undefined);
        assert.equal(ui.widgetCalls.at(-1)?.key, WIDGET_ID);
        assert.equal(ui.widgetCalls.at(-1)?.content, undefined);
    });
});

describe("dock controller footer", () => {
    it("mounts its footer before the widget and before the host is announced", () => {
        const ui = new FakeDockUi(createMainEditor());
        const registry = createDockRegistry();
        const { ctx } = createSessionContext({ ui });
        const controller = new DockController(
            registry,
            new DockStatusSource(createCompactionReader().read),
        );
        const stateWhenMounting: { widgets: number; host: boolean }[] = [];
        const mountFooter = ui.setFooter.bind(ui);
        ui.setFooter = (factory) => {
            stateWhenMounting.push({ widgets: ui.widgetCalls.length, host: registry.hasHost(ui) });
            mountFooter(factory);
        };

        controller.attach(ctx);

        assert.deepEqual(stateWhenMounting, [{ widgets: 0, host: false }]);
        assert.equal(registry.hasHost(ui), true);
    });

    it("hands Pi a blank footer, because the dock widget draws every row", () => {
        const { ui } = createTestContext();

        assert.ok(ui.footer, "the dock must install a footer to replace Pi's");
        assert.deepEqual(ui.footer.render(100), []);
    });

    it("reads the model, directory, usage and extension statuses from Pi on every frame", () => {
        const { ui, session, compaction } = createTestContext();
        compaction.enabled = true;
        session.model = createModel({ provider: "openai", id: "gpt-test", reasoning: false });
        session.contextUsage = { tokens: 80_000, contextWindow: 200_000, percent: 40 };
        session.sessionManager.appendMessage(
            assistantMessage(createUsage({ input: 1500, output: 20, cost: 0.5 })),
        );
        ui.footerData.providerCount = 2;
        ui.footerData.branch = "feature";
        ui.footerData.statuses.set("lint", "3 warnings");
        const component = componentOf(ui);

        const first = component.render(120).map(stripTerminalSequences);

        assert.match(first[1]!, /\(openai\) gpt-test$/);
        assert.match(first[3]!, /\/work\/project .*\(feature\)/);
        assert.match(
            first[3]!,
            / │ ↑1\.5k ↓20 {3}│ \$0\.500 {2}│ {2}80k\/200k · 40\.0% │ \(auto\)$/,
        );
        assert.equal(first[4], " 3 warnings");

        session.sessionManager.appendMessage(
            assistantMessage(createUsage({ input: 500, cost: 0.25 })),
        );
        ui.footerData.branch = "main";
        ui.footerData.statuses.clear();
        const second = component.render(120).map(stripTerminalSequences);

        assert.match(second[3]!, /\(main\)/);
        assert.match(second[3]!, / │ ↑2\.0k ↓20 {3}│ \$0\.750 {2}│ /);
        assert.equal(second.length, 5, "a cleared status must remove its row");
    });

    it("draws the key hints on the rule only while the dock has focus", () => {
        const { ui, ctx, registry } = createTestContext();
        registerContribution(registry, ctx.ui, "shells");
        const component = componentOf(ui);
        const ruleUnderCells = () => stripTerminalSequences(component.render(120)[2]!);
        assert.doesNotMatch(ruleUnderCells(), /enter open/);

        focusDock(ui);
        assert.match(ruleUnderCells(), /←→ select · enter open · esc back/);

        component.handleInput(keys.escape);
        assert.doesNotMatch(ruleUnderCells(), /enter open/);
    });

    it("restores Pi's footer on detach", () => {
        const { ui, controller } = createTestContext();

        controller.detach();

        assert.equal(ui.footerCalls.length, 2, "one install and one restore");
        assert.equal(ui.footerCalls.at(-1), undefined);
        assert.equal(ui.footer, undefined);
    });

    it("leaves a footer that another extension installed in place on detach", () => {
        const { ui, controller } = createTestContext();
        const foreign: Component = { render: () => ["foreign footer"], invalidate() {} };
        ui.setFooter(() => foreign);

        controller.detach();

        assert.equal(ui.footer, foreign, "detach must not evict the other extension's footer");
        assert.equal(ui.footerCalls.includes(undefined), false, "Pi's footer must not be restored");
    });

    it("installs its footer again on attach after another extension replaced it", () => {
        const { ui, ctx, controller } = createTestContext();
        ui.setFooter(() => ({ render: () => ["foreign footer"], invalidate() {} }));

        controller.attach(ctx);

        assert.deepEqual(ui.footer?.render(80), []);
        assert.equal(ui.footerCalls.includes(undefined), false);
    });

    it("requests a render when the git branch changes", () => {
        const { ui } = createTestContext();
        const before = ui.tui.renderRequests;

        ui.footerData.fireBranchChange();

        assert.equal(ui.tui.renderRequests, before + 1);
    });

    it("stops watching the git branch once detached", () => {
        const { ui, controller } = createTestContext();
        controller.detach();
        const before = ui.tui.renderRequests;

        ui.footerData.fireBranchChange();

        assert.equal(ui.tui.renderRequests, before);
        assert.equal(ui.footerData.branchSubscriptions, 0);
    });

    it("stops watching the git branch once another extension replaces the footer", () => {
        const { ui } = createTestContext();

        ui.setFooter(() => ({ render: () => [], invalidate() {} }));

        assert.equal(ui.footerData.branchSubscriptions, 0);
    });

    it("renders no rows after detach, even from a component Pi still holds", () => {
        const { ui, controller } = createTestContext();
        const component = componentOf(ui);
        assert.equal(component.render(100).length, 5);

        controller.detach();

        assert.deepEqual(component.render(100), []);
    });
});

describe("dock controller settings", () => {
    function itemIds(controller: DockController): string[] {
        return controller.items.map(({ id }) => id);
    }

    it("leaves out hidden contributions and ignores hidden ids that are not registered", () => {
        const { ctx, registry, controller } = createTestContext();
        for (const id of ["shells", "questions", "goals"])
            registerContribution(registry, ctx.ui, id);

        controller.configure(createControllerSettings({ hidden: ["questions", "unregistered"] }));

        assert.deepEqual(itemIds(controller), ["shells", "goals"]);
    });

    it("orders contributions by ascending position, counting a missing position as zero", () => {
        const { ctx, registry, controller } = createTestContext();
        for (const id of ["late", "plain", "early", "later"])
            registerContribution(registry, ctx.ui, id);

        controller.configure(createControllerSettings({ order: { late: 5, later: 9, early: -3 } }));

        assert.deepEqual(itemIds(controller), ["early", "plain", "late", "later"]);
    });

    it("keeps registration order between contributions with the same position", () => {
        const { ctx, registry, controller } = createTestContext();
        for (const id of ["a", "b", "c", "d"]) registerContribution(registry, ctx.ui, id);

        controller.configure(createControllerSettings({ order: { c: 1, a: 1 } }));

        assert.deepEqual(itemIds(controller), ["b", "d", "a", "c"]);
    });

    it("applies a changed order and visibility to a dock that is already showing", async () => {
        const { ui, ctx, registry, controller } = createTestContext();
        for (const id of ["first", "second"]) registerContribution(registry, ctx.ui, id);
        await settle();
        assert.match(dockRowOf(componentOf(ui)), /^ first │ second/);

        controller.configure(createControllerSettings({ order: { first: 1 } }));
        assert.match(dockRowOf(componentOf(ui)), /^ second │ first/);

        controller.configure(createControllerSettings({ hidden: ["second"] }));
        assert.match(dockRowOf(componentOf(ui)), /^ first +│/);
        assert.doesNotMatch(dockRowOf(componentOf(ui)), /second/);
    });

    it("draws the level that matches the presentation setting", () => {
        const { ui, ctx, registry, controller } = createTestContext();
        registerContribution(registry, ctx.ui, "shells", {
            snapshot: () => ({
                base: textComponent("base"),
                detail: textComponent("detail"),
                full: textComponent("full"),
            }),
        });

        const rows = (["base", "detail", "full"] as const).map((displayMode) => {
            controller.configure(createControllerSettings({ displayMode }));
            return dockRowOf(componentOf(ui)).trimStart().split(" ")[0];
        });

        assert.deepEqual(rows, ["base", "detail", "full"]);
    });

    it("draws the model only while the setting shows it", () => {
        const { ui, controller } = createTestContext();
        assert.match(dockRowOf(componentOf(ui)), /claude-test/);

        controller.configure(createControllerSettings({ showModel: false }));
        assert.doesNotMatch(dockRowOf(componentOf(ui)), /claude-test/);

        controller.configure(createControllerSettings({ showModel: true }));
        assert.match(dockRowOf(componentOf(ui)), /claude-test/);
    });

    it("draws each style's frame", () => {
        const { ui, ctx, registry, controller } = createTestContext();
        registerContribution(registry, ctx.ui, "shells");
        const render = (style: (typeof DOCK_STYLES)[number]) => {
            controller.configure(createControllerSettings({ style }));
            return componentOf(ui).render(80).map(stripTerminalSequences);
        };

        const ruled = render("ruled");
        const boxed = render("boxed");
        const compact = render("compact");
        const minimal = render("minimal");
        const classic = render("classic");

        assert.equal(ruled.length, 5);
        assert.match(boxed[0]!, /^╭─+╮$/);
        assert.equal(compact.length, 2);
        assert.equal(minimal.length, 1);
        assert.deepEqual(
            classic.map((line) => line.trim()),
            ["shells"],
        );
    });

    it("advertises the key hints in every style while the dock has focus", () => {
        for (const style of DOCK_STYLES) {
            const { ui, ctx, registry } = createTestContext({ settings: { style } });
            registerContribution(registry, ctx.ui, "shells");
            const component = componentOf(ui);
            const text = () => component.render(120).map(stripTerminalSequences).join("\n");
            assert.doesNotMatch(text(), /enter open/, `${style} unfocused`);

            focusDock(ui);
            assert.match(text(), /enter open · esc back/, `${style} focused`);

            component.handleInput(keys.escape);
            assert.doesNotMatch(text(), /enter open/, `${style} after Escape`);
        }
    });
});

describe("dock controller footer ownership by style", () => {
    function foreignFooter(label = "foreign footer") {
        return () => ({ render: () => [label], invalidate() {} });
    }

    it("installs no footer under the classic style, so Pi's own footer stays", () => {
        const { ui, controller } = createTestContext({ settings: { style: "classic" } });

        assert.equal(ui.footerCalls.length, 0);
        assert.equal(ui.footerData.branchSubscriptions, 0);
        controller.detach();
        assert.equal(ui.footerCalls.length, 0, "detach has nothing to restore");
    });

    it("renders the classic style without any footer data", async () => {
        const { ui, ctx, registry, controller } = createTestContext({
            settings: { style: "classic" },
        });
        registerContribution(registry, ctx.ui, "shells");
        await settle();

        assert.equal(controller.collectStatus(), undefined);
        assert.deepEqual(componentOf(ui).render(80).map(stripTerminalSequences), [" shells"]);
    });

    it("renders no rows after detach in the classic style either", () => {
        const { ui, ctx, registry, controller } = createTestContext({
            settings: { style: "classic" },
        });
        registerContribution(registry, ctx.ui, "shells");
        const component = componentOf(ui);

        controller.detach();

        assert.deepEqual(component.render(80), []);
    });

    it("hands Pi's footer back when the style switches to classic", () => {
        const { ui, controller } = createTestContext();
        assert.ok(ui.footer);

        controller.configure(createControllerSettings({ style: "classic" }));

        assert.equal(ui.footer, undefined);
        assert.equal(ui.footerCalls.at(-1), undefined);
        assert.equal(ui.footerData.branchSubscriptions, 0);
    });

    it("takes the footer over when the style switches away from classic", () => {
        const { ui, ctx, registry, controller } = createTestContext({
            settings: { style: "classic" },
        });
        registerContribution(registry, ctx.ui, "shells");

        controller.configure(createControllerSettings({ style: "ruled" }));

        assert.deepEqual(ui.footer?.render(80), []);
        assert.equal(componentOf(ui).render(80).length, 5);
        const before = ui.tui.renderRequests;
        ui.footerData.fireBranchChange();
        assert.equal(ui.tui.renderRequests, before + 1, "the branch is watched again");
    });

    it("does not touch the footer when switching between styles that both replace it", () => {
        const { ui, controller } = createTestContext();
        const calls = ui.footerCalls.length;

        for (const style of ["boxed", "compact", "minimal", "ruled"] as const) {
            controller.configure(createControllerSettings({ style }));
        }

        assert.equal(ui.footerCalls.length, calls);
    });

    it("does not reclaim a footer another extension installed when an unrelated setting changes", () => {
        const { ui, controller } = createTestContext();
        const foreign = foreignFooter();
        ui.setFooter(foreign);
        const installed = ui.footer;

        controller.configure(createControllerSettings({ showModel: false, displayMode: "full" }));
        controller.configure(createControllerSettings({ style: "boxed" }));

        assert.equal(ui.footer, installed, "the other extension's footer must stay");
        assert.deepEqual(ui.footerCalls, [ui.footerCalls[0], foreign]);
    });

    it("does not evict a foreign footer when the style switches to classic", () => {
        const { ui, controller } = createTestContext();
        ui.setFooter(foreignFooter());
        const installed = ui.footer;

        controller.configure(createControllerSettings({ style: "classic" }));

        assert.equal(ui.footer, installed);
        assert.equal(ui.footerCalls.includes(undefined), false);
    });

    it("claims the footer again when the style switches back to one that replaces it", () => {
        const { ui, controller } = createTestContext();
        ui.setFooter(foreignFooter());
        controller.configure(createControllerSettings({ style: "classic" }));

        controller.configure(createControllerSettings({ style: "compact" }));

        assert.deepEqual(ui.footer?.render(80), []);
        assert.equal(ui.footerCalls.length, 3, "dock footer, foreign footer, dock footer");
    });

    it("keeps the footer data it needs after the style round trip", () => {
        const { ui, controller } = createTestContext();
        controller.configure(createControllerSettings({ style: "classic" }));
        controller.configure(createControllerSettings({ style: "ruled" }));
        ui.footerData.branch = "feature";

        const info = componentOf(ui).render(120).map(stripTerminalSequences)[3];

        assert.match(info!, /\(feature\)/);
    });
});
