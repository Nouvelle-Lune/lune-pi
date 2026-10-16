import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { acquireSettings } from "../../src/settings/advanced.ts";
import {
    defineSettings,
    SettingsNotificationError,
    isSettingsNotificationError,
} from "../../src/settings/index.ts";
import type { SettingsBackend } from "../../src/settings/backend.ts";
import { createSettingsFixture } from "../harness/settings.ts";

test("settings views return isolated defaults and immutable point-in-time snapshots", async (t) => {
    // Reads and snapshots must not expose mutable backend state or change after later writes.
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();

    assert.equal(settings.id, "example");
    assert.equal(settings.get("maxItems"), 10);
    assert.deepEqual(settings.inspect("maxItems"), {
        defaultValue: 10,
        globalValue: undefined,
        projectValue: undefined,
        value: 10,
        source: "default",
    });

    const firstSnapshot = settings.snapshot();
    assert.deepEqual(firstSnapshot.appearance, { color: "blue", density: "compact" });
    assert.ok(Object.isFrozen(firstSnapshot));
    assert.ok(Object.isFrozen(firstSnapshot.appearance));
    assert.equal(Reflect.set(firstSnapshot.appearance, "color", "mutated"), false);
    assert.notStrictEqual(settings.snapshot(), firstSnapshot);

    settings.get("items").push("mutated read");
    await settings.set("appearance", { color: "green", density: "cozy" });

    assert.deepEqual(settings.get("items"), ["initial"]);
    assert.deepEqual(firstSnapshot.appearance, { color: "blue", density: "compact" });
    assert.deepEqual(settings.snapshot().appearance, { color: "green", density: "cozy" });
});

test("settings views hide backend schema and transaction primitives while nested edits remain available", async (t) => {
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();

    assert.equal("settingSchema" in settings, false);
    assert.equal("update" in settings, false);
    const checkTypes = () => ({
        // @ts-expect-error Storage schemas belong to the backend SPI.
        schema: settings.settingSchema,
        // @ts-expect-error Consumers edit nested values through field bindings.
        update: settings.update,
    });
    void checkTypes;

    await settings.field(["appearance", "color"]).set("purple");
    assert.deepEqual(settings.get("appearance"), { color: "purple", density: "compact" });
});

test("custom backend factories can be synchronous or asynchronous and transfer release ownership", async (t) => {
    // Both factory forms transfer one backend lease to the returned settings lease.
    const fixture = await createSettingsFixture(t);
    const schema = Type.Object({ enabled: Type.Boolean({ default: true }) });
    const makeBackend = (id: string): SettingsBackend<typeof schema> => ({
        id,
        settingSchema: schema as never,
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
    });
    const releases: string[] = [];
    const syncBackend = makeBackend("sync-factory");
    const asyncBackend = makeBackend("async-factory");
    const syncLease = await acquireSettings(
        defineSettings({
            id: "sync-factory",
            schema,
            backend: () => ({
                backend: syncBackend,
                release() {
                    releases.push("sync");
                },
            }),
        }),
        { cwd: fixture.cwd, projectTrusted: true },
    );
    const asyncLease = await acquireSettings(
        defineSettings({
            id: "async-factory",
            schema,
            backend: async () => ({
                backend: asyncBackend,
                release() {
                    releases.push("async");
                },
            }),
        }),
        { cwd: fixture.cwd, projectTrusted: true },
    );

    assert.equal(syncLease.settings.get("enabled"), true);
    assert.equal(asyncLease.settings.get("enabled"), true);
    await Promise.all([syncLease.release(), asyncLease.release()]);

    assert.deepEqual(releases.sort(), ["async", "sync"]);
});

test("settings acquisition releases custom backends whose IDs or schemas do not match", async (t) => {
    // A rejected factory result still transfers cleanup responsibility to acquireSettings.
    const fixture = await createSettingsFixture(t);
    const schema = Type.Object({ enabled: Type.Boolean({ default: true }) });
    const otherSchema = Type.Object({ label: Type.String({ default: "other" }) });
    const makeBackend = (id: string, settingSchema: unknown): SettingsBackend<typeof schema> => ({
        id,
        settingSchema: settingSchema as never,
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
    });

    for (const invalid of [
        { definitionId: "wrong-id", backend: makeBackend("different-id", schema) },
        { definitionId: "wrong-schema", backend: makeBackend("wrong-schema", otherSchema) },
    ]) {
        let releaseCount = 0;
        const definition = defineSettings({
            id: invalid.definitionId,
            schema,
            backend: () => ({
                backend: invalid.backend,
                release() {
                    releaseCount++;
                },
            }),
        });

        await assert.rejects(
            acquireSettings(definition, { cwd: fixture.cwd, projectTrusted: true }),
            /Backend does not match settings definition/,
        );
        assert.equal(releaseCount, 1);
    }
});

test("backends without atomic updates reject nested edits but retain top-level operations", async (t) => {
    // Nested writes require an atomic backend transaction, while ordinary setting keys remain usable.
    const fixture = await createSettingsFixture(t);
    const schema = Type.Object({
        enabled: Type.Boolean({ default: true }),
        preferences: Type.Object(
            { label: Type.String({ default: "default" }) },
            { default: { label: "default" } },
        ),
    });
    const values = { enabled: true, preferences: { label: "default" } };
    const backend: SettingsBackend<typeof schema> = {
        id: "non-transactional",
        settingSchema: schema as never,
        inspect: (key) =>
            ({
                defaultValue: key === "enabled" ? true : { label: "default" },
                globalValue: undefined,
                projectValue: undefined,
                value: values[key],
                source: "default",
            }) as never,
        set: async (key, value) => {
            values[key] = value as never;
        },
        reset: async () => undefined,
        subscribe: () => () => undefined,
        reload: async () => undefined,
    };
    const lease = await acquireSettings(
        defineSettings({
            id: "non-transactional",
            schema,
            backend: () => ({ backend, release: () => undefined }),
        }),
        { cwd: fixture.cwd, projectTrusted: true },
    );
    t.after(() => lease.release());

    assert.throws(
        () => lease.settings.field(["preferences", "label"] as const),
        /does not support atomic nested settings edits/,
    );
    await lease.settings.set("enabled", false);
    assert.equal(lease.settings.get("enabled"), false);
});

test("global and project snapshots preserve precedence for nullable and falsy overrides", async (t) => {
    // Explicit null, false, empty text, and zero remain values instead of selecting defaults.
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();

    await settings.set("maxItems", 0);
    await settings.set("label", null);
    await settings.set("enabled", false);
    await settings.set("maxItems", 5, { scope: "project" });
    await settings.set("label", "", { scope: "project" });

    assert.equal(settings.get("maxItems"), 5);
    assert.equal(settings.inspect("maxItems").globalValue, 0);
    assert.equal(settings.inspect("label").value, "");
    assert.equal(settings.inspect("enabled").value, false);
    assert.equal(settings.snapshot({ scope: "global" }).maxItems, 0);
    assert.equal(settings.snapshot({ scope: "global" }).label, null);
    assert.equal(settings.snapshot({ scope: "project" }).maxItems, 5);
    assert.equal(settings.snapshot({ scope: "project" }).enabled, false);

    await settings.reset("maxItems", { scope: "project" });
    assert.equal(settings.get("maxItems"), 0);
    await settings.reset("maxItems");
    assert.equal(settings.get("maxItems"), 10);
    assert.equal(settings.inspect("maxItems").source, "default");
});

test("each lease owns its view and subscriptions while sharing committed settings", async (t) => {
    // Releasing one same-key lease invalidates only its view and cannot close another lease.
    const fixture = await createSettingsFixture(t);
    const first = await fixture.acquire();
    const second = await fixture.acquire();
    const seenFirst: number[] = [];
    const seenSecond: number[] = [];
    first.settings.subscribe(() => seenFirst.push(first.settings.get("maxItems")));
    second.settings.subscribe(() => seenSecond.push(second.settings.get("maxItems")));

    await first.settings.set("maxItems", 20);
    assert.deepEqual(seenFirst, [20]);
    assert.deepEqual(seenSecond, [20]);

    const releaseResult = first.release();
    assert.strictEqual(first.release(), releaseResult);
    await releaseResult;
    assert.throws(() => first.settings.get("maxItems"), /lease "example" is released/);
    assert.throws(() => first.settings.set("maxItems", 30), /lease "example" is released/);

    await second.settings.set("maxItems", 40);
    assert.deepEqual(seenFirst, [20]);
    assert.deepEqual(seenSecond, [20, 40]);
    assert.equal(second.settings.get("maxItems"), 40);

    await second.release();
    const replacement = await fixture.acquire();
    assert.notStrictEqual(replacement.settings, second.settings);
    assert.equal(replacement.settings.get("maxItems"), 40);
});

test("global changes notify every live project view sharing the namespace", async (t) => {
    // A global commit refreshes all project entries before notifying, while project commits stay local.
    const fixture = await createSettingsFixture(t);
    const first = await fixture.acquire("example", fixture.cwd);
    const second = await fixture.acquire("example", `${fixture.root}/other-project`);
    const firstSeen: number[] = [];
    const secondSeen: number[] = [];
    first.settings.subscribe(() => firstSeen.push(first.settings.get("maxItems")));
    second.settings.subscribe(() => secondSeen.push(second.settings.get("maxItems")));

    await second.settings.set("maxItems", 25);
    assert.deepEqual(firstSeen, [25]);
    assert.deepEqual(secondSeen, [25]);
    assert.equal(first.settings.snapshot({ scope: "global" }).maxItems, 25);
    assert.equal(second.settings.snapshot({ scope: "global" }).maxItems, 25);

    await second.settings.set("maxItems", 35, { scope: "project" });
    assert.deepEqual(firstSeen, [25]);
    assert.deepEqual(secondSeen, [25, 35]);
    assert.equal(first.settings.get("maxItems"), 25);
    assert.equal(second.settings.get("maxItems"), 35);
});

test("releasing a lease waits for writes it already accepted", async (t) => {
    // An accepted write must finish before the last lease closes its shared backend entry.
    const fixture = await createSettingsFixture(t);
    const lease = await fixture.acquire();
    const write = lease.settings.set("maxItems", 45);
    const release = lease.release();

    await Promise.all([write, release]);
    const replacement = await fixture.acquire();
    assert.equal(replacement.settings.get("maxItems"), 45);
    assert.deepEqual(await fixture.readScope("global"), { maxItems: 45 });
});

test("a synchronous write notification can release its lease without bypassing the pending write", async (t) => {
    // Reentrant release must see a write before its synchronous notification can invoke user cleanup.
    const fixture = await createSettingsFixture(t);
    const schema = Type.Object({ enabled: Type.Boolean({ default: true }) });
    let enabled = true;
    let finishWrite!: () => void;
    let enterWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
        finishWrite = resolve;
    });
    const writeEntered = new Promise<void>((resolve) => {
        enterWrite = resolve;
    });
    const listeners = new Set<() => void>();
    let backendReleaseCount = 0;
    let reentrantRelease: Promise<void> | undefined;
    const backend: SettingsBackend<typeof schema> = {
        id: "sync-write-release",
        settingSchema: schema as never,
        inspect: () => ({
            defaultValue: true,
            globalValue: undefined,
            projectValue: undefined,
            value: enabled,
            source: "default",
        }),
        set: async (_key, value) => {
            enabled = value;
            enterWrite();
            for (const listener of [...listeners]) listener();
            await writeGate;
        },
        reset: async () => {
            enabled = true;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        reload: async () => undefined,
    };
    const definition = defineSettings({
        id: "sync-write-release",
        schema,
        backend: () => ({
            backend,
            release() {
                backendReleaseCount++;
            },
        }),
    });
    const lease = await acquireSettings(definition, { cwd: fixture.cwd, projectTrusted: true });
    t.after(async () => {
        finishWrite();
        await lease.release();
    });
    lease.settings.subscribe(() => {
        reentrantRelease = lease.release();
    });

    const write = lease.settings.set("enabled", false);
    await writeEntered;
    assert.ok(reentrantRelease);
    let releaseFinished = false;
    const releaseObserved = reentrantRelease.then(() => {
        releaseFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const releaseFinishedBeforeWrite = releaseFinished;

    finishWrite();
    await Promise.all([write, releaseObserved]);

    assert.equal(releaseFinishedBeforeWrite, false);
    assert.equal(backendReleaseCount, 1);
});

test("a synchronous backend subscription callback cannot escape lease cleanup", async (t) => {
    // A backend may notify during registration, so reentrant release must capture the returned unsubscriber.
    const fixture = await createSettingsFixture(t);
    const schema = Type.Object({ enabled: Type.Boolean({ default: true }) });
    let activeSubscriptions = 0;
    let unsubscribeCount = 0;
    const backend: SettingsBackend<typeof schema> = {
        id: "sync-subscribe-release",
        settingSchema: schema as never,
        inspect: () => ({
            defaultValue: true,
            globalValue: undefined,
            projectValue: undefined,
            value: true,
            source: "default",
        }),
        set: async () => undefined,
        reset: async () => undefined,
        subscribe(listener) {
            activeSubscriptions++;
            listener();
            return () => {
                activeSubscriptions--;
                unsubscribeCount++;
            };
        },
        reload: async () => undefined,
    };
    const lease = await acquireSettings(
        defineSettings({
            id: "sync-subscribe-release",
            schema,
            backend: () => ({ backend, release: () => undefined }),
        }),
        { cwd: fixture.cwd, projectTrusted: true },
    );
    t.after(() => lease.release());

    lease.settings.subscribe(() => {
        void lease.release();
    });
    await lease.release();

    assert.equal(activeSubscriptions, 0);
    assert.equal(unsubscribeCount, 1);
});

test("nested fields expose typed values and reset one child within its parent override", async (t) => {
    // A child reset copies its current inherited value while preserving sibling values in the object override.
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();
    const color = settings.field(["appearance", "color"] as const);
    const density = settings.field(["appearance", "density"] as const);

    const checkTypes = () => {
        const colorValue: string = color.get();
        const densityValue: "compact" | "cozy" = density.get();
        void colorValue;
        void densityValue;
        // @ts-expect-error Nested fields must name an existing object property.
        settings.field(["appearance", "missing"] as const);
        // @ts-expect-error Setting keys and values must match the schema.
        settings.set("maxItems", "many");
    };
    void checkTypes;

    await settings.set("appearance", { color: "green", density: "compact" });
    await settings.set("appearance", { color: "red", density: "cozy" }, { scope: "project" });
    assert.deepEqual(color.path, ["appearance", "color"]);
    assert.equal(color.get(), "red");
    assert.equal(color.inspect().globalValue, "green");

    await color.reset({ scope: "project" });
    assert.deepEqual(settings.get("appearance"), { color: "green", density: "cozy" });
    await settings.set("appearance", { color: "gold", density: "compact" });
    assert.deepEqual(settings.get("appearance"), { color: "green", density: "cozy" });
});

test("required parent fields remain editable while optional nested field bindings are rejected", async (t) => {
    // Optional values stay owned by their required parent object instead of inventing an absent child value.
    const fixture = await createSettingsFixture(t);
    const schema = Type.Object({
        preferences: Type.Object(
            {
                label: Type.String({ default: "shown" }),
                optionalLabel: Type.Optional(Type.String({ default: "hidden" })),
            },
            { default: { label: "shown" } },
        ),
    });
    const { settings } = await fixture.acquire("optional-path", fixture.cwd, schema);
    const preferences = settings.field("preferences");

    assert.equal(preferences.get().label, "shown");
    assert.throws(
        () => settings.field(["preferences", "optionalLabel"] as never),
        /required properties/,
    );
});

test("nested edits from different project entries serialize against the latest shared object", async (t) => {
    // Concurrent sibling edits must merge through the shared file queue rather than lose one update.
    const fixture = await createSettingsFixture(t);
    const otherCwd = `${fixture.root}/other-project`;
    const first = await fixture.acquire("example", fixture.cwd);
    const second = await fixture.acquire("example", otherCwd);
    const threshold = first.settings.field(["appearance", "color"] as const);
    const density = second.settings.field(["appearance", "density"] as const);

    await Promise.all([threshold.set("purple"), density.set("cozy")]);

    assert.deepEqual(first.settings.snapshot({ scope: "global" }).appearance, {
        color: "purple",
        density: "cozy",
    });
    assert.deepEqual(second.settings.snapshot({ scope: "global" }).appearance, {
        color: "purple",
        density: "cozy",
    });
    assert.deepEqual(await fixture.readScope("global"), {
        appearance: { color: "purple", density: "cozy" },
    });
});

test("listener failures report committed writes and do not block other listeners or later changes", async (t) => {
    // A failed observer cannot disguise a persisted value or poison subsequent backend operations.
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();
    const failure = new Error("render failed");
    const unsubscribeFailure = settings.subscribe(() => {
        throw failure;
    });
    const observed: number[] = [];
    settings.subscribe(() => observed.push(settings.get("maxItems")));

    await assert.rejects(settings.set("maxItems", 20), (error: unknown) => {
        assert.ok(error instanceof SettingsNotificationError);
        assert.ok(isSettingsNotificationError(error));
        assert.equal(error.committed, true);
        assert.deepEqual(error.errors, [failure]);
        return true;
    });
    assert.equal(settings.get("maxItems"), 20);
    assert.deepEqual(await fixture.readScope("global"), { maxItems: 20 });
    assert.deepEqual(observed, [20]);

    unsubscribeFailure();
    await settings.set("maxItems", 30);
    assert.deepEqual(observed, [20, 30]);
});

test("subscription releases are independent and reload publishes valid external changes", async (t) => {
    // Each subscription remains active until its own release, and explicit reload observes disk edits.
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();
    const observed: number[] = [];
    const unsubscribeFirst = settings.subscribe(() => observed.push(settings.get("maxItems")));
    const unsubscribeSecond = settings.subscribe(() => observed.push(settings.get("maxItems")));

    await settings.set("maxItems", 20);
    assert.deepEqual(observed, [20, 20]);
    unsubscribeFirst();
    unsubscribeFirst();
    await fixture.writeScope("project", { maxItems: 30 });
    await settings.reload();
    assert.deepEqual(observed, [20, 20, 30]);

    unsubscribeSecond();
    await settings.set("maxItems", 40, { scope: "project" });
    assert.deepEqual(observed, [20, 20, 30]);
});

test("lease release publishes its promise before reentrant subscription cleanup", async (t) => {
    // Reentrant cleanup must observe the in-flight release and close the owned backend exactly once.
    const fixture = await createSettingsFixture(t);
    const schema = Type.Object({ enabled: Type.Boolean({ default: true }) });
    let nestedRelease: Promise<void> | undefined;
    let unsubscribeCount = 0;
    let backendReleaseCount = 0;
    const backend: SettingsBackend<typeof schema> = {
        id: "reentrant-release",
        settingSchema: schema as never,
        inspect: () => ({
            defaultValue: true,
            globalValue: undefined,
            projectValue: undefined,
            value: true,
            source: "default",
        }),
        set: async () => undefined,
        reset: async () => undefined,
        subscribe: () => () => {
            unsubscribeCount++;
            nestedRelease = lease.release();
        },
        reload: async () => undefined,
    };
    const definition = defineSettings({
        id: "reentrant-release",
        schema,
        backend: () => ({
            backend,
            release() {
                backendReleaseCount++;
            },
        }),
    });
    const lease = await acquireSettings(definition, { cwd: fixture.cwd, projectTrusted: true });
    lease.settings.subscribe(() => undefined);

    const release = lease.release();
    assert.strictEqual(nestedRelease, release);
    await release;

    assert.equal(unsubscribeCount, 1);
    assert.equal(backendReleaseCount, 1);
});
