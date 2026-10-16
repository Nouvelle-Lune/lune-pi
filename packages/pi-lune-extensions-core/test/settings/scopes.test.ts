import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { getCoreHost } from "../../src/core/host.ts";
import { acquireSettings } from "../../src/settings/advanced.ts";
import { defineSettings, readGlobalSettings } from "../../src/settings/index.ts";
import type { SettingsBackend } from "../../src/settings/backend.ts";
import { createSettingsFixture } from "../harness/settings.ts";

const schema = Type.Object({
    limit: Type.Integer({ default: 10, minimum: 0 }),
    token: Type.String({ default: "" }),
});

test("acquisitions of one live id must agree on schema, version and global-only keys", async (t) => {
    const fixture = await createSettingsFixture(t);
    const base = defineSettings({ id: "shared", schema });
    const first = await fixture.sandbox.acquire(base);

    const differentSchema = Type.Object({
        limit: Type.Integer({ default: 11, minimum: 0 }),
        token: Type.String({ default: "" }),
    });
    const conflicts = {
        schema: defineSettings({ id: "shared", schema: differentSchema }),
        version: defineSettings({ id: "shared", schema, migrations: [(o) => o] }),
        globalOnly: defineSettings({ id: "shared", schema, globalOnly: ["token"] }),
    };
    for (const [reason, definition] of Object.entries(conflicts))
        await assert.rejects(fixture.sandbox.acquire(definition), {
            name: "TypeError",
            message: /Conflicting settings declaration for "shared"/,
        });
    // The conflicting attempt must not disturb the live lease (reason: ${reason}).
    assert.equal(first.settings.get("limit"), 10);

    const same = await fixture.sandbox.acquire(defineSettings({ id: "shared", schema }));
    assert.equal(same.settings.get("limit"), 10);
});

test("untrusted projects ignore project files, expose only the global scope and refuse project writes", async (t) => {
    const fixture = await createSettingsFixture(t);
    await fixture.writeScope("global", { limit: 5 }, "trust");
    // A corrupt project file proves the file is never read, not merely outvoted.
    await fixture.writeRawScope("project", "{ not json", "trust");

    const { settings } = await fixture.acquire("trust", fixture.cwd, schema, {
        projectTrusted: false,
    });

    assert.deepEqual(settings.scopes, ["global"]);
    assert.equal(settings.get("limit"), 5);
    assert.equal(settings.inspect("limit").source, "global");
    assert.deepEqual(settings.field("limit").scopes, ["global"]);
    const message = /Project settings for "trust" are disabled because the project is not trusted/;
    await assert.rejects(settings.set("limit", 1, { scope: "project" }), message);
    await assert.rejects(settings.reset("limit", { scope: "project" }), message);
    await assert.rejects(settings.field("limit").set(1, { scope: "project" }), message);
    assert.equal(await fixture.readRawScope("project", "trust"), "{ not json");
    await settings.set("limit", 6);
    assert.equal(settings.get("limit"), 6);
});

test("trusted projects apply project overrides on top of global values", async (t) => {
    const fixture = await createSettingsFixture(t);
    await fixture.writeScope("global", { limit: 5 }, "trusted");
    await fixture.writeScope("project", { limit: 8 }, "trusted");

    const { settings } = await fixture.acquire("trusted", fixture.cwd, schema);

    assert.deepEqual(settings.scopes, ["global", "project"]);
    assert.equal(settings.get("limit"), 8);
    assert.equal(settings.inspect("limit").source, "project");
    assert.equal(settings.snapshot({ scope: "global" }).limit, 5);
    assert.deepEqual(settings.field("limit").scopes, ["global", "project"]);
    await settings.set("limit", 9, { scope: "project" });
    assert.deepEqual(await fixture.readScope("project", "trusted"), { limit: 9 });
});

test("trusted and untrusted leases share global values but never project values", async (t) => {
    const fixture = await createSettingsFixture(t);
    await fixture.writeScope("project", { limit: 8 }, "mixed");
    const trusted = await fixture.acquire("mixed", fixture.cwd, schema);
    const untrusted = await fixture.acquire("mixed", fixture.cwd, schema, {
        projectTrusted: false,
    });
    const seen: number[] = [];
    untrusted.settings.subscribe(() => seen.push(untrusted.settings.get("limit")));

    assert.equal(trusted.settings.get("limit"), 8);
    assert.equal(untrusted.settings.get("limit"), 10);
    await trusted.settings.set("limit", 3);

    assert.equal(untrusted.settings.get("limit"), 3);
    assert.equal(trusted.settings.get("limit"), 8);
    assert.deepEqual(seen, [3]);
});

test("a backend that leaks a project value to an untrusted lease is rejected by the view", async (t) => {
    const fixture = await createSettingsFixture(t);
    const custom = Type.Object({ limit: Type.Integer({ default: 1 }) });
    const backend: SettingsBackend<typeof custom> = {
        id: "leaky",
        settingSchema: custom as never,
        inspect: () => ({
            defaultValue: 1,
            globalValue: undefined,
            projectValue: 2,
            value: 2,
            source: "project",
        }),
        set: async () => undefined,
        reset: async () => undefined,
        subscribe: () => () => undefined,
        reload: async () => undefined,
    };
    const lease = await acquireSettings(
        defineSettings({
            id: "leaky",
            schema: custom,
            backend: () => ({ backend, release: () => undefined }),
        }),
        { cwd: fixture.cwd, projectTrusted: false },
    );
    t.after(() => lease.release());

    assert.throws(() => lease.settings.get("limit"), /outside its permitted scopes/);
});

test("custom backend factories receive the owning project's cwd and trust decision", async (t) => {
    const fixture = await createSettingsFixture(t);
    const custom = Type.Object({ limit: Type.Integer({ default: 1 }) });
    const contexts: unknown[] = [];
    const definition = defineSettings({
        id: "context",
        schema: custom,
        backend: (context) => {
            contexts.push(context);
            return {
                backend: {
                    id: "context",
                    settingSchema: custom as never,
                    inspect: () => ({
                        defaultValue: 1,
                        globalValue: undefined,
                        projectValue: undefined,
                        value: 1,
                        source: "default",
                    }),
                    set: async () => undefined,
                    reset: async () => undefined,
                    subscribe: () => () => undefined,
                    reload: async () => undefined,
                },
                release: () => undefined,
            };
        },
    });

    for (const projectTrusted of [true, false])
        await (await acquireSettings(definition, { cwd: fixture.cwd, projectTrusted })).release();

    assert.deepEqual(contexts, [
        { cwd: fixture.cwd, projectTrusted: true },
        { cwd: fixture.cwd, projectTrusted: false },
    ]);
});

test("acquireSettings requires an explicit boolean trust decision", async (t) => {
    const fixture = await createSettingsFixture(t);
    const definition = defineSettings({ id: "explicit", schema });
    for (const projectTrusted of [undefined, "true", 1, null])
        await assert.rejects(
            acquireSettings(definition, { cwd: fixture.cwd, projectTrusted } as never),
            {
                name: "TypeError",
                message: "acquireSettings requires an explicit projectTrusted boolean",
            },
        );
});

const withGlobalOnly = (id: string) => defineSettings({ id, schema, globalOnly: ["token"] });

test("a project file containing a global-only key fails validation", async (t) => {
    const fixture = await createSettingsFixture(t);
    await fixture.writeScope("project", { token: "secret" }, "guarded");

    await assert.rejects(fixture.sandbox.acquire(withGlobalOnly("guarded")), {
        name: "TypeError",
        message: /Setting "token" for "guarded" can only be stored globally; remove it from /,
    });
    // The same file is irrelevant once the project is untrusted and therefore unread.
    const untrusted = await fixture.sandbox.acquire(withGlobalOnly("guarded"), {
        projectTrusted: false,
    });
    assert.equal(untrusted.settings.get("token"), "");
});

test("global-only keys are written globally and refuse project writes and project field scopes", async (t) => {
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.sandbox.acquire(withGlobalOnly("guarded-writes"));
    const message = /Setting "token" for "guarded-writes" can only be stored globally/;

    await assert.rejects(settings.set("token", "x", { scope: "project" }), message);
    await assert.rejects(settings.reset("token", { scope: "project" }), message);
    await assert.rejects(settings.field("token").set("x", { scope: "project" }), message);
    await assert.rejects(fixture.readRawScope("project", "guarded-writes"), { code: "ENOENT" });

    await settings.set("token", "secret");
    assert.equal(settings.get("token"), "secret");
    assert.deepEqual(await fixture.readScope("global", "guarded-writes"), { token: "secret" });
    assert.deepEqual(settings.field("token").scopes, ["global"]);
    assert.deepEqual(settings.field("limit").scopes, ["global", "project"]);
    await settings.set("limit", 4, { scope: "project" });
    assert.equal(settings.get("limit"), 4);
});

test("readGlobalSettings returns global values and ignores project files under the process cwd", async (t) => {
    const fixture = await createSettingsFixture(t);
    const definition = defineSettings({ id: "startup", schema });
    await fixture.writeScope("global", { limit: 3 }, "startup");
    // An invalid project file at the process cwd would fail any read that touched it.
    await fixture.writeRawScope("project", "{ not json", "startup");
    const previousCwd = process.cwd();
    process.chdir(fixture.cwd);
    t.after(() => process.chdir(previousCwd));
    const namespaces = getCoreHost().settings.namespaces.size;

    const actual = await readGlobalSettings(definition);

    assert.deepEqual(actual, { limit: 3, token: "" });
    assert.ok(Object.isFrozen(actual));
    assert.equal(getCoreHost().settings.namespaces.size, namespaces);
});

test("readGlobalSettings releases its lease when the global file is invalid", async (t) => {
    const fixture = await createSettingsFixture(t);
    await fixture.writeRawScope("global", "{ not json", "startup-broken");
    const definition = defineSettings({ id: "startup-broken", schema });
    const namespaces = getCoreHost().settings.namespaces.size;

    await assert.rejects(readGlobalSettings(definition), SyntaxError);
    await fixture.writeScope("global", { limit: 2 }, "startup-broken");

    assert.equal((await readGlobalSettings(definition)).limit, 2);
    assert.equal(getCoreHost().settings.namespaces.size, namespaces);
});

test("releasing a lease waits for failed in-flight operations without rethrowing their errors", async (t) => {
    const fixture = await createSettingsFixture(t);
    const custom = Type.Object({ enabled: Type.Boolean({ default: true }) });
    let failWrite!: (error: Error) => void;
    const writeResult = new Promise<void>((_, reject) => {
        failWrite = reject;
    });
    let backendReleases = 0;
    const backend: SettingsBackend<typeof custom> = {
        id: "failing-write",
        settingSchema: custom as never,
        inspect: () => ({
            defaultValue: true,
            globalValue: undefined,
            projectValue: undefined,
            value: true,
            source: "default",
        }),
        set: () => writeResult,
        reset: async () => undefined,
        subscribe: () => () => undefined,
        reload: async () => undefined,
    };
    const lease = await acquireSettings(
        defineSettings({
            id: "failing-write",
            schema: custom,
            backend: () => ({ backend, release: () => void backendReleases++ }),
        }),
        { cwd: fixture.cwd, projectTrusted: true },
    );

    const write = lease.settings.set("enabled", false);
    const release = lease.release();
    failWrite(new Error("write failed"));

    await assert.rejects(write, /write failed/);
    await assert.doesNotReject(release);
    assert.equal(backendReleases, 1);
});

test("a failing backend release is reported as a cleanup aggregate", async (t) => {
    const fixture = await createSettingsFixture(t);
    const custom = Type.Object({ enabled: Type.Boolean({ default: true }) });
    const failure = new Error("release failed");
    const backend: SettingsBackend<typeof custom> = {
        id: "failing-release",
        settingSchema: custom as never,
        inspect: () => ({
            defaultValue: true,
            globalValue: undefined,
            projectValue: undefined,
            value: true,
            source: "default",
        }),
        set: async () => undefined,
        reset: async () => undefined,
        subscribe: () => () => undefined,
        reload: async () => undefined,
    };
    const lease = await acquireSettings(
        defineSettings({
            id: "failing-release",
            schema: custom,
            backend: () => ({
                backend,
                release() {
                    throw failure;
                },
            }),
        }),
        { cwd: fixture.cwd, projectTrusted: true },
    );

    await assert.rejects(lease.release(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Settings lease "failing-release" cleanup failed/);
        assert.deepEqual(error.errors, [failure]);
        return true;
    });
});
