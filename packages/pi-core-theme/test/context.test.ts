import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
    initTheme,
    SessionManager,
    type ContextUsage,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { getThemeByName } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import registerContext from "../src/feature/context.ts";

test("the registered context command routes native fullscreen keys, category clicks, wheel events and Escape to its browser", async (t) => {
    // Native overlay dispatch catches coordinate and key-routing regressions that direct component calls miss.
    initTheme("dark");
    const theme = getThemeByName("dark")!;
    let input: (data: string) => void;
    const terminal: Terminal = {
        columns: 120,
        rows: 32,
        kittyProtocolActive: false,
        start(onInput) {
            input = onInput;
        },
        stop() {},
        drainInput: async () => {},
        write() {},
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
        setProgramStatus() {},
    };
    const tui = new TuiAltScreen(terminal);
    tui.start();
    t.after(() => tui.stop());
    let component: Component | undefined;
    let activeOverlay: ReturnType<TuiAltScreen["showOverlay"]> | undefined;
    let close: (() => void) | undefined;
    t.after(() => close?.());
    const notices: string[] = [];
    let opened: () => void;
    const ready = new Promise<void>((resolve) => {
        opened = resolve;
    });
    const ui = {
        theme,
        notify(message: string) {
            notices.push(message);
        },
        custom(
            factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
            options?: Parameters<ExtensionContext["ui"]["custom"]>[1],
        ) {
            return new Promise<void>((resolve) => {
                component = factory(tui, theme, {} as never, () => close?.()) as Component;
                const overlay = tui.showOverlay(
                    component,
                    typeof options?.overlayOptions === "function"
                        ? options.overlayOptions()
                        : options?.overlayOptions,
                );
                activeOverlay = overlay;
                close = () => {
                    overlay.hide();
                    component = undefined;
                    close = undefined;
                    resolve();
                };
                opened();
            });
        },
    };
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    registerContext(
        {
            registerCommand(name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) {
                assert.equal(name, "context");
                command = options;
            },
        } as unknown as ExtensionAPI,
        async () => true,
    );
    const prompt = Array.from(
        { length: 100 },
        (_, index) => `system-line-${index} ${"x".repeat(240)}`,
    ).join("\n");
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
        role: "system",
        content: prompt,
        sections: { project_context: "## /project/AGENTS.md\n\nproject-memory-content" },
        timestamp: 0,
    });
    const context = {
        mode: "tui",
        ui,
        getContextUsage: () => ({ tokens: 1024, contextWindow: 128000, percent: 0.8 }),
        sessionManager,
    } as unknown as ExtensionCommandContext;
    assert.ok(command);
    const completed = command.handler("", context);
    await ready;
    const screen = () => {
        tui.renderNow();
        return tui.getScreenLines().map(stripVTControlCharacters);
    };
    assert.match(screen().join("\n"), /LUNE · Context[\s\S]*1\.0k \/ 128k tokens/);
    assert.equal(activeOverlay!.getBounds()!.width, 100);
    assert.equal(activeOverlay!.getBounds()!.height, 24);
    input!("\x1b[B");
    assert.match(screen().join("\n"), /› ● System prompt/);
    assert.match(screen().join("\n"), /system-line-0/);
    const beforeIgnoredKeys = screen();
    for (const key of ["\t", "\x1b[Z", "\x1b[C", "\x1b[D"]) input!(key);
    assert.deepEqual(screen(), beforeIgnoredKeys);
    input!("\x1b[H");
    input!("\x1b[F");
    assert.match(screen().join("\n"), /system-line-99/);
    input!("\x1b[H");
    const beforeWheel = screen();
    const contentRow = beforeWheel.findIndex((line) => line.includes("system-line-0"));
    const contentColumn = beforeWheel[contentRow]!.indexOf("system-line-0");
    input!(`\x1b[<65;${contentColumn + 1};${contentRow + 1}M`);
    const afterWheel = screen();
    assert.ok(
        afterWheel.some((line) => /System prompt.*est\. · 2–/.test(line)),
        "The right-pane wheel advances one visual row without changing category",
    );
    const memoryScreen = screen();
    const memoryRow = memoryScreen.findIndex((line) => line.includes("Memory"));
    const memoryColumn = memoryScreen[memoryRow]!.indexOf("Memory");
    input!(`\x1b[<0;${memoryColumn + 1};${memoryRow + 1}M`);
    input!(`\x1b[<0;${memoryColumn + 1};${memoryRow + 1}m`);
    assert.match(screen().join("\n"), /› ● Memory/);
    assert.match(screen().join("\n"), /project-memory-content/);
    input!(`\x1b[<64;${memoryColumn + 1};${memoryRow + 1}M`);
    assert.match(screen().join("\n"), /› ● System prompt/);
    input!(`\x1b[<65;${memoryColumn + 1};${memoryRow + 1}M`);
    assert.match(screen().join("\n"), /› ● Memory/);
    input!("\x1b");
    await completed;
    assert.equal(component, undefined);
    assert.deepEqual(notices, []);
});

for (const scenario of [
    {
        name: "known usage",
        usage: { tokens: 1234, contextWindow: 8000, percent: 15.4 },
        total: "1,234",
        share: "15.4%",
        remaining: "6,766",
    },
    {
        name: "zero usage",
        usage: { tokens: 0, contextWindow: 8000, percent: 0 },
        total: "0",
        share: "0.0%",
        remaining: "8,000",
    },
    {
        name: "unknown usage",
        usage: { tokens: null, contextWindow: 8000, percent: null },
        total: "unknown",
        share: "unknown",
        remaining: "unknown",
    },
    {
        name: "unknown percentage",
        usage: { tokens: 1234, contextWindow: 8000, percent: null },
        total: "1,234",
        share: "unknown",
        remaining: "6,766",
    },
    {
        name: "unavailable usage",
        usage: undefined,
        total: "unknown",
        share: "unknown",
        remaining: "unknown",
    },
    {
        name: "unknown window",
        usage: { tokens: 1234, contextWindow: 0, percent: null },
        total: "1,234",
        share: "unknown",
        remaining: "unknown",
    },
] satisfies {
    name: string;
    usage: ContextUsage | undefined;
    total: string;
    share: string;
    remaining: string;
}[]) {
    test(`the headless context command preserves Pi ${scenario.name} without estimating replacement totals`, async () => {
        // The model capacity is used only when the whole usage result is absent, matching Dock.
        const sessionManager = SessionManager.inMemory();
        sessionManager.appendMessage({ role: "system", content: "x".repeat(400), timestamp: 0 });
        const notices: string[] = [];
        let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
        registerContext(
            {
                registerCommand(_name, options) {
                    handler = options.handler;
                },
            } as ExtensionAPI,
            async () => true,
        );
        await handler!("", {
            mode: "print",
            sessionManager,
            model: { contextWindow: 8000 },
            getContextUsage: () => scenario.usage,
            ui: { notify: (message: string) => notices.push(message) },
        } as unknown as ExtensionCommandContext);
        assert.equal(notices.length, 1);
        const window = scenario.usage?.contextWindow === 0 ? "unknown" : "8,000";
        assert.ok(notices[0]!.includes(`Pi context usage: ${scenario.total} / ${window} tokens`));
        assert.ok(notices[0]!.includes(`Pi context share: ${scenario.share}`));
        assert.ok(notices[0]!.includes(`Remaining: ${scenario.remaining} tokens`));
        assert.match(notices[0]!, /System prompt: 100 estimated tokens/);
        assert.doesNotMatch(notices[0]!, /adjustment|Category estimate:|billing/i);
    });
}
