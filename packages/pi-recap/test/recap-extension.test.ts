import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getSettingsPanelRegistry } from "@lune_99/pi-lune-extensions-core/panel/host";
import { registerRecap } from "../src/extension.ts";

type Handler = (event: unknown, context: ExtensionContext) => unknown;
async function fixture(t: TestContext, mode = "tui", config?: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-recap-native-"));
    const agentDir = path.join(root, "agent");
    const settingsFile = path.join(agentDir, "lune-settings", "pi-recap.json");
    await mkdir(path.dirname(settingsFile), { recursive: true });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    if (config !== undefined) await writeFile(settingsFile, config);
    t.after(async () => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
    });
    const handlers = new Map<string, Set<Handler>>();
    const commands = new Map<
        string,
        (args: string, context: ExtensionCommandContext) => Promise<void>
    >();
    const manager = SessionManager.inMemory(root);
    const widgets: unknown[] = [];
    const notices: string[] = [];
    const selected: Model<string> = {
        id: "offline",
        name: "Offline",
        provider: "fixture",
        api: "faux",
        baseUrl: "http://localhost:0",
        input: ["text"],
        reasoning: false,
        contextWindow: 32000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const pi = {
        on(name: string, handler: Handler) {
            const group = handlers.get(name) ?? new Set();
            group.add(handler);
            handlers.set(name, group);
            return () => {
                group.delete(handler);
            };
        },
        registerCommand(
            name: string,
            options: { handler: typeof commands extends Map<string, infer H> ? H : never },
        ) {
            commands.set(name, options.handler);
        },
        appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data),
    } as unknown as ExtensionAPI;
    const ctx = {
        cwd: root,
        mode,
        isProjectTrusted: () => true,
        model: selected,
        sessionManager: manager,
        scopedModels: [],
        isIdle: () => true,
        hasPendingMessages: () => false,
        modelRegistry: { find: () => selected },
        ui: {
            notify: (message: string) => notices.push(message),
            setWidget: (_name: string, widget: unknown) => widgets.push(widget),
        },
    } as unknown as ExtensionCommandContext;
    return {
        pi,
        ctx,
        manager,
        commands,
        widgets,
        notices,
        handlers,
        selected,
        settingsFile,
        async emit(name: string, event: Record<string, unknown> = {}) {
            for (const handler of [...(handlers.get(name) ?? [])])
                await handler({ type: name, ...event }, ctx);
        },
    };
}

for (const mode of ["tui", "rpc", "print"])
    test(`native Recap in ${mode} initializes Settings, limits Panel mounting and cleans repeated shutdown`, async (t) => {
        const f = await fixture(t, mode);
        const count = process.stdin.listenerCount("data");
        const handle = registerRecap(f.pi);
        t.after(() => handle.dispose());
        assert.ok(f.commands.has("recap"));
        await f.emit("session_start");
        const sections = getSettingsPanelRegistry().getSections(f.ctx.ui);
        assert.deepEqual(
            sections.map((section) => section.id),
            mode === "tui" ? ["recap"] : [],
        );
        if (mode === "tui") assert.equal(sections[0]!.fields[0]!.inspect().value, false);
        await f.commands.get("recap")!("", f.ctx);
        assert.match(f.notices[0]!, mode === "tui" ? /No conversation/ : /interactive terminal/);
        assert.equal(process.stdin.listenerCount("data"), count);
        await f.emit("session_shutdown");
        const cleanup = handle.dispose();
        assert.strictEqual(handle.dispose(), cleanup);
        await cleanup;
        assert.deepEqual(getSettingsPanelRegistry().getSections(f.ctx.ui), []);
        assert.equal(
            [...f.handlers.values()].reduce((total, handlers) => total + handlers.size, 0),
            0,
        );
        await assert.rejects(f.commands.get("recap")!("", f.ctx), { name: "AbortError" });
    });

test("invalid Recap configuration prevents startup and propagates the validation error without rewriting settings", async (t) => {
    const config = '{"enabled":"invalid"}';
    const f = await fixture(t, "tui", config);
    const count = process.stdin.listenerCount("data");
    const handle = registerRecap(f.pi);
    t.after(() => handle.dispose());
    const expected = {
        name: "TypeError",
        message: `Invalid value for setting "enabled" for "pi-recap" in ${f.settingsFile}`,
    };
    await assert.rejects(f.emit("session_start"), expected);
    // Core keeps an unavailable section so the Panel can explain why Recap cannot be configured.
    const sections = getSettingsPanelRegistry().getSections(f.ctx.ui);
    assert.deepEqual(
        sections.map(({ id, fields, unavailable }) => ({ id, fields, unavailable })),
        [{ id: "recap", fields: [], unavailable: expected.message }],
    );
    await assert.rejects(f.commands.get("recap")!("", f.ctx), expected);
    const actual = await readFile(f.settingsFile, "utf8");
    assert.equal(actual, config);
    assert.equal(process.stdin.listenerCount("data"), count);
    assert.deepEqual(f.widgets, []);
});

test("repeated startup retires the old Panel and replaces focus observation without duplicate listeners", async (t) => {
    const f = await fixture(t, "tui", '{"enabled":true}');
    const count = process.stdin.listenerCount("data");
    const flowing = process.stdin.readableFlowing;
    t.after(() => {
        // Attaching a data listener resumes stdin even after that listener is removed.
        if (flowing !== true) process.stdin.pause();
    });
    const handle = registerRecap(f.pi);
    t.after(() => handle.dispose());
    await f.emit("session_start");
    const previous = getSettingsPanelRegistry().getSections(f.ctx.ui)[0]!;
    assert.equal(previous.fields[0]!.inspect().value, true);
    assert.equal(process.stdin.listenerCount("data"), count + 1);

    await f.emit("session_start");
    const sections = getSettingsPanelRegistry().getSections(f.ctx.ui);
    const expected = ["recap"];
    const actual = sections.map((section) => section.id);
    assert.deepEqual(actual, expected);
    assert.throws(() => previous.fields[0]!.inspect(), /released/);
    assert.equal(sections[0]!.fields[0]!.inspect().value, true);
    assert.equal(process.stdin.listenerCount("data"), count + 1);
    await f.commands.get("recap")!("", f.ctx);
    assert.match(f.notices[0]!, /No conversation/);

    await f.emit("session_shutdown");
    assert.equal(process.stdin.listenerCount("data"), count);
    assert.deepEqual(getSettingsPanelRegistry().getSections(f.ctx.ui), []);
});

test("shutdown racing native startup never publishes a late Panel or runtime", async (t) => {
    const f = await fixture(t);
    const handle = registerRecap(f.pi);
    const startup = f.emit("session_start");
    const rejected = assert.rejects(startup, { name: "AbortError" });
    await handle.dispose();
    await rejected;
    assert.deepEqual(getSettingsPanelRegistry().getSections(f.ctx.ui), []);
    assert.deepEqual(f.widgets, []);
    await assert.rejects(f.commands.get("recap")!("", f.ctx), { name: "AbortError" });
});

test("native shutdown cancels a pending request before removing configuration and ignores a late response", async (t) => {
    const f = await fixture(t);
    let signal: AbortSignal | undefined;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
        requested = resolve;
    });
    const stream = createAssistantMessageEventStream();
    Object.assign(f.ctx.modelRegistry, {
        streamSimple: (_model: unknown, _input: unknown, options: { signal: AbortSignal }) => {
            signal = options.signal;
            requested();
            return stream;
        },
    });
    f.manager.appendMessage({
        role: "user",
        content: "Explain the current task",
        timestamp: Date.now(),
    });
    const handle = registerRecap(f.pi);
    t.after(() => handle.dispose());
    await f.emit("session_start");
    const section = getSettingsPanelRegistry().getSections(f.ctx.ui)[0]!;
    const request = f.commands.get("recap")!("", f.ctx);
    await started;
    await f.emit("session_shutdown");
    assert.equal(signal!.aborted, true);
    await request;
    assert.deepEqual(getSettingsPanelRegistry().getSections(f.ctx.ui), []);
    assert.throws(() => section.fields[0]!.inspect(), /released/);
    const widgetCount = f.widgets.length;
    stream.end({
        role: "assistant",
        content: [{ type: "text", text: "late" }],
        api: f.selected.api,
        provider: f.selected.provider,
        model: f.selected.id,
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    });
    await Promise.resolve();
    assert.equal(f.widgets.length, widgetCount);
    assert.deepEqual(f.notices, []);
});

test("session_start after a reload shows the saved recap without another provider call", async (t) => {
    const f = await fixture(t);
    let requests = 0;
    Object.assign(f.ctx.modelRegistry, {
        streamSimple: () => {
            requests++;
            const stream = createAssistantMessageEventStream();
            const message = {
                role: "assistant",
                content: [{ type: "text", text: "saved summary" }],
                api: f.selected.api,
                provider: f.selected.provider,
                model: f.selected.id,
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
            };
            stream.push({ type: "done", reason: "stop", message } as never);
            stream.end(message as never);
            return stream;
        },
    });
    f.manager.appendMessage({
        role: "user",
        content: "Explain the current task",
        timestamp: Date.now(),
    });
    const handle = registerRecap(f.pi);
    t.after(() => handle.dispose());
    await f.emit("session_start");
    await f.commands.get("recap")!("", f.ctx);
    assert.equal(requests, 1);

    // Pi shuts the old extension down, loads a fresh one and starts the session again.
    await f.emit("session_shutdown");
    const reloaded = registerRecap(f.pi);
    t.after(() => reloaded.dispose());
    const before = f.widgets.length;
    await f.emit("session_start");

    assert.equal(requests, 1);
    assert.equal(f.widgets.length, before + 1);
    assert.equal(typeof f.widgets.at(-1), "function");
});
