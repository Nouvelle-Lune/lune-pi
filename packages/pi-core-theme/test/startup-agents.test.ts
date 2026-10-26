import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createEventBus,
    keyText,
    SessionManager,
    VERSION,
    type EventBus,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { installStartupAgents } from "../src/startup-agents.ts";
import { createThemeExtension } from "../src/extension.ts";
import { createSettingsFixture } from "./harness/settings.ts";

const AGENTS_CHANNEL = "lune-subagent:agents-loaded";

/** `styled` wraps every styled span as `<color:text>`, so a test can see the colour token. */
function fakeTheme(styled = false): Theme {
    return {
        fg: (color: string, text: string) => (styled ? `<${color}:${text}>` : text),
    } as unknown as Theme;
}

interface ModeOptions {
    /** Pi's `shouldShowStartupDetails()`; false is a quiet startup. */
    details?: boolean;
    /** Pi's `getStartupExpansionState()` for the first listing. */
    expanded?: boolean;
}

function fakeMode({ details = true, expanded = false }: ModeOptions = {}) {
    const children: Component[] = [];
    const native: Component = { render: () => ["[Context]", "native context"], invalidate() {} };
    const state = { expanded, renders: 0, removed: 0 };
    class InteractiveMode {
        loadedResourcesContainer = {
            addChild(component: Component) {
                children.push(component);
            },
            removeChild(component: Component) {
                const index = children.indexOf(component);
                if (index === -1) return;
                state.removed += 1;
                children.splice(index, 1);
            },
            clear() {
                children.splice(0, children.length);
            },
        };
        ui = { requestRender: () => (state.renders += 1) };
        showLoadedResources(options?: { force?: boolean }) {
            this.loadedResourcesContainer.clear();
            if (options?.force || this.shouldShowStartupDetails()) children.push(native);
        }
        shouldShowStartupDetails() {
            return details;
        }
        getStartupExpansionState() {
            return state.expanded;
        }
    }
    return { InteractiveMode, children, native, state };
}

function install(
    mode: ReturnType<typeof fakeMode>,
    { theme, events = createEventBus() }: { theme?: Theme; events?: EventBus } = {},
) {
    const subscription = installStartupAgents({
        interactiveMode: mode.InteractiveMode,
        events,
        getTheme: () => theme,
    });
    return { events, subscription };
}

type ExpandableSection = Component & { setExpanded(expanded: boolean): void };

/** Text pads lines to the terminal width; the trailing padding is not part of the content. */
function visibleLines(component: Component, width = 80): string[] {
    return component.render(width).map((line) => line.trimEnd());
}

test("appends the loaded agent names after Pi's native resource list", () => {
    const mode = fakeMode();
    const { events } = install(mode, { theme: fakeTheme(true) });
    events.emit(AGENTS_CHANNEL, ["alpha", "reviewer"]);

    new mode.InteractiveMode().showLoadedResources();

    assert.equal(mode.children.length, 2);
    assert.equal(mode.children[0], mode.native);
    const actual = visibleLines(mode.children[1]!);
    const expected = ["<mdHeading:[Agents]>", "<dim:  alpha, reviewer>", ""];
    assert.deepEqual(actual, expected);
});

test("shows no list without names or with the theme disabled", () => {
    const empty = fakeMode();
    install(empty, { theme: fakeTheme() });
    new empty.InteractiveMode().showLoadedResources();
    assert.equal(empty.children[0], empty.native);
    assert.deepEqual(
        empty.children.slice(1).flatMap((child) => child.render(80)),
        [],
    );

    const disabled = fakeMode();
    const { events } = install(disabled, { theme: undefined });
    events.emit(AGENTS_CHANNEL, ["alpha"]);
    new disabled.InteractiveMode().showLoadedResources();
    assert.equal(disabled.children[0], disabled.native);
    assert.deepEqual(
        disabled.children.slice(1).flatMap((child) => child.render(80)),
        [],
    );
});

test("quiet startup keeps the list hidden unless Pi forces the listing", () => {
    const mode = fakeMode({ details: false });
    const { events } = install(mode, { theme: fakeTheme() });
    events.emit(AGENTS_CHANNEL, ["alpha"]);
    const session = new mode.InteractiveMode();

    session.showLoadedResources();
    assert.deepEqual(
        mode.children.flatMap((child) => child.render(80)),
        [],
    );

    session.showLoadedResources({ force: true });
    assert.equal(mode.children.length, 2);
    assert.equal(mode.children[0], mode.native);
    const actual = visibleLines(mode.children[1]!);
    const expected = ["[Agents]", "  alpha", ""];
    assert.deepEqual(actual, expected);
});

test("expansion state renders one name per line and Pi's toggle collapses the list", () => {
    const mode = fakeMode({ expanded: true });
    const { events } = install(mode, { theme: fakeTheme() });
    events.emit(AGENTS_CHANNEL, ["alpha", "reviewer"]);
    new mode.InteractiveMode().showLoadedResources();
    const section = mode.children[1]! as ExpandableSection;

    const expanded = visibleLines(section);
    const expectedExpanded = ["[Agents]", "  alpha", "  reviewer", ""];
    assert.deepEqual(expanded, expectedExpanded);

    // Pi applies its tool-output toggle to the mounted children without rebuilding the list.
    section.setExpanded(false);
    const collapsed = visibleLines(section);
    const expectedCollapsed = ["[Agents]", "  alpha, reviewer", ""];
    assert.deepEqual(collapsed, expectedCollapsed);
});

test("long name lists wrap within the terminal width", () => {
    const mode = fakeMode();
    const { events } = install(mode, { theme: fakeTheme() });
    const names = ["alpha", "bravo", "charlie", "delta", "echo"];
    events.emit(AGENTS_CHANNEL, names);
    new mode.InteractiveMode().showLoadedResources();

    const lines = mode.children[1]!.render(24);

    for (const line of lines) assert.ok(visibleWidth(line) <= 24, line);
    assert.ok(lines.length > 3, "the list must wrap instead of overflowing");
    const text = lines.join("\n");
    assert.match(text, /\[Agents\]/);
    for (const name of names) assert.match(text, new RegExp(name));
});

test("disposal restores Pi's method, removes the mounted section and stops listening", () => {
    const mode = fakeMode();
    const original = mode.InteractiveMode.prototype.showLoadedResources;
    const { events, subscription } = install(mode, { theme: fakeTheme() });
    events.emit(AGENTS_CHANNEL, ["alpha"]);
    const session = new mode.InteractiveMode();
    session.showLoadedResources();
    assert.notStrictEqual(mode.InteractiveMode.prototype.showLoadedResources, original);

    subscription.dispose();

    assert.strictEqual(mode.InteractiveMode.prototype.showLoadedResources, original);
    assert.deepEqual(mode.children, [mode.native]);
    assert.equal(mode.state.removed, 1);
    assert.equal(mode.state.renders, 1);

    events.emit(AGENTS_CHANNEL, ["beta"]);
    session.showLoadedResources();
    assert.deepEqual(mode.children, [mode.native]);
    assert.equal(mode.state.renders, 1);
});

type Handler = (event: unknown, context: ExtensionContext) => unknown;

test("the theme factory listens before session_start and lists the session's theme agents", async (t) => {
    const files = await createSettingsFixture(t);
    await files.writeScope("global", { enabled: true, mode: "off", showStartupHeader: false });
    const mode = fakeMode();
    const events = createEventBus();
    const handlers = new Map<string, Set<Handler>>();
    const pi = {
        events,
        on(name: string, handler: Handler) {
            const listeners = handlers.get(name) ?? new Set<Handler>();
            handlers.set(name, listeners);
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        registerCommand() {},
    } as unknown as ExtensionAPI;
    const ctx = {
        cwd: files.cwd,
        mode: "tui",
        hasUI: true,
        isProjectTrusted: () => true,
        sessionManager: SessionManager.inMemory(files.cwd),
        ui: {
            theme: fakeTheme(true),
            notify() {},
            setHeader() {},
            setTheme: () => ({ success: true }),
            setWidget() {},
        },
    } as unknown as ExtensionContext;
    const emit = async (name: string) => {
        for (const handler of [...(handlers.get(name) ?? [])]) await handler({ type: name }, ctx);
    };

    await createThemeExtension({
        piVersion: VERSION,
        keyText,
        interactiveMode: mode.InteractiveMode,
    })(pi);

    // Lune Subagent publishes during its own session_start, so factory-time subscription covers
    // either extension load order.
    events.emit(AGENTS_CHANNEL, ["alpha", "reviewer"]);
    await emit("session_start");
    new mode.InteractiveMode().showLoadedResources();

    assert.equal(mode.children.length, 2);
    const actual = visibleLines(mode.children[1]!);
    const expected = ["<mdHeading:[Agents]>", "<dim:  alpha, reviewer>", ""];
    assert.deepEqual(actual, expected);

    await emit("session_shutdown");

    assert.deepEqual(mode.children, [mode.native]);
    assert.equal(mode.state.removed, 1);
});
