import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
    keyText,
    VERSION,
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { installStartupHeader, type HeaderFactory } from "../src/startup-header.ts";
import { createThemeExtension } from "../src/extension.ts";
import { createSettingsFixture } from "./harness/settings.ts";

const native = { id: "native" };
const lune: Component = { render: () => ["lune"], invalidate() {} };
const factory: HeaderFactory = () => lune;

interface ModeOptions {
    container?: boolean;
    setExtensionHeader?: "ok" | "missing" | "throws";
}

// A fresh class per test: the patch lives on the prototype, so sharing one would leak between tests.
function fakeMode({ container = true, setExtensionHeader = "ok" }: ModeOptions = {}) {
    const swaps: unknown[] = [];
    class HeaderContainer {
        children: unknown[] = [];
        addChild(child: unknown) {
            this.children.push(child);
        }
    }
    class FakeMode {
        headerContainer = container ? new HeaderContainer() : undefined;
        builtInHeader: unknown;
        static initCalls = 0;
        async init() {
            FakeMode.initCalls++;
            this.builtInHeader = native;
            this.headerContainer?.addChild(this.builtInHeader);
            return "init-result";
        }
    }
    if (setExtensionHeader !== "missing")
        Object.assign(FakeMode.prototype, {
            setExtensionHeader(this: FakeMode, next: HeaderFactory) {
                swaps.push(next);
                if (setExtensionHeader === "throws") throw new Error("boom");
                const children = this.headerContainer!.children;
                children[children.indexOf(this.builtInHeader)] = next({} as TUI, {} as never);
            },
        });
    return { FakeMode, swaps };
}

const always = async () => true;

test("without a usable InteractiveMode the startup header is inert and never reads settings", () => {
    let reads = 0;
    const enabled = async () => (reads++, true);
    const missing = installStartupHeader({ interactiveMode: undefined, enabled, factory });
    const noInit = installStartupHeader({ interactiveMode: class {}, enabled, factory });

    assert.equal(missing.claim(), false);
    assert.equal(noInit.claim(), false);
    assert.equal(reads, 0);
});

test("enabled init swaps the native header for the factory's component and is claimed once", async () => {
    const { FakeMode, swaps } = fakeMode();
    const startupHeader = installStartupHeader({
        interactiveMode: FakeMode,
        enabled: always,
        factory,
    });
    const mode = new FakeMode();

    const result = await mode.init();

    assert.equal(result, "init-result");
    assert.deepEqual(mode.headerContainer!.children, [lune]);
    assert.deepEqual(swaps, [factory]);
    assert.equal(startupHeader.claim(), true);
    assert.equal(startupHeader.claim(), false);
    assert.equal(Object.hasOwn(mode.headerContainer!, "addChild"), false);
});

test("addChild is restored after init even when the native header was never added", async () => {
    const { FakeMode, swaps } = fakeMode();
    FakeMode.prototype.init = async function (this: InstanceType<typeof FakeMode>) {
        this.headerContainer!.addChild({ other: true });
        return "done";
    };
    const startupHeader = installStartupHeader({
        interactiveMode: FakeMode,
        enabled: always,
        factory,
    });
    const mode = new FakeMode();

    assert.equal(await mode.init(), "done");

    assert.deepEqual(swaps, []);
    assert.equal(startupHeader.claim(), false);
    assert.equal(Object.hasOwn(mode.headerContainer!, "addChild"), false);
});

for (const [name, enabled] of [
    ["resolves false", async () => false],
    ["rejects", async () => Promise.reject(new Error("settings unreadable"))],
] as const) {
    test(`when enabled() ${name} the native header stays and init still runs`, async () => {
        const { FakeMode, swaps } = fakeMode();
        const startupHeader = installStartupHeader({ interactiveMode: FakeMode, enabled, factory });
        const mode = new FakeMode();

        assert.equal(await mode.init(), "init-result");

        assert.deepEqual(mode.headerContainer!.children, [native]);
        assert.deepEqual(swaps, []);
        assert.equal(startupHeader.claim(), false);
    });
}

for (const [name, options] of [
    ["headerContainer", { container: false }],
    ["setExtensionHeader", { setExtensionHeader: "missing" }],
] as const satisfies readonly (readonly [string, ModeOptions])[]) {
    test(`init completes untouched when Pi no longer exposes ${name}`, async () => {
        const { FakeMode } = fakeMode(options);
        const startupHeader = installStartupHeader({
            interactiveMode: FakeMode,
            enabled: always,
            factory,
        });
        const mode = new FakeMode();

        assert.equal(await mode.init(), "init-result");

        assert.deepEqual(
            mode.headerContainer?.children ?? [],
            options.container === false ? [] : [native],
        );
        assert.equal(startupHeader.claim(), false);
    });
}

test("a throwing setExtensionHeader falls back to the native header and restores addChild", async () => {
    const { FakeMode, swaps } = fakeMode({ setExtensionHeader: "throws" });
    const startupHeader = installStartupHeader({
        interactiveMode: FakeMode,
        enabled: always,
        factory,
    });
    const mode = new FakeMode();

    assert.equal(await mode.init(), "init-result");

    assert.deepEqual(swaps, [factory]);
    assert.deepEqual(mode.headerContainer!.children, [native]);
    assert.equal(startupHeader.claim(), false);
    assert.equal(Object.hasOwn(mode.headerContainer!, "addChild"), false);
});

test("installing after init already ran is inert", async () => {
    const { FakeMode } = fakeMode();
    installStartupHeader({ interactiveMode: FakeMode, enabled: always, factory });
    await new FakeMode().init();
    const initAfterFirst = FakeMode.prototype.init;
    let reads = 0;

    const reload = installStartupHeader({
        interactiveMode: FakeMode,
        enabled: async () => (reads++, true),
        factory,
    });

    assert.equal(reload.claim(), false);
    assert.equal(reads, 0);
    assert.strictEqual(FakeMode.prototype.init, initAfterFirst);
});

test("a second install before init supersedes the first and the original init runs once", async () => {
    const { FakeMode } = fakeMode();
    const stale = installStartupHeader({ interactiveMode: FakeMode, enabled: always, factory });
    const newest = installStartupHeader({ interactiveMode: FakeMode, enabled: always, factory });

    await new FakeMode().init();

    assert.equal(FakeMode.initCalls, 1);
    assert.equal(stale.claim(), false);
    assert.equal(newest.claim(), true);
});

test("dispose stops further swapping", async () => {
    const { FakeMode, swaps } = fakeMode();
    const startupHeader = installStartupHeader({
        interactiveMode: FakeMode,
        enabled: always,
        factory,
    });
    startupHeader.dispose();
    const mode = new FakeMode();

    assert.equal(await mode.init(), "init-result");

    assert.deepEqual(mode.headerContainer!.children, [native]);
    assert.deepEqual(swaps, []);
    assert.equal(startupHeader.claim(), false);
});

type UiHeader = Parameters<ExtensionUIContext["setHeader"]>[0];
type Handler = (event: unknown, context: ExtensionContext) => unknown;

// Settings are read when the extension is created, so the files must be written beforehand.
async function startup(
    t: TestContext,
    write: (files: Awaited<ReturnType<typeof createSettingsFixture>>) => Promise<void>,
) {
    const files = await createSettingsFixture(t);
    await write(files);
    const { FakeMode } = fakeMode();
    const handlers = new Map<string, Set<Handler>>();
    const headers: UiHeader[] = [];
    const ctx = {
        cwd: files.cwd,
        mode: "tui",
        isProjectTrusted: () => true,
        sessionManager: SessionManager.inMemory(files.cwd),
        ui: { setHeader: (next: UiHeader) => headers.push(next) },
    } as unknown as ExtensionContext;
    const pi = {
        on(name: string, handler: Handler) {
            const listeners = handlers.get(name) ?? new Set<Handler>();
            handlers.set(name, listeners);
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        registerCommand() {},
    } as unknown as ExtensionAPI;
    await createThemeExtension({ piVersion: VERSION, keyText, interactiveMode: FakeMode })(pi);
    const emit = async (name: string) => {
        for (const handler of [...(handlers.get(name) ?? [])]) await handler({ type: name }, ctx);
    };
    t.after(() => emit("session_shutdown"));
    return { FakeMode, headers, emit, files };
}

test("session_start keeps the header Pi adopted at startup when settings still want it", async (t) => {
    const { FakeMode, headers, emit } = await startup(t, (files) =>
        files.writeScope("global", { enabled: true }),
    );
    const mode = new FakeMode();
    await mode.init();
    assert.equal(mode.headerContainer!.children.length, 1);
    assert.notStrictEqual(mode.headerContainer!.children[0], native);

    await emit("session_start");

    assert.deepEqual(headers, []);
});

test("session_start clears the startup header when project settings turn the header off", async (t) => {
    const { FakeMode, headers, emit } = await startup(t, async (files) => {
        await files.writeScope("global", { enabled: true });
        // The first frame reads global values only, so only the session binding sees the override.
        await files.writeScope("project", { showStartupHeader: false });
    });
    const mode = new FakeMode();
    await mode.init();
    assert.equal(mode.headerContainer!.children.length, 1);
    assert.notStrictEqual(mode.headerContainer!.children[0], native);

    await emit("session_start");

    assert.deepEqual(headers, [undefined]);
});

test("a global showStartupHeader=false keeps Pi's native header at startup", async (t) => {
    const { FakeMode, headers, emit } = await startup(t, (files) =>
        files.writeScope("global", { enabled: true, showStartupHeader: false }),
    );
    const mode = new FakeMode();
    await mode.init();

    await emit("session_start");

    assert.deepEqual(mode.headerContainer!.children, [native]);
    assert.deepEqual(headers, []);
});

test("session_start clears the startup header when project settings disable the theme", async (t) => {
    const { FakeMode, headers, emit } = await startup(t, async (files) => {
        await files.writeScope("global", { enabled: true });
        await files.writeScope("project", { enabled: false });
    });
    await new FakeMode().init();

    await emit("session_start");

    assert.deepEqual(headers, [undefined]);
});

test("with the theme off nothing is swapped at startup and session_start sets no header", async (t) => {
    const { FakeMode, headers, emit } = await startup(t, (files) =>
        files.writeScope("global", { enabled: false }),
    );
    const mode = new FakeMode();
    await mode.init();

    await emit("session_start");

    assert.deepEqual(mode.headerContainer!.children, [native]);
    assert.deepEqual(headers, []);
});
