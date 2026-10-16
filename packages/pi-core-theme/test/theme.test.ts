import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
    keyText,
    VERSION,
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createThemeExtension } from "../src/extension.ts";
import { getSettingsPanelRegistry } from "@lune_99/pi-lune-extensions-core/panel/host";
import { createSettingsFixture } from "./harness/settings.ts";

const luneTheme = createThemeExtension({ piVersion: VERSION, keyText });

type HeaderFactory = Parameters<ExtensionUIContext["setHeader"]>[0];
type Handler = (event: unknown, context: ExtensionContext) => unknown;

async function runtimeFixture(t: TestContext, mode: ExtensionContext["mode"] = "tui") {
    const files = await createSettingsFixture(t);
    const handlers = new Map<string, Set<Handler>>();
    const calls: HeaderFactory[] = [];
    let failHeader = false;
    const context = (cwd = files.cwd) =>
        ({
            cwd,
            mode,
            isProjectTrusted: () => true,
            sessionManager: SessionManager.inMemory(cwd),
            ui: {
                setHeader(factory: HeaderFactory) {
                    if (failHeader) throw new Error("Header installation failed");
                    calls.push(factory);
                },
            },
        }) as unknown as ExtensionContext;
    const ctx = context();
    const pi = {
        on(name: string, handler: Handler) {
            const listeners = handlers.get(name) ?? new Set<Handler>();
            handlers.set(name, listeners);
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        registerCommand() {},
    } as unknown as ExtensionAPI;
    const emit = async (name: string, current = ctx) => {
        for (const handler of [...(handlers.get(name) ?? [])])
            await handler({ type: name }, current);
    };
    await luneTheme(pi);
    t.after(() => emit("session_shutdown"));
    const section = (current = ctx) =>
        getSettingsPanelRegistry()
            .getSections(current.ui)
            .find(({ id }) => id === "core-theme")!;
    return {
        ...files,
        ctx,
        context,
        calls,
        handlers,
        emit,
        section,
        failHeader: () => {
            failHeader = true;
        },
    };
}

test("Core theme starts off and committed panel edits install and restore the header", async (t) => {
    // Exercise the real theme entry, Core Settings storage and Panel field instead of a mocked binding.
    const runtime = await runtimeFixture(t);
    await runtime.emit("session_start");
    assert.equal(runtime.section().label, "Theme");
    const field = runtime.section().fields[0]!;
    assert.equal(field.label, "Core theme");
    assert.equal(field.inspect().defaultValue, false);
    assert.equal(field.inspect().value, false);
    assert.deepEqual(field.choices, [
        { value: true, label: "on" },
        { value: false, label: "off" },
    ]);
    assert.deepEqual(runtime.calls, []);
    await assert.rejects(runtime.readRawScope("global"), { code: "ENOENT" });
    await field.set(true, "global");
    assert.equal(typeof runtime.calls[0], "function");
    assert.deepEqual(await runtime.readScope("global"), { enabled: true });
    await runtime.section().reload();
    assert.equal(runtime.calls.length, 1);
    await field.set(false, "global");
    assert.deepEqual(runtime.calls.slice(1), [undefined]);
    assert.deepEqual(await runtime.readScope("global"), { enabled: false });
});

test("persisted project overrides and reload control the effective Core theme", async (t) => {
    // A project-level off must win over global on, including subsequent global edits.
    const runtime = await runtimeFixture(t);
    await runtime.writeScope("global", { enabled: true });
    await runtime.writeScope("project", { enabled: false });
    await runtime.emit("session_start");
    const field = runtime.section().fields[0]!;
    assert.equal(field.inspect().source, "project");
    assert.deepEqual(runtime.calls, []);
    await field.set(false, "global");
    await field.set(true, "global");
    assert.deepEqual(runtime.calls, []);
    await field.reset("project");
    assert.equal(typeof runtime.calls[0], "function");
    await runtime.writeScope("global", { enabled: false });
    await runtime.section().reload();
    assert.deepEqual(runtime.calls.slice(1), [undefined]);
});

test("Core theme restores the previous session and releases all hooks on shutdown", async (t) => {
    // Session replacement must retire the old field and project appearance together.
    const runtime = await runtimeFixture(t);
    await runtime.writeScope("global", { enabled: true });
    await runtime.emit("session_start");
    assert.equal(typeof runtime.calls[0], "function");
    const oldField = runtime.section().fields[0]!;
    const otherCwd = path.join(runtime.root, "other-project");
    await mkdir(otherCwd);
    await runtime.writeScope("project", { enabled: false }, otherCwd);
    const next = runtime.context(otherCwd);
    await runtime.emit("session_start", next);
    assert.deepEqual(runtime.calls.slice(1), [undefined]);
    assert.equal(getSettingsPanelRegistry().getSections(runtime.ctx.ui).length, 0);
    assert.throws(() => oldField.set(false, "global"), /released/);
    await runtime.section(next).fields[0]!.set(true, "project");
    assert.equal(typeof runtime.calls[2], "function");
    await runtime.emit("session_shutdown", next);
    assert.equal(runtime.calls[3], undefined);
    assert.equal(runtime.calls.length, 4);
    assert.equal(getSettingsPanelRegistry().getSections(next.ui).length, 0);
    assert.equal(
        [...runtime.handlers.values()].reduce((count, listeners) => count + listeners.size, 0),
        0,
    );
    await runtime.emit("session_shutdown", next);
    assert.equal(runtime.calls.length, 4);
});

for (const mode of ["print", "rpc"] as const) {
    test(`Core theme enabled in ${mode} never installs terminal UI`, async (t) => {
        // Non-TUI hosts still acquire persisted settings but have no appearance side effects.
        const runtime = await runtimeFixture(t, mode);
        await runtime.writeScope("global", { enabled: true });
        await runtime.emit("session_start");
        assert.deepEqual(runtime.calls, []);
        assert.equal(getSettingsPanelRegistry().getSections(runtime.ctx.ui).length, 0);
    });
}

test("a failed header installation reports a committed Settings notification error", async (t) => {
    // Rendering errors must remain visible without pretending the saved switch was rolled back.
    const runtime = await runtimeFixture(t);
    await runtime.emit("session_start");
    runtime.failHeader();
    const field = runtime.section().fields[0]!;
    await assert.rejects(field.set(true, "global"), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(Reflect.get(error, "committed"), true);
        assert.match(String(error.errors[0]), /Header installation failed/);
        return true;
    });
    assert.equal(field.inspect().value, true);
    assert.deepEqual(await runtime.readScope("global"), { enabled: true });
    assert.deepEqual(runtime.calls, []);
});
