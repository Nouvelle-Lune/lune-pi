import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
    keyText,
    SessionManager,
    VERSION,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsPanelRegistry } from "@lune_99/pi-lune-extensions-core/panel/host";
import { createThemeExtension } from "../src/extension.ts";
import { setTerminalColors } from "../src/terminal-background.ts";
import { installSessionHandoff } from "../src/session-handoff.ts";
import { createSettingsFixture } from "./harness/settings.ts";
import { getThemeByName } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

const RESET = "\x1b]111\x07\x1b]110\x07";
const LIGHT_PAINT = "\x1b]11;#f5f8fd\x07\x1b]10;#1a2332\x07";
type Handler = (event: unknown, context: ExtensionContext) => unknown;
type WidgetFactory = (tui: { terminal: { write(data: string): void } }, theme: Theme) => unknown;

async function fixture(t: TestContext) {
    const files = await createSettingsFixture(t);
    // Tool rendering is irrelevant here and needs a much larger UI surface.
    await files.writeScope("global", { enabled: true, mode: "off" });
    const writes: string[] = [];
    const terminal = { write: (data: string) => void writes.push(data) };
    const widgets = new Map<string, WidgetFactory>();
    let current = getThemeByName("dark")!;
    const ui = {
        get theme() {
            return current;
        },
        getTheme: (name: string) => getThemeByName(name),
        setTheme(next: Theme) {
            current = next;
            return { success: true };
        },
        setHeader() {},
        notify() {},
        setWidget(key: string, factory?: WidgetFactory) {
            // Pi calls widget factories synchronously with its TUI.
            if (factory) {
                widgets.set(key, factory);
                factory({ terminal }, current);
            } else widgets.delete(key);
        },
    };
    const ctx = {
        cwd: files.cwd,
        mode: "tui",
        hasUI: true,
        isProjectTrusted: () => true,
        sessionManager: SessionManager.inMemory(files.cwd),
        ui,
    } as unknown as ExtensionContext;
    const handlers = new Map<string, Set<Handler>>();
    const pi = {
        on(name: string, handler: Handler) {
            const set = handlers.get(name) ?? new Set<Handler>();
            handlers.set(name, set);
            set.add(handler);
            return () => set.delete(handler);
        },
        registerCommand() {},
    } as unknown as ExtensionAPI;
    const emit = async (name: string) => {
        for (const handler of [...(handlers.get(name) ?? [])]) await handler({ type: name }, ctx);
    };
    await createThemeExtension({ piVersion: VERSION, keyText })(pi);
    t.after(async () => {
        await emit("session_shutdown");
        setTerminalColors(undefined);
    });
    const field = (label: string) =>
        getSettingsPanelRegistry()
            .getSections(ctx.ui)
            .find(({ id }) => id === "core-theme")!
            .fields.find((f) => f.label === label)!;
    return { ...files, writes, widgets, emit, field, ui };
}

test("an enabled light palette paints the terminal with its background and text colors", async (t) => {
    const runtime = await fixture(t);
    await runtime.writeScope("global", {
        enabled: true,
        mode: "off",
        palette: "pi-core-light",
        paletteBackground: true,
    });
    await runtime.emit("session_start");
    assert.equal(runtime.ui.theme.name, "pi-core-light");
    assert.deepEqual(runtime.writes, [LIGHT_PAINT]);
});

test("switching to inherit resets the terminal and switching back paints again", async (t) => {
    const runtime = await fixture(t);
    await runtime.writeScope("global", {
        enabled: true,
        mode: "off",
        palette: "pi-core-light",
        paletteBackground: true,
    });
    await runtime.emit("session_start");
    await runtime.field("Style · Color palette").set("inherit", "global");
    assert.deepEqual(runtime.writes, [LIGHT_PAINT, RESET]);
    await runtime.field("Style · Color palette").set("pi-core-light", "global");
    assert.deepEqual(runtime.writes, [LIGHT_PAINT, RESET, LIGHT_PAINT]);
});

test("turning paletteBackground off resets the terminal while the palette stays applied", async (t) => {
    const runtime = await fixture(t);
    await runtime.writeScope("global", {
        enabled: true,
        mode: "off",
        palette: "pi-core-light",
        paletteBackground: true,
    });
    await runtime.emit("session_start");
    await runtime.field("Style · Palette background").set(false, "global");
    assert.deepEqual(runtime.writes, [LIGHT_PAINT, RESET]);
    assert.equal(runtime.ui.theme.name, "pi-core-light");
});

test("paletteBackground off never paints the terminal", async (t) => {
    const runtime = await fixture(t);
    await runtime.writeScope("global", {
        enabled: true,
        mode: "off",
        palette: "pi-core-light",
        paletteBackground: false,
    });
    await runtime.emit("session_start");
    assert.equal(runtime.ui.theme.name, "pi-core-light");
    assert.deepEqual(runtime.writes, []);
});

test("an unset paletteBackground defaults to off and never paints the terminal", async (t) => {
    const runtime = await fixture(t);
    await runtime.writeScope("global", { enabled: true, mode: "off", palette: "pi-core-light" });
    await runtime.emit("session_start");
    assert.equal(runtime.ui.theme.name, "pi-core-light");
    assert.deepEqual(runtime.writes, []);
});

test("disabling Core resets the terminal", async (t) => {
    const runtime = await fixture(t);
    await runtime.writeScope("global", {
        enabled: true,
        mode: "off",
        palette: "pi-core-light",
        paletteBackground: true,
    });
    await runtime.emit("session_start");
    await runtime.field("Core theme").set(false, "global");
    assert.deepEqual(runtime.writes, [LIGHT_PAINT, RESET]);
});

test("shutdown without a successor resets the terminal", async (t) => {
    const runtime = await fixture(t);
    await runtime.writeScope("global", {
        enabled: true,
        mode: "off",
        palette: "pi-core-light",
        paletteBackground: true,
    });
    await runtime.emit("session_start");
    await runtime.emit("session_shutdown");
    assert.deepEqual(runtime.writes, [LIGHT_PAINT, RESET]);
});

test("inherit never touches the terminal", async (t) => {
    const runtime = await fixture(t);
    await runtime.emit("session_start");
    assert.deepEqual(runtime.writes, []);
});

test("a replacement that no successor claims restores the native theme and terminal colors", () => {
    class FakeMode {
        themeController = { setThemeInstance: (theme: unknown) => void applied.push(theme) };
        resetExtensionUI() {}
        async rebindCurrentSession() {}
        handleReloadCommand() {}
    }
    const applied: unknown[] = [];
    const handoff = installSessionHandoff(FakeMode);
    const writes: string[] = [];
    setTerminalColors(
        { write: (data) => void writes.push(data) },
        { background: "#f5f8fd", foreground: "#1a2332" },
    );
    const native = getThemeByName("dark")!;
    handoff.track({ palette: { name: "pi-core-light", applied: native, native } });
    handoff.leave("reload");
    const mode = new FakeMode();
    return mode.rebindCurrentSession().then(() => {
        assert.deepEqual(applied, [native]);
        assert.deepEqual(writes, [LIGHT_PAINT, RESET]);
    });
});
