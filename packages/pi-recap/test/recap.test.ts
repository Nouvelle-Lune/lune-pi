import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, test, type TestContext } from "node:test";
import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    type Model,
    type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamProvider } from "@earendil-works/pi-ai/compat";
import {
    SessionManager,
    type CustomEntry,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
    Agent,
    getGlobalDispatcher,
    install as installUndiciGlobals,
    setGlobalDispatcher,
} from "undici";
import { acquireSettings } from "@lune_99/pi-lune-extensions-core/settings/advanced";
import { recapSettings, type RecapSettingsView } from "../src/settings.ts";
import { recapPanel } from "../src/panel.ts";
import { createDefinedSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
const createRecapSection = (settings: RecapSettingsView) =>
    createDefinedSettingsSection(settings, recapPanel);
import { observeTerminalFocus } from "../src/focus.ts";
import { RecapRuntime } from "../src/runtime.ts";
import { collectRecapInput, fingerprintRecapInput, serializeRecapInput } from "../src/input.ts";
import { generateRecap, normalizeRecap, withAbort } from "../src/generate.ts";

const model: Model<string> = {
    id: "recap-test",
    name: "Recap test",
    provider: "offline-test",
    api: "openai-completions",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64000,
    maxTokens: 8192,
};
const usage = {
    input: 10,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function response(
    text = "done/",
    stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason,
        timestamp: Date.now(),
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function fixture(t: TestContext) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-recap-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    const session = SessionManager.inMemory(root);
    const notices: string[] = [];
    const calls: {
        model: Model<string>;
        context: Context;
        options?: ModelsSimpleStreamOptions;
    }[] = [];
    const terminalInput = new PassThrough();
    let widget: Component | undefined;
    let idle = true;
    let pending = false;
    let provider = async () => response();
    let streamSource:
        | ((
              selected: Model<string>,
              context: Context,
              options?: ModelsSimpleStreamOptions,
          ) => AssistantMessageEventStream)
        | undefined;
    let nextRecapRecord = deferred<void>();
    const theme = { fg: (_color: string, text: string) => text } as Theme;
    const ctx = {
        cwd: root,
        mode: "tui",
        model,
        scopedModels: [],
        sessionManager: session,
        isIdle: () => idle,
        hasPendingMessages: () => pending,
        ui: {
            notify: (text: string) => notices.push(text),
            setWidget: (_key: string, factory?: (_tui: unknown, theme: Theme) => Component) => {
                widget = factory?.({}, theme);
            },
        },
        modelRegistry: {
            find: (provider: string, id: string) =>
                provider === model.provider && id === model.id ? model : undefined,
            streamSimple: (
                selected: Model<string>,
                context: Context,
                options?: ModelsSimpleStreamOptions,
            ) => {
                calls.push({ model: selected, context, options });
                if (streamSource) {
                    return streamSource(selected, context, options);
                }
                const stream = createAssistantMessageEventStream();
                void provider().then(
                    (result) => {
                        stream.push({ type: "done", reason: "stop", message: result });
                        stream.end(result);
                    },
                    (error) => {
                        const result = {
                            ...response("", "error"),
                            errorMessage: String(error),
                        };
                        stream.push({ type: "error", reason: "error", error: result });
                        stream.end(result);
                    },
                );
                return stream;
            },
        },
    } as unknown as ExtensionContext;
    const lease = await acquireSettings(recapSettings, { cwd: root, projectTrusted: true });
    const manager = lease.settings;
    const pi = {
        appendEntry: (type: string, data: unknown) => {
            const id = session.appendCustomEntry(type, data);
            if (type === "pi-recap.v1") {
                const written = nextRecapRecord;
                nextRecapRecord = deferred<void>();
                written.resolve();
            }
            return id;
        },
    } as unknown as ExtensionAPI;
    let runtime = new RecapRuntime(pi, ctx, manager, terminalInput);
    t.after(async () => {
        runtime.dispose();
        await lease.release();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
    });
    let rounds = 0;
    // Rounds are substantial by default (five tool results) because automatic recap
    // only considers the latest completed round that did real work. The elapsed
    // time is written onto the entries, so it does not depend on mocked clocks.
    const addRound = (
        stopReason: AssistantMessage["stopReason"] = "stop",
        outcome: "completed" | "error" | "aborted" = "completed",
        { tools = 5, durationMs = 0 }: { tools?: number; durationMs?: number } = {},
    ) => {
        runtime.start(ctx);
        // Each round has distinct text so the bounded recap window changes with every round.
        const prompt = `Implement recap ${++rounds}`;
        const end = Date.now();
        const stamp = (id: string, at: number) => {
            session.getEntry(id)!.timestamp = new Date(at).toISOString();
        };
        stamp(
            session.appendMessage({
                role: "user",
                content: prompt,
                timestamp: end - durationMs,
            }),
            end - durationMs,
        );
        for (let index = 0; index < tools; index++) {
            const callId = `call-${index}`;
            session.appendMessage({
                ...response("", "toolUse"),
                content: [{ type: "toolCall", id: callId, name: "bash", arguments: {} }],
            });
            session.appendMessage({
                role: "toolResult",
                toolCallId: callId,
                toolName: "bash",
                content: [{ type: "text", text: "ok" }],
                isError: false,
                timestamp: end,
            });
        }
        stamp(session.appendMessage(response("Settings done", stopReason)), end);
        runtime.beforeSettle(outcome, ctx);
        runtime.settled(ctx);
    };
    return {
        ctx,
        session,
        manager,
        calls,
        notices,
        addRound,
        get runtime() {
            return runtime;
        },
        focus: (data: string) => terminalInput.emit("data", data),
        widget: () => widget,
        nextRecapRecord: () => nextRecapRecord.promise,
        setModelBaseUrl: (value: string) => {
            ctx.model = { ...model, baseUrl: value };
        },
        streamSource: (value: typeof streamSource) => {
            streamSource = value;
        },
        idle: (value: boolean) => {
            idle = value;
        },
        pending: (value: boolean) => {
            pending = value;
        },
        provider: (value: () => Promise<AssistantMessage>) => {
            provider = value;
        },
        reload: () => {
            runtime.dispose();
            runtime = new RecapRuntime(pi, ctx, manager, terminalInput);
        },
    };
}

/**
 * Pi installs one global undici dispatcher for provider requests, with
 * `headersTimeout` and `bodyTimeout` derived from `httpIdleTimeoutMs`
 * (300000 ms by default) in pi-coding-agent's http-dispatcher module. This
 * helper uses the same mechanism with short timeouts, so a stalled provider
 * response reaches the idle timeout inside a test instead of after five minutes.
 */
async function withHttpIdleTimeout(t: TestContext, run: (baseUrl: string) => Promise<void>) {
    const server = createServer(() => {
        // Hold the request open: no response ever reaches the client.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
    }

    const previousFetch = globalThis.fetch;
    const previousDispatcher = getGlobalDispatcher();
    installUndiciGlobals();
    setGlobalDispatcher(
        new Agent({ headersTimeout: 250, bodyTimeout: 250, connect: { timeout: 250 } }),
    );
    t.after(() => {
        setGlobalDispatcher(previousDispatcher);
        globalThis.fetch = previousFetch;
        server.closeAllConnections();
        server.close();
    });

    await run(`http://127.0.0.1:${address.port}/v1`);
}

describe("recap session lifecycle", { concurrency: false, timeout: 10000 }, () => {
    test("manual recap works while automation is disabled and survives reload without another request", async (t) => {
        const f = await fixture(t);
        f.addRound();
        assert.equal(
            f.session.getBranch().some((entry) => entry.type === "custom"),
            false,
        );
        await f.runtime.manual(f.ctx);
        assert.equal(f.calls.length, 1);
        assert.match(f.widget()!.render(80)[0]!, /recap · done/);
        assert.ok(visibleWidth(f.widget()!.render(12)[0]!) <= 12);
        assert.equal(
            f.ctx.sessionManager
                .buildSessionProjection()
                .messages.filter((message) => message.role === "user").length,
            1,
        );
        f.reload();
        await f.runtime.manual(f.ctx);
        assert.equal(f.calls.length, 1);
        assert.equal(f.ctx.model, model);
        assert.deepEqual(f.runtime.diagnostics, undefined);
    });
    test("empty, non-TUI, busy, queued-message and prompt gates do not call the provider", async (t) => {
        const f = await fixture(t);
        await f.runtime.manual(f.ctx);
        assert.match(f.notices.at(-1)!, /No conversation/);
        f.addRound();
        await f.runtime.manual({ ...f.ctx, mode: "rpc" });
        assert.match(f.notices.at(-1)!, /interactive terminal/);
        f.idle(false);
        await f.runtime.manual(f.ctx);
        f.idle(true);
        f.pending(true);
        await f.runtime.manual(f.ctx);
        f.pending(false);
        f.runtime.prompt(true, f.ctx);
        await f.runtime.manual(f.ctx);
        f.runtime.prompt(false, f.ctx);
        assert.equal(f.calls.length, 0);
    });
    test("recap settings inherit, reset and reload without changing the session model or saved thinking", async (t) => {
        const f = await fixture(t);
        await f.manager.set("model", { provider: model.provider, id: model.id });
        await f.manager.set("thinkingLevel", "max");
        await f.manager.set("model", null, { scope: "project" });
        await f.manager.set("thinkingLevel", "high", { scope: "project" });
        assert.equal(f.manager.get("model"), null);
        await f.manager.reset("model", { scope: "project" });
        await f.manager.reset("thinkingLevel", { scope: "project" });
        await f.manager.reload();
        assert.deepEqual(f.manager.get("model"), {
            provider: model.provider,
            id: model.id,
        });
        const field = createRecapSection(f.manager).fields.find(
            (field) => field.id === "thinkingLevel",
        )!;
        assert.equal(field.formatValue!("max", f.ctx, "global"), "max → off (model limit)");
        assert.deepEqual(
            field.choiceSource!.load({
                ...field.choiceContext!(f.ctx, "global"),
                signal: new AbortController().signal,
            }),
            [{ value: "off", label: "off" }],
        );
        f.addRound();
        await f.runtime.manual(f.ctx);
        assert.equal(f.calls[0]!.options!.reasoning, undefined);
        assert.equal(f.manager.get("thinkingLevel"), "max");
        assert.equal(f.ctx.model, model);
    });

    test("a single completed substantial round plus real focus-out and three idle minutes triggers automation once", async (t) => {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        await f.manager.set("enabled", true);
        f.addRound();

        // Without a focus-out report the user is still present, however long it takes.
        t.mock.timers.tick(180000);
        assert.equal(f.calls.length, 0);

        // Returning before the idle delay elapses cancels the pending automation.
        f.addRound();
        f.focus("\x1b[O");
        t.mock.timers.tick(179999);
        assert.equal(f.calls.length, 0);
        f.focus("\x1b[I");
        t.mock.timers.tick(180000);
        assert.equal(f.calls.length, 0);

        // The settle is now older than three minutes, so a real focus-out recaps immediately.
        f.focus("\x1b[O");
        assert.equal(f.calls.length, 1);

        await f.runtime.manual(f.ctx);
        assert.ok(f.widget());
        f.focus("\x1b[I");
        f.focus("\x1b[O");
        t.mock.timers.tick(180000);
        assert.equal(f.calls.length, 1);
    });
    test("a completed substantial round does not trigger automation while it is disabled", async (t) => {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        f.addRound();
        f.focus("\x1b[O");
        t.mock.timers.tick(180000);
        assert.equal(f.calls.length, 0);
    });
    test("a delay timer that fires before the wall clock reaches the deadline re-arms and still recaps once", async (t) => {
        const f = await fixture(t);
        // Date and timers are mocked separately so the timer can fire while the wall clock is behind.
        let now = 1000000;
        t.mock.method(Date, "now", () => now);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        await f.manager.set("enabled", true);
        f.addRound();
        f.addRound();
        f.addRound();
        const written = f.nextRecapRecord();
        f.focus("\x1b[O");

        now += 180000 - 5;
        t.mock.timers.tick(180000);
        assert.equal(f.calls.length, 0);

        now += 5;
        t.mock.timers.tick(5);
        assert.equal(f.calls.length, 1);
        await written;
        assert.equal(f.calls.length, 1);
    });
    test("returning before completion permits display, but new input aborts and rejects late results", async (t) => {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        await f.manager.set("enabled", true);
        f.addRound();
        f.addRound();
        f.addRound();
        const generated = deferred<AssistantMessage>();
        f.provider(() => generated.promise);
        f.focus("\x1b[O");
        t.mock.timers.tick(180000);
        const waiting = f.runtime.manual(f.ctx);
        f.focus("\x1b[I");
        generated.resolve(response());
        await waiting;
        assert.ok(f.widget());
        f.addRound();
        const late = deferred<AssistantMessage>();
        f.provider(() => late.promise);
        const request = f.runtime.manual(f.ctx);
        const signal = f.calls.at(-1)!.options!.signal!;
        f.runtime.input(f.ctx);
        assert.equal(signal.aborted, true);
        await request;
        late.resolve(response("stale result"));
        await late.promise;
        assert.equal(f.widget(), undefined);
        assert.equal(f.notices.length, 0);
        assert.equal(
            f.session
                .getBranch()
                .filter(
                    (entry) =>
                        entry.type === "custom" &&
                        (entry.data as { text?: string })?.text === "stale result",
                ).length,
            0,
        );
    });
    test("automatic failure warns once per snapshot and explicit manual retry is allowed", async (t) => {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        await f.manager.set("enabled", true);
        f.addRound();
        f.addRound();
        f.addRound();
        f.provider(async () => response("", "error"));
        f.focus("\x1b[O");
        t.mock.timers.tick(180000);
        await f.runtime.manual(f.ctx);
        assert.equal(f.calls.length, 1);
        assert.equal(f.notices.length, 1);
        f.focus("\x1b[I");
        f.focus("\x1b[O");
        assert.equal(f.calls.length, 1);
        f.provider(async () => response());
        await f.runtime.manual(f.ctx);
        assert.equal(f.calls.length, 2);
        assert.ok(f.widget());
    });
    test("settings changes and branch changes cancel requests, and another branch cannot reuse a cached recap", async (t) => {
        const f = await fixture(t);
        f.addRound();
        const leaf = f.session.getLeafId()!;
        const pending = deferred<AssistantMessage>();
        f.provider(() => pending.promise);
        const waiting = f.runtime.manual(f.ctx);
        await f.manager.set("thinkingLevel", "max");
        await waiting;
        assert.equal(f.calls[0]!.options!.signal!.aborted, true);
        assert.equal(f.notices.length, 0);
        pending.resolve(response());
        f.provider(async () => response());
        await f.runtime.manual(f.ctx);
        assert.ok(f.widget());
        f.session.branch(leaf);
        f.session.appendMessage({
            role: "user",
            content: "Another branch",
            timestamp: Date.now(),
        });
        f.runtime.branchChanged(f.ctx);
        assert.equal(f.widget(), undefined);
        await f.runtime.manual(f.ctx);
        assert.equal(f.calls.length, 3);
        assert.equal(f.calls.at(-1)!.options!.reasoning, undefined);
    });
});

describe("recap automatic eligibility", { concurrency: false, timeout: 10000 }, () => {
    async function enabledFixture(t: TestContext) {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        await f.manager.set("enabled", true);
        return f;
    }

    // Leave the terminal and let the three idle minutes elapse.
    function awayForThreeMinutes(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
        f.focus("\x1b[O");
        t.mock.timers.tick(180000);
    }

    // Boundaries: at least 5 tool results, or at least 60 s from prompt to final reply.
    const thresholds = [
        { work: { tools: 5, durationMs: 0 }, triggers: true },
        { work: { tools: 4, durationMs: 0 }, triggers: false },
        { work: { tools: 4, durationMs: 60_000 }, triggers: true },
        { work: { tools: 4, durationMs: 59_999 }, triggers: false },
    ];
    for (const { work, triggers } of thresholds) {
        test(`a completed round with ${work.tools} tool results over ${work.durationMs} ms ${triggers ? "triggers" : "does not trigger"} automation`, async (t) => {
            const f = await enabledFixture(t);
            f.addRound("stop", "completed", work);
            awayForThreeMinutes(t, f);
            const expected = triggers ? 1 : 0;
            const actual = f.calls.length;
            assert.equal(actual, expected);
        });
    }

    test("a trivial completed round never triggers automation, but manual recap still works", async (t) => {
        const f = await enabledFixture(t);
        f.addRound("stop", "completed", { tools: 1, durationMs: 3000 });
        awayForThreeMinutes(t, f);
        assert.equal(f.calls.length, 0);

        await f.runtime.manual(f.ctx);
        assert.equal(f.calls.length, 1);
        assert.match(f.widget()!.render(80).join("\n"), /recap · done/);
    });

    test("only the latest completed round counts: a substantial round followed by a trivial one does not trigger", async (t) => {
        const f = await enabledFixture(t);
        f.addRound("stop", "completed", { tools: 8, durationMs: 120_000 });
        f.addRound("stop", "completed", { tools: 1, durationMs: 2000 });
        awayForThreeMinutes(t, f);
        assert.equal(f.calls.length, 0);
    });

    test("an earlier trivial round does not prevent a later substantial round from triggering", async (t) => {
        const f = await enabledFixture(t);
        f.addRound("stop", "completed", { tools: 1, durationMs: 2000 });
        f.addRound("stop", "completed", { tools: 5, durationMs: 0 });
        awayForThreeMinutes(t, f);
        assert.equal(f.calls.length, 1);
    });

    test("an aborted latest round is skipped so the earlier completed substantial round decides", async (t) => {
        const f = await enabledFixture(t);
        f.addRound("stop", "completed", { tools: 5, durationMs: 0 });
        f.addRound("aborted", "aborted", { tools: 1, durationMs: 1000 });
        awayForThreeMinutes(t, f);
        assert.equal(f.calls.length, 1);
    });

    test("an aborted substantial round is never judged, so an earlier trivial completed round blocks automation", async (t) => {
        const f = await enabledFixture(t);
        f.addRound("stop", "completed", { tools: 1, durationMs: 2000 });
        f.addRound("aborted", "aborted", { tools: 9, durationMs: 300_000 });
        awayForThreeMinutes(t, f);
        assert.equal(f.calls.length, 0);
    });

    test("a runtime-observed error overrides a clean stop reason on the latest substantial round", async (t) => {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        // While disabled no settled marker is persisted, so only the runtime outcome records the failure.
        f.addRound("stop", "completed", { tools: 1, durationMs: 2000 });
        f.addRound("stop", "error", { tools: 5, durationMs: 0 });
        assert.equal(
            f.session.getBranch().some((entry) => entry.type === "custom"),
            false,
        );
        await f.manager.set("enabled", true);
        awayForThreeMinutes(t, f);
        assert.equal(f.calls.length, 0);
    });

    test("a persisted settled marker with completed false overrides a clean stop reason after reload", async (t) => {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        f.addRound("stop", "completed", { tools: 1, durationMs: 2000 });
        f.addRound("stop", "completed", { tools: 5, durationMs: 0 });
        const userId = f.session
            .getBranch()
            .findLast((entry) => entry.type === "message" && entry.message.role === "user")!.id;
        f.session.appendCustomEntry("pi-recap.v1.settled", {
            userId,
            at: Date.now(),
            completed: false,
        });
        // A fresh runtime has no observed outcomes, so only the persisted marker can exclude the round.
        f.reload();
        await f.manager.set("enabled", true);
        awayForThreeMinutes(t, f);
        assert.equal(f.calls.length, 0);
    });

    test("a persisted settled marker with completed true makes an errored round eligible after reload", async (t) => {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        f.addRound("error", "completed", { tools: 5, durationMs: 0 });
        const userId = f.session
            .getBranch()
            .findLast((entry) => entry.type === "message" && entry.message.role === "user")!.id;
        f.session.appendCustomEntry("pi-recap.v1.settled", {
            userId,
            at: Date.now(),
            completed: true,
        });
        f.reload();
        await f.manager.set("enabled", true);
        awayForThreeMinutes(t, f);
        assert.equal(f.calls.length, 1);
    });
});

describe("recap host HTTP idle timeout", { concurrency: false, timeout: 10000 }, () => {
    test("an idle dispatcher timeout fails the automatic recap once and the snapshot stays retryable", async (t) => {
        await withHttpIdleTimeout(t, async (baseUrl) => {
            const f = await fixture(t);
            await f.manager.set("enabled", true);

            let userId = "";
            for (const text of ["First task", "Second task", "Third task"]) {
                userId = f.session.appendMessage({
                    role: "user",
                    content: text,
                    timestamp: Date.now(),
                });
                // The latest completed round must be substantial: five tool results.
                for (let index = 0; index < 5; index++) {
                    f.session.appendMessage({
                        role: "toolResult",
                        toolCallId: `call-${index}`,
                        toolName: "bash",
                        content: [{ type: "text", text: "ok" }],
                        isError: false,
                        timestamp: Date.now(),
                    });
                }
                f.session.appendMessage(response("Settings done"));
            }

            // Report the last settle as ten minutes old so the automatic three-minute
            // delay has already elapsed. Mocked timers would also intercept the
            // transport timers that this test exists to exercise.
            f.session.appendCustomEntry("pi-recap.v1.settled", {
                userId,
                at: Date.now() - 600_000,
                completed: true,
            });

            f.setModelBaseUrl(baseUrl);
            f.streamSource((selected, context, options) =>
                streamProvider(selected, context, { ...options, apiKey: "test" }),
            );
            f.reload();

            const failed = f.nextRecapRecord();
            f.focus("\x1b[O");
            await failed;

            const requests = f.calls;
            assert.equal(requests.length, 1);
            // Recap leaves the request timeout to the host, so the global dispatcher
            // idle timeout is what terminates this stalled response.
            assert.equal(requests[0]!.options!.timeoutMs, undefined);
            assert.equal(f.widget(), undefined);
            assert.equal(f.notices.length, 1);
            assert.match(f.notices[0]!, /^Recap failed: Recap error: /);

            const records = f.session
                .getBranch()
                .filter(
                    (entry): entry is CustomEntry =>
                        entry.type === "custom" && entry.customType === "pi-recap.v1",
                );
            assert.equal(records.length, 1);
            const expected = { failed: true, text: undefined };
            const actual = {
                failed: (records[0]!.data as { failed?: boolean }).failed,
                text: (records[0]!.data as { text?: string }).text,
            };
            assert.deepEqual(actual, expected);

            // Returning shows nothing, and the failed snapshot is not requested again.
            f.focus("\x1b[I");
            assert.equal(f.widget(), undefined);
            f.focus("\x1b[O");
            assert.equal(f.calls.length, 1);

            // An explicit /recap still retries once the provider answers.
            f.streamSource(undefined);
            await f.runtime.manual(f.ctx);
            assert.equal(f.calls.length, 2);
            assert.match(f.widget()!.render(80).join("\n"), /recap · done/);
        });
    });
});

describe("recap automatic cache restoration", { concurrency: false, timeout: 10000 }, () => {
    async function generatedWhileAway(t: TestContext) {
        const f = await fixture(t);
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
        await f.manager.set("enabled", true);
        f.addRound();
        f.addRound();
        f.addRound();

        // Synchronize on the persisted result, not a manual command or a sleep.
        const written = f.nextRecapRecord();
        f.focus("\x1b[O");
        t.mock.timers.tick(180000);
        await written;
        assert.equal(f.calls.length, 1);
        assert.equal(f.widget(), undefined);
        return f;
    }

    async function displayedBeforeInvalidation(t: TestContext) {
        const f = await generatedWhileAway(t);
        f.focus("\x1b[I");
        assert.match(f.widget()!.render(80).join("\n"), /recap · done/);
        return f;
    }

    test("automatic generation waits for focus-in to display and repeated reports do not remount the widget", async (t) => {
        const f = await generatedWhileAway(t);
        f.focus("\x1b[I");
        const displayed = f.widget();
        assert.ok(displayed);
        assert.match(displayed.render(80).join("\n"), /recap · done/);
        const entries = f.session.getBranch().length;

        f.focus("\x1b[I");
        f.focus("\x1b[O");
        f.focus("\x1b[I");
        assert.equal(f.calls.length, 1);
        assert.strictEqual(f.widget(), displayed);
        assert.equal(f.session.getBranch().length, entries);
    });

    test("reloading the same branch redisplays its previously displayed recap on focus-in without another request", async (t) => {
        const f = await displayedBeforeInvalidation(t);
        f.reload();
        assert.equal(f.widget(), undefined);

        f.focus("\x1b[O");
        assert.equal(f.widget(), undefined);
        f.focus("\x1b[I");
        assert.equal(f.calls.length, 1);
        assert.ok(f.widget(), "reload must not treat historical display as a mounted widget");
        assert.match(f.widget()!.render(80).join("\n"), /recap · done/);
    });

    test("returning to a cached branch redisplays its recap without leaking it into another branch", async (t) => {
        const f = await displayedBeforeInvalidation(t);
        const cachedLeaf = f.session.getLeafId()!;
        f.runtime.input(f.ctx);
        f.session.appendMessage({
            role: "user",
            content: "Work on a different branch",
            timestamp: Date.now(),
        });
        f.session.appendMessage(response("Different branch result"));
        f.runtime.branchChanged(f.ctx);
        f.focus("\x1b[I");
        assert.equal(f.widget(), undefined);
        assert.equal(f.calls.length, 1);

        f.session.branch(cachedLeaf);
        f.runtime.branchChanged(f.ctx);
        f.focus("\x1b[O");
        assert.equal(f.widget(), undefined);
        f.focus("\x1b[I");
        assert.equal(f.calls.length, 1);
        assert.ok(f.widget(), "returning to a branch must restore its cached widget");
        assert.match(f.widget()!.render(80).join("\n"), /recap · done/);
    });

    test("an equivalent effective thinking setting redisplays the cleared recap without regenerating it", async (t) => {
        const f = await displayedBeforeInvalidation(t);
        // This non-reasoning model clamps both stored values to off.
        await f.manager.set("thinkingLevel", "max");
        assert.equal(f.manager.get("thinkingLevel"), "max");
        assert.equal(f.widget(), undefined);

        f.focus("\x1b[O");
        assert.equal(f.widget(), undefined);
        f.focus("\x1b[I");
        assert.equal(f.calls.length, 1);
        assert.ok(f.widget(), "equivalent request settings must retain a redisplayable cache");
        assert.match(f.widget()!.render(80).join("\n"), /recap · done/);
    });

    test("a restored recap remains hidden during a prompt and redisplays when the prompt closes", async (t) => {
        const f = await displayedBeforeInvalidation(t);
        f.reload();
        f.runtime.prompt(true, f.ctx);
        f.focus("\x1b[I");
        assert.equal(f.widget(), undefined);

        f.runtime.prompt(false, f.ctx);
        assert.equal(f.calls.length, 1);
        assert.ok(f.widget(), "closing the prompt must release the cached recap for display");
        assert.match(f.widget()!.render(80).join("\n"), /recap · done/);
    });

    test("new conversation input cannot redisplay an old cached recap after invalidation", async (t) => {
        const f = await displayedBeforeInvalidation(t);
        f.runtime.input(f.ctx);
        f.session.appendMessage({
            role: "user",
            content: "A new task must not show the previous recap",
            timestamp: Date.now(),
        });

        f.focus("\x1b[I");
        assert.equal(f.widget(), undefined);
        assert.equal(f.calls.length, 1);
        f.runtime.prompt(true, f.ctx);
        f.runtime.prompt(false, f.ctx);
        assert.equal(f.widget(), undefined);
        assert.equal(f.calls.length, 1);
    });
});

describe("terminal focus observation", () => {
    test("fragmented focus reports are observed without consuming input and bracketed paste cannot fake focus", () => {
        const source = new PassThrough();
        const raw: string[] = [];
        const focus: string[] = [];
        source.on("data", (data) => raw.push(String(data)));
        const release = observeTerminalFocus(source, (value) => focus.push(value));
        source.emit("data", "\x1b[");
        source.emit("data", "O");
        source.emit("data", "\x1b[200~\x1b[I\x1b[201~");
        source.emit("data", "\x1b[I");
        assert.deepEqual(focus, ["out", "in"]);
        assert.equal(raw.length, 4);
        release();
        release();
        source.emit("data", "\x1b[O");
        assert.equal(focus.length, 2);
        assert.equal(source.listenerCount("data"), 1);
    });
});

describe("recap model candidates", () => {
    test("virtual models load as selectable candidates", async (t) => {
        const f = await fixture(t);
        const virtual = { ...model, id: "virtual-model", api: "pi-virtual" };
        const context = {
            ...f.ctx,
            modelRegistry: {
                getAvailable: () => [model, virtual],
                getProviderDisplayName: () => "Offline provider",
            },
        } as unknown as ExtensionContext;
        const field = createRecapSection(f.manager).fields.find((field) => field.id === "model")!;
        const choices = await field.choiceSource!.load({
            ...field.choiceContext!(context, "global"),
            signal: new AbortController().signal,
        });
        const entry = choices.find(
            (choice) =>
                choice.value !== null &&
                typeof choice.value === "object" &&
                (choice.value as { id?: string }).id === virtual.id,
        );
        assert.ok(entry, "virtual model should be a candidate");
        const expected = { provider: virtual.provider, id: virtual.id };
        const actual = entry.value;
        assert.deepEqual(actual, expected);
        assert.equal(entry.disabled, undefined);
    });
});

describe("recap input and provider validation", { concurrency: false, timeout: 10000 }, () => {
    test("compacted and edited projection preserves the projected summary while excluding hidden context", async (t) => {
        const f = await fixture(t);
        f.session.appendMessage({
            role: "system",
            content: "PRIVATE SYSTEM",
            timestamp: 1,
        });
        const original = f.session.appendMessage({
            role: "user",
            content: "Original task",
            timestamp: 2,
        });
        const kept = f.session.appendMessage({
            role: "user",
            content: "Latest task",
            timestamp: 3,
        });
        f.session.appendMessage({
            ...response("Visible answer"),
            content: [
                { type: "thinking", thinking: "PRIVATE THINKING" },
                { type: "text", text: "Visible answer" },
            ],
        });
        f.session.appendMessage({
            role: "toolResult",
            toolCallId: "tool",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "PRIVATE FILE CONTENT" }],
            timestamp: 4,
        });
        f.session.appendMessage({
            role: "user",
            content: [
                { type: "text", text: "Screenshot task" },
                { type: "image", data: "PRIVATE IMAGE DATA", mimeType: "image/png" },
            ],
            timestamp: 5,
        });
        f.session.appendCompaction("Compacted task summary", kept, 10000);
        f.session.appendContextEdit(kept, { content: "Edited latest task" });
        const input = collectRecapInput(f.ctx);
        const text = serializeRecapInput(input);
        assert.match(text, /Edited latest task/);
        assert.match(text, /Compacted task summary/);
        assert.match(text, /read: succeeded/);
        assert.match(text, /Screenshot task/);
        assert.doesNotMatch(text, /Original task/);
        assert.doesNotMatch(text, /PRIVATE/);
        assert.equal(JSON.parse(text).recent[0].text, "Edited latest task");
        const key = fingerprintRecapInput(input);
        f.session.appendCustomEntry("pi-recap.v1", { text: "state" });
        assert.equal(fingerprintRecapInput(collectRecapInput(f.ctx)), key);
        f.session.branch(original);
        assert.doesNotMatch(
            serializeRecapInput(collectRecapInput(f.ctx)),
            /Edited latest|Visible answer|read:/,
        );
    });
    test("provider failures are surfaced", async (t) => {
        const f = await fixture(t);
        f.addRound();
        const input = collectRecapInput(f.ctx);
        f.provider(async () => {
            throw new Error("provider offline");
        });
        await assert.rejects(
            generateRecap(f.ctx, input, model, "off", new AbortController().signal),
            /provider offline/,
        );
    });
    test("empty recap output fails", async (t) => {
        const f = await fixture(t);
        f.addRound();
        const input = collectRecapInput(f.ctx);
        f.provider(async () => response(""));
        await assert.rejects(
            generateRecap(f.ctx, input, model, "off", new AbortController().signal),
            /empty/,
        );
    });
    test("non-stop completion fails", async (t) => {
        const f = await fixture(t);
        f.addRound();
        const input = collectRecapInput(f.ctx);
        f.provider(async () => response("partial", "length"));
        await assert.rejects(
            generateRecap(f.ctx, input, model, "off", new AbortController().signal),
            /length/,
        );
    });
    test("virtual models are delegated to the model registry", async (t) => {
        const f = await fixture(t);
        f.addRound();
        const input = collectRecapInput(f.ctx);
        const virtual = { ...model, api: "pi-virtual" };
        const result = await generateRecap(
            f.ctx,
            input,
            virtual,
            "high",
            new AbortController().signal,
        );
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0]!.model.api, "pi-virtual");
        assert.equal(f.calls[0]!.options!.reasoning, "high");
        assert.equal(result.text, "done/");
    });
    test("unknown model limits are not rejected by recap", async (t) => {
        const f = await fixture(t);
        f.addRound();
        const input = collectRecapInput(f.ctx);
        const unknown = { ...model, contextWindow: 0, maxTokens: 0 };
        const result = await generateRecap(
            f.ctx,
            input,
            unknown,
            "off",
            new AbortController().signal,
        );
        assert.ok(f.calls[0]!.options!.maxTokens! > 0);
        assert.equal(result.text, "done/");
    });
    test("an already aborted signal rejects without a provider call", async (t) => {
        const f = await fixture(t);
        f.addRound();
        const input = collectRecapInput(f.ctx);
        const controller = new AbortController();
        controller.abort(new Error("cancelled upstream"));
        await assert.rejects(
            generateRecap(f.ctx, input, model, "off", controller.signal),
            /cancelled upstream/,
        );
        assert.equal(f.calls.length, 0);
    });
    test("sanitization strips terminal commands, produces one line and limits Unicode code points", () => {
        const text = normalizeRecap("\x1b[31m完了\x1b[0m\n次の一手\x00 " + "😀".repeat(500));
        assert.equal(Array.from(text).length, 400);
        assert.doesNotMatch(text, /[\x00-\x1f]/);
        assert.match(text, /^完了 次の一手/);
    });
    test("abort-race preserves cancellation reason even when the provider never settles", async () => {
        const controller = new AbortController();
        const reason = new Error("cancelled");
        const provider = deferred<string>();
        const waiting = withAbort(provider.promise, controller.signal);
        controller.abort(reason);
        await assert.rejects(waiting, (error) => error === reason);
        provider.reject(new Error("late rejection"));
        await assert.rejects(provider.promise, /late rejection/);
    });
});
