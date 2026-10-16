import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { bindSettings, defineSettings, assertSettingsSchema } from "../../src/settings/index.ts";
import { observeSettingsBinding, type SettingsBindingState } from "../../src/settings/binding.ts";
import type { SettingsBackend } from "../../src/settings/backend.ts";
import { defineSettingsPanel, registerSettingsPanel } from "../../src/panel/index.ts";
import { getSettingsPanelRegistry } from "../../src/panel/host.ts";
import { createSettingsFixture } from "../harness/settings.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function fakePi(options: { fail?: string; onUnsubscribe?(): void } = {}) {
    const handlers = new Map<string, Set<Handler>>();
    const pi = {
        on(name: string, handler: Handler) {
            if (name === options.fail) throw new Error("registration failed");
            const list = handlers.get(name) ?? new Set<Handler>();
            list.add(handler);
            handlers.set(name, list);
            return () => {
                list.delete(handler);
                options.onUnsubscribe?.();
            };
        },
    } as unknown as ExtensionAPI;
    return {
        pi,
        count: (name: string) => handlers.get(name)?.size ?? 0,
        async emit(name: string, ctx: ExtensionContext) {
            for (const handler of [...(handlers.get(name) ?? [])])
                await handler({ type: name }, ctx);
        },
    };
}
function context(cwd: string, mode = "tui", projectTrusted = true) {
    return {
        cwd,
        mode,
        ui: {},
        isProjectTrusted: () => projectTrusted,
        sessionManager: SessionManager.inMemory(cwd),
    } as unknown as ExtensionContext;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const schema = Type.Object({ enabled: Type.Boolean({ default: true }) });
function backend(id: string): SettingsBackend<typeof schema> {
    assertSettingsSchema(schema);
    let value = true;
    return {
        id,
        settingSchema: schema,
        inspect: () => ({
            defaultValue: true,
            globalValue: value,
            projectValue: undefined,
            value,
            source: "global",
        }),
        set: async (_key, next) => {
            value = next;
        },
        reset: async () => {
            value = true;
        },
        reload: async () => {},
        subscribe: () => () => {},
    };
}

test("bindings acquire without UI, return one current view and leave other bindings alive on release", async (t) => {
    const fixture = await createSettingsFixture(t);
    const ctx = context(fixture.cwd);
    const bridge = fakePi();
    const definition = defineSettings({ id: "binding-values", schema });
    const first = bindSettings(bridge.pi, definition),
        second = bindSettings(bridge.pi, definition);
    t.after(() => first.dispose());
    t.after(() => second.dispose());
    await assert.rejects(first.view(ctx), /have not started/);
    await bridge.emit("session_start", ctx);
    const view = await first.view(ctx);
    assert.strictEqual(await first.view({ ...ctx }), view);
    await view.set("enabled", false);
    assert.equal((await second.view(ctx)).get("enabled"), false);
    await assert.rejects(first.view(context(fixture.cwd)), /does not belong/);
    await first.dispose();
    assert.equal(view.signal.aborted, true);
    assert.throws(() => view.get("enabled"), /released/);
    await assert.rejects(first.view(ctx), { name: "AbortError" });
    await (await second.view(ctx)).set("enabled", true);
    assert.equal((await second.view(ctx)).get("enabled"), true);
    assert.equal(getSettingsPanelRegistry().getSections(ctx.ui).length, 0);
});

test("repeated native startup retires the previous view and independent Panel registration mounts its replacement", async (t) => {
    const fixture = await createSettingsFixture(t);
    const ctx = context(fixture.cwd);
    const bridge = fakePi();
    const definition = defineSettings({ id: "binding-panel", schema });
    const binding = bindSettings(bridge.pi, definition);
    const registration = registerSettingsPanel(
        defineSettingsPanel(definition, { label: "Binding" }),
        binding,
    );
    t.after(() => registration.dispose());
    t.after(() => binding.dispose());
    assert.equal(bridge.count("session_start"), 1);
    assert.equal(bridge.count("session_shutdown"), 1);
    await bridge.emit("session_start", ctx);
    const first = await binding.view(ctx);
    const firstSection = getSettingsPanelRegistry().getSections(ctx.ui)[0];
    assert.ok(firstSection);
    await bridge.emit("session_start", ctx);
    assert.equal(first.signal.aborted, true);
    assert.notStrictEqual(await binding.view(ctx), first);
    const currentSection = getSettingsPanelRegistry().getSections(ctx.ui)[0];
    assert.notStrictEqual(currentSection, firstSection);
    assert.equal(currentSection!.fields[0]!.inspect().value, true);
    await registration.dispose();
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
    assert.equal((await binding.view(ctx)).get("enabled"), true);
    assert.equal(bridge.count("session_start"), 1);
    assert.equal(bridge.count("session_shutdown"), 1);
    await bridge.emit("session_shutdown", ctx);
    assert.equal(binding.signal.aborted, true);
});

for (const mode of ["rpc", "print"])
    test(`${mode} bindings work without creating terminal Panel sections`, async (t) => {
        const fixture = await createSettingsFixture(t);
        const ctx = context(fixture.cwd, mode);
        const bridge = fakePi();
        const definition = defineSettings({ id: `binding-${mode}`, schema });
        const binding = bindSettings(bridge.pi, definition);
        const registration = registerSettingsPanel(
            defineSettingsPanel(definition, { label: mode }),
            binding,
        );
        t.after(() => registration.dispose());
        t.after(() => binding.dispose());
        await bridge.emit("session_start", ctx);
        assert.equal((await binding.view(ctx)).get("enabled"), true);
        assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
    });

test("shutdown during acquisition rejects late access, waits for ownership and releases the backend once", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi();
    const ctx = context(fixture.cwd);
    const acquisition = deferred<{ backend: SettingsBackend<typeof schema>; release(): void }>();
    const entered = deferred<void>();
    let releases = 0;
    const binding = bindSettings(
        bridge.pi,
        defineSettings({
            id: "late",
            schema,
            backend: () => {
                entered.resolve();
                return acquisition.promise;
            },
        }),
    );
    const registration = registerSettingsPanel(
        defineSettingsPanel(binding.definition, { label: "Late" }),
        binding,
    );
    t.after(() => registration.dispose());
    const startup = bridge.emit("session_start", ctx);
    const access = binding.view(ctx);
    const rejectedStart = assert.rejects(startup, { name: "AbortError" });
    const rejectedAccess = assert.rejects(access, { name: "AbortError" });
    await entered.promise;
    let finished = false;
    const shutdown = binding.dispose();
    assert.strictEqual(binding.dispose(), shutdown);
    void shutdown.then(() => {
        finished = true;
    });
    assert.equal(binding.signal.aborted, true);
    assert.equal(finished, false);
    acquisition.resolve({
        backend: backend("late"),
        release: () => {
            releases++;
        },
    });
    await shutdown;
    await rejectedStart;
    await rejectedAccess;
    assert.equal(releases, 1);
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
    assert.equal(bridge.count("session_start"), 0);
    assert.equal(bridge.count("session_shutdown"), 0);
});

test("configuration failure stays observable, mounts only an unavailable Panel and never retries silently", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    let attempts = 0;
    const definition = defineSettings({
        id: "failed",
        schema,
        backend: () => {
            attempts++;
            throw new Error("configuration unavailable");
        },
    });
    const binding = bindSettings(bridge.pi, definition);
    const registration = registerSettingsPanel(
        defineSettingsPanel(definition, { label: "Failed" }),
        binding,
    );
    t.after(() => registration.dispose());
    t.after(() => binding.dispose());
    await assert.rejects(bridge.emit("session_start", ctx), /configuration unavailable/);
    await assert.rejects(binding.view(ctx), /configuration unavailable/);
    assert.equal(attempts, 1);
    const sections = getSettingsPanelRegistry().getSections(ctx.ui);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.unavailable, "configuration unavailable");
    assert.deepEqual(sections[0]!.fields, []);
});

test("a mismatched Panel cannot borrow another definition or close its Settings", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const binding = bindSettings(bridge.pi, defineSettings({ id: "owner", schema }));
    t.after(() => binding.dispose());
    assert.throws(
        () =>
            registerSettingsPanel(
                defineSettingsPanel(defineSettings({ id: "other", schema }), { label: "Other" }),
                binding,
            ),
        /do not match/,
    );
    await bridge.emit("session_start", ctx);
    assert.equal((await binding.view(ctx)).get("enabled"), true);
});

test("duplicate Panel ownership rejects the newcomer while retaining the first registration", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const definition = defineSettings({ id: "duplicate", schema });
    const binding = bindSettings(bridge.pi, definition);
    const panel = defineSettingsPanel(definition, { label: "Duplicate" });
    const first = registerSettingsPanel(panel, binding);
    const second = registerSettingsPanel(panel, binding);
    t.after(() => second.dispose());
    t.after(() => first.dispose());
    t.after(() => binding.dispose());
    await assert.rejects(bridge.emit("session_start", ctx), /Duplicate settings section/);
    assert.equal(getSettingsPanelRegistry().getSections(ctx.ui).length, 1);
    await second.dispose();
    assert.equal(getSettingsPanelRegistry().getSections(ctx.ui).length, 1);
    assert.equal((await binding.view(ctx)).get("enabled"), true);
});

test("Settings setup cleans earlier listeners when a native registration fails", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi({ fail: "session_shutdown" });
    assert.throws(
        () => bindSettings(bridge.pi, defineSettings({ id: "partial", schema })),
        /registration failed/,
    );
    assert.equal(bridge.count("session_start"), 0);
});

test("shutdown reports a late backend release failure and preserves one release invocation", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const pending = deferred<{ backend: SettingsBackend<typeof schema>; release(): void }>();
    const entered = deferred<void>();
    const failure = new Error("backend release failed");
    let releases = 0;
    const binding = bindSettings(
        bridge.pi,
        defineSettings({
            id: "late-release-error",
            schema,
            backend: () => {
                entered.resolve();
                return pending.promise;
            },
        }),
    );
    const startup = bridge.emit("session_start", ctx);
    const startupError = assert.rejects(
        startup,
        (error) => error instanceof AggregateError && error.errors.includes(failure),
    );
    await entered.promise;
    const cleanup = binding.dispose();
    const cleanupError = assert.rejects(
        cleanup,
        (error) =>
            error instanceof AggregateError &&
            error.errors.some(
                (item) => item instanceof AggregateError && item.errors.includes(failure),
            ),
    );
    pending.resolve({
        backend: backend("late-release-error"),
        release() {
            releases++;
            throw failure;
        },
    });
    await startupError;
    await cleanupError;
    assert.equal(releases, 1);
    assert.strictEqual(binding.dispose(), cleanup);
});

test("acquisition and failed rollback keep both causes and expose cleanup failure on disposal", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const failure = new Error("rollback failed");
    let releases = 0;
    const binding = bindSettings(
        bridge.pi,
        defineSettings({
            id: "rollback-error",
            schema,
            backend: () => ({
                backend: backend("mismatched"),
                release() {
                    releases++;
                    throw failure;
                },
            }),
        }),
    );
    await assert.rejects(
        bridge.emit("session_start", ctx),
        (error) =>
            error instanceof AggregateError &&
            error.errors.some((item) => item instanceof TypeError) &&
            error.errors.includes(failure),
    );
    await assert.rejects(
        binding.dispose(),
        (error) => error instanceof AggregateError && error.errors.includes(failure),
    );
    assert.equal(releases, 1);
});

test("Panel saves cleanup errors after binding retirement and reports them through its own disposal", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const definition = defineSettings({ id: "panel-cleanup-error", schema });
    const binding = bindSettings(bridge.pi, definition);
    const registration = registerSettingsPanel(
        defineSettingsPanel(definition, { label: "Error" }),
        binding,
    );
    let fail = false;
    const failure = new Error("registry observer failed");
    const unsubscribe = getSettingsPanelRegistry().subscribe(ctx.ui, () => {
        if (fail) throw failure;
    });
    t.after(unsubscribe);
    await bridge.emit("session_start", ctx);
    fail = true;
    await binding.dispose();
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
    await assert.rejects(
        registration.dispose(),
        (error) =>
            error instanceof AggregateError &&
            error.errors.some(
                (item) => item instanceof AggregateError && item.errors.includes(failure),
            ),
    );
    assert.equal(bridge.count("session_shutdown"), 0);
});

test("registration after startup mounts immediately and a failed duplicate observation leaves no subscription", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const definition = defineSettings({ id: "late-panel", schema });
    const binding = bindSettings(bridge.pi, definition);
    const panel = defineSettingsPanel(definition, { label: "Late Panel" });
    t.after(() => binding.dispose());
    await bridge.emit("session_start", ctx);
    const registration = registerSettingsPanel(panel, binding);
    t.after(() => registration.dispose());
    const firstSection = getSettingsPanelRegistry().getSections(ctx.ui)[0];
    assert.ok(firstSection);
    assert.equal(firstSection.fields[0]!.inspect().value, true);
    assert.throws(() => registerSettingsPanel(panel, binding), /Duplicate settings section/);
    await bridge.emit("session_start", ctx);
    const actual = getSettingsPanelRegistry().getSections(ctx.ui);
    assert.equal(actual.length, 1);
    assert.notStrictEqual(actual[0], firstSection);
    await binding.dispose();
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
    assert.throws(() => registerSettingsPanel(panel, binding), { name: "AbortError" });
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
});

test("replacement and binding disposal unmount Panel before view retirement and backend release", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const pending = deferred<void>(),
        entered = deferred<void>();
    t.after(() => pending.resolve());
    const order: string[] = [];
    let attempts = 0;
    const definition = defineSettings({
        id: "retirement-order",
        schema,
        backend: async () => {
            if (++attempts === 2) {
                entered.resolve();
                await pending.promise;
            }
            return {
                backend: backend("retirement-order"),
                release() {
                    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
                    order.push("backend");
                },
            };
        },
    });
    const binding = bindSettings(bridge.pi, definition);
    const registration = registerSettingsPanel(
        defineSettingsPanel(definition, { label: "Order" }),
        binding,
    );
    t.after(() => registration.dispose());
    t.after(() => binding.dispose());
    await bridge.emit("session_start", ctx);
    let view = await binding.view(ctx);
    const observeRetirement = () =>
        view.signal.addEventListener(
            "abort",
            () => {
                assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
                order.push("view");
            },
            { once: true },
        );
    observeRetirement();
    const unsubscribe = getSettingsPanelRegistry().subscribe(ctx.ui, () => {
        if (getSettingsPanelRegistry().getSections(ctx.ui).length) return;
        assert.equal(view.signal.aborted, false);
        assert.equal(view.get("enabled"), true);
        order.push("panel");
    });
    t.after(unsubscribe);
    const startup = bridge.emit("session_start", ctx);
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
    await entered.promise;
    assert.deepEqual(order, ["panel", "view", "backend"]);
    pending.resolve();
    await startup;
    view = await binding.view(ctx);
    observeRetirement();
    await binding.dispose();
    const expected = ["panel", "view", "backend", "panel", "view", "backend"];
    assert.deepEqual(order, expected);
});

test("disposing Panel during acquisition stops future mounting without retiring Settings or its Pi hooks", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const pending = deferred<void>(),
        entered = deferred<void>();
    t.after(() => pending.resolve());
    let attempts = 0;
    const definition = defineSettings({
        id: "panel-dispose-race",
        schema,
        backend: async () => {
            if (++attempts === 1) {
                entered.resolve();
                await pending.promise;
            }
            return { backend: backend("panel-dispose-race"), release() {} };
        },
    });
    const binding = bindSettings(bridge.pi, definition);
    const registration = registerSettingsPanel(
        defineSettingsPanel(definition, { label: "Race" }),
        binding,
    );
    t.after(() => registration.dispose());
    t.after(() => binding.dispose());
    const startup = bridge.emit("session_start", ctx);
    await entered.promise;
    const disposal = registration.dispose();
    assert.strictEqual(registration.dispose(), disposal);
    await disposal;
    assert.equal(binding.signal.aborted, false);
    assert.equal(bridge.count("session_start"), 1);
    assert.equal(bridge.count("session_shutdown"), 1);
    pending.resolve();
    await startup;
    assert.equal((await binding.view(ctx)).get("enabled"), true);
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
    await bridge.emit("session_start", ctx);
    assert.equal(attempts, 2);
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
});

test("a replaced pending acquisition releases its late backend and only the current view mounts", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const pending = deferred<void>(),
        entered = deferred<void>();
    t.after(() => pending.resolve());
    let attempts = 0,
        releases = 0;
    const definition = defineSettings({
        id: "pending-replacement",
        schema,
        backend: async () => {
            if (++attempts === 1) {
                entered.resolve();
                await pending.promise;
            }
            return {
                backend: backend("pending-replacement"),
                release() {
                    releases++;
                },
            };
        },
    });
    const binding = bindSettings(bridge.pi, definition);
    const registration = registerSettingsPanel(
        defineSettingsPanel(definition, { label: "Replacement" }),
        binding,
    );
    t.after(() => registration.dispose());
    t.after(() => binding.dispose());
    const firstStart = bridge.emit("session_start", ctx);
    const rejectedStart = assert.rejects(firstStart, { name: "AbortError" });
    await entered.promise;
    const secondStart = bridge.emit("session_start", ctx);
    const currentView = binding.view(ctx);
    pending.resolve();
    await rejectedStart;
    await secondStart;
    assert.equal(attempts, 2);
    assert.equal(releases, 1);
    assert.equal((await currentView).signal.aborted, false);
    assert.equal(getSettingsPanelRegistry().getSections(ctx.ui).length, 1);
    await binding.dispose();
    assert.equal(releases, 2);
    assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
});

test("failed replacement replaces the old Panel with an unavailable one and Settings failure stays observable", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    let attempts = 0;
    const definition = defineSettings({
        id: "failed-replacement",
        schema,
        backend: () => {
            if (++attempts === 2) throw new Error("replacement unavailable");
            return { backend: backend("failed-replacement"), release() {} };
        },
    });
    const binding = bindSettings(bridge.pi, definition);
    const registration = registerSettingsPanel(
        defineSettingsPanel(definition, { label: "Failure" }),
        binding,
    );
    t.after(() => registration.dispose());
    t.after(() => binding.dispose());
    await bridge.emit("session_start", ctx);
    const oldView = await binding.view(ctx);
    await assert.rejects(bridge.emit("session_start", ctx), /replacement unavailable/);
    assert.equal(oldView.signal.aborted, true);
    await assert.rejects(binding.view(ctx), /replacement unavailable/);
    assert.equal(attempts, 2);
    const sections = getSettingsPanelRegistry().getSections(ctx.ui);
    assert.deepEqual(
        sections.map(({ unavailable }) => unavailable),
        ["replacement unavailable"],
    );
});

for (const owner of ["binding", "panel"])
    test(`synchronous ${owner} disposal from a registry observer cannot leave a mounted section`, async (t) => {
        const fixture = await createSettingsFixture(t);
        const bridge = fakePi(),
            ctx = context(fixture.cwd);
        const definition = defineSettings({ id: `reentrant-${owner}`, schema });
        const binding = bindSettings(bridge.pi, definition);
        const registration = registerSettingsPanel(
            defineSettingsPanel(definition, { label: "Reentrant" }),
            binding,
        );
        t.after(() => registration.dispose());
        t.after(() => binding.dispose());
        let disposal: Promise<void> | undefined;
        const unsubscribe = getSettingsPanelRegistry().subscribe(ctx.ui, () => {
            if (getSettingsPanelRegistry().getSections(ctx.ui).length)
                disposal = owner === "binding" ? binding.dispose() : registration.dispose();
        });
        t.after(unsubscribe);
        await bridge.emit("session_start", ctx);
        assert.ok(disposal);
        await disposal;
        assert.deepEqual(getSettingsPanelRegistry().getSections(ctx.ui), []);
        if (owner === "binding") {
            await assert.rejects(binding.view(ctx), { name: "AbortError" });
            assert.equal(bridge.count("session_start"), 0);
        } else {
            assert.equal((await binding.view(ctx)).get("enabled"), true);
            assert.equal(bridge.count("session_start"), 1);
        }
    });

function observe<T extends import("typebox").TObject>(
    binding: ReturnType<typeof bindSettings<T>>,
    t: import("node:test").TestContext,
) {
    const states: (SettingsBindingState<T> | undefined)[] = [];
    t.after(observeSettingsBinding(binding, (state) => states.push(state)));
    return states;
}

test("a failed first acquisition publishes a failed state whose retry reaches ready after repair", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const definition = defineSettings({ id: "retry-ready", schema });
    await fixture.writeRawScope("global", "{ not json", "retry-ready");
    const binding = bindSettings(bridge.pi, definition);
    t.after(() => binding.dispose());
    const states = observe(binding, t);

    await assert.rejects(bridge.emit("session_start", ctx), SyntaxError);

    const failed = states.at(-1);
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.status === "failed" && failed.error instanceof SyntaxError);
    assert.strictEqual(failed.context, ctx);
    await assert.rejects(binding.view(ctx), SyntaxError);

    await fixture.writeScope("global", { enabled: false }, "retry-ready");
    await failed.retry();

    const ready = states.at(-1);
    assert.equal(ready?.status, "ready");
    assert.ok(ready?.status === "ready");
    assert.equal(ready.view.get("enabled"), false);
    assert.strictEqual(await binding.view(ctx), ready.view);
});

test("retry rethrows a repeated failure and publishes a fresh failed state", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    const definition = defineSettings({ id: "retry-again", schema });
    await fixture.writeRawScope("global", "{ not json", "retry-again");
    const binding = bindSettings(bridge.pi, definition);
    t.after(() => binding.dispose());
    const states = observe(binding, t);
    await assert.rejects(bridge.emit("session_start", ctx), SyntaxError);
    const first = states.at(-1);
    assert.equal(first?.status, "failed");

    await assert.rejects((first as { retry(): Promise<void> }).retry(), SyntaxError);

    const second = states.at(-1);
    assert.equal(second?.status, "failed");
    assert.notStrictEqual(second, first);
});

test("retry from a superseded or shut down session rejects without acquiring", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    let attempts = 0;
    const definition = defineSettings({
        id: "retry-stale",
        schema,
        backend: () => {
            attempts++;
            throw new Error("unavailable");
        },
    });
    const binding = bindSettings(bridge.pi, definition);
    t.after(() => binding.dispose());
    const states = observe(binding, t);

    await assert.rejects(bridge.emit("session_start", ctx), /unavailable/);
    const firstSession = states.at(-1) as Extract<
        SettingsBindingState<typeof schema>,
        { status: "failed" }
    >;
    await assert.rejects(bridge.emit("session_start", context(fixture.cwd)), /unavailable/);
    assert.equal(attempts, 2);
    await assert.rejects(firstSession.retry(), { name: "AbortError" });
    assert.equal(attempts, 2);

    const secondSession = states.at(-1) as typeof firstSession;
    await bridge.emit("session_shutdown", ctx);
    await assert.rejects(secondSession.retry(), { name: "AbortError" });
    assert.equal(attempts, 2);
});

test("a failed binding mounts an unavailable section with the full error chain and retries on reload", async (t) => {
    const fixture = await createSettingsFixture(t);
    const bridge = fakePi(),
        ctx = context(fixture.cwd);
    let broken = true;
    const definition = defineSettings({
        id: "unavailable-panel",
        schema,
        migrations: [
            (overrides) => {
                if (broken) throw new Error("boom");
                return overrides;
            },
        ],
    });
    await fixture.writeScope("global", { enabled: false }, "unavailable-panel");
    const binding = bindSettings(bridge.pi, definition);
    const registration = registerSettingsPanel(
        defineSettingsPanel(definition, { label: "Unavailable" }),
        binding,
    );
    t.after(() => registration.dispose());
    t.after(() => binding.dispose());
    const registry = getSettingsPanelRegistry();

    await assert.rejects(bridge.emit("session_start", ctx), /Settings migration 1 -> 2/);

    const [failed] = registry.getSections(ctx.ui);
    assert.ok(failed);
    assert.equal(failed.id, "unavailable-panel");
    assert.deepEqual(failed.fields, []);
    assert.deepEqual(failed.scopes, []);
    assert.match(
        failed.unavailable!,
        /Settings migration 1 -> 2 for "unavailable-panel" failed on .*: boom$/,
    );

    await assert.rejects(failed.reload(), /Settings migration 1 -> 2/);
    assert.match(registry.getSections(ctx.ui)[0]!.unavailable!, /: boom$/);

    broken = false;
    await registry.getSections(ctx.ui)[0]!.reload();

    const [ready] = registry.getSections(ctx.ui);
    assert.equal(ready!.unavailable, undefined);
    assert.deepEqual(
        ready!.fields.map(({ id }) => id),
        ["enabled"],
    );
    assert.equal(ready!.fields[0]!.inspect().value, false);
    assert.deepEqual(ready!.scopes, ["global", "project"]);
});
