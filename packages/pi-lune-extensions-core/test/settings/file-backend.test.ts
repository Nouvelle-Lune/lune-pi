import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createSettingsFixture, createSettingsSchema } from "../harness/settings.ts";

test("the file backend preserves defaults, namespace isolation, and scoped writes", async (t) => {
    // Writes must retain other extensions and project overrides while keeping projects isolated.
    const fixture = await createSettingsFixture(t);
    const first = await fixture.acquire();
    const other = await fixture.acquire("other");
    const otherProject = await fixture.acquire("example", path.join(fixture.root, "other-project"));

    assert.equal(first.settings.get("maxItems"), 10);
    await first.settings.set("maxItems", 20);
    await first.settings.set("maxItems", 30, { scope: "project" });
    await other.settings.set("enabled", false);

    assert.equal(first.settings.get("maxItems"), 30);
    assert.equal(otherProject.settings.get("maxItems"), 20);
    assert.deepEqual(await fixture.readScope("global"), { maxItems: 20 });
    assert.deepEqual(await fixture.readScope("global", "other"), { enabled: false });
    assert.deepEqual(await fixture.readScope("project"), { maxItems: 30 });

    await first.settings.reset("maxItems", { scope: "project" });
    assert.equal(first.settings.get("maxItems"), 20);
    // Empty overrides delete the file instead of leaving an empty object behind.
    await assert.rejects(fixture.readRawScope("project"), { code: "ENOENT" });
});

test("loaded Core copies share file-backed values, notifications, and release ownership", async (t) => {
    const fixture = await createSettingsFixture(t);
    const first = await fixture.acquire();
    const copy = (await import(
        new URL("../../src/settings/file-backend.ts?copy=1", import.meta.url).href
    )) as typeof import("../../src/settings/file-backend.ts");
    const second = await copy.acquireFileBackend({
        id: "example",
        schema: createSettingsSchema(),
        cwd: fixture.cwd,
        projectTrusted: true,
        migrations: [],
        globalOnly: [],
    });
    t.after(() => second.release());
    const observed: number[] = [];
    const unsubscribe = second.backend.subscribe(() => {
        observed.push(second.backend.inspect("maxItems").value);
    });
    t.after(unsubscribe);

    await first.settings.set("maxItems", 25);
    assert.equal(second.backend.inspect("maxItems").value, 25);
    await second.backend.set("maxItems", 35);
    assert.equal(first.settings.get("maxItems"), 35);
    assert.deepEqual(observed, [25, 35]);

    await first.release();
    await second.backend.set("maxItems", 45);
    assert.equal(second.backend.inspect("maxItems").value, 45);
    assert.deepEqual(await fixture.readScope("global"), { maxItems: 45 });
});

test("invalid persisted values, namespaces, and stored keys fail instead of falling back", async (t) => {
    // Every malformed configured override must stop acquisition, even when a lower-priority value exists.
    const fixture = await createSettingsFixture(t);
    const invalidCases = [
        {
            id: "bad-global-value",
            scope: "global" as const,
            stored: { maxItems: "ten" },
            expected: /Invalid value for setting "maxItems"/,
        },
        {
            id: "bad-project-value",
            scope: "project" as const,
            stored: { maxItems: -1 },
            expected: /Invalid value for setting "maxItems"/,
        },
        {
            id: "bad-global-file",
            scope: "global" as const,
            stored: 42,
            expected: /not a JSON object/,
        },
        {
            id: "bad-project-file",
            scope: "project" as const,
            stored: [],
            expected: /not a JSON object/,
        },
        {
            id: "bad-stored-key",
            scope: "project" as const,
            stored: { unexpected: true },
            expected: /Unknown setting "unexpected"/,
        },
    ];

    for (const [index, invalid] of invalidCases.entries()) {
        await fixture.writeScope(invalid.scope, invalid.stored, invalid.id);
        await assert.rejects(fixture.acquire(invalid.id), {
            name: "TypeError",
            message: invalid.expected,
        });
        assert.deepEqual(
            await fixture.readScope(invalid.scope, invalid.id),
            invalid.stored,
            `case ${index}`,
        );
    }
});

test("invalid reloads preserve the last committed view and leave the bad file untouched", async (t) => {
    // A failed disk read must be visible without replacing valid cached settings.
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();
    await settings.set("maxItems", 20);

    for (const [contents, errorType] of [
        ["{", SyntaxError],
        ["null", TypeError],
    ] as const) {
        await fixture.writeRawScope("project", contents);
        await assert.rejects(settings.reload(), errorType);
        assert.equal(settings.get("maxItems"), 20);
        assert.equal(await fixture.readRawScope("project"), contents);
    }
});

test("failed initialization can be retried after the persisted namespace is repaired", async (t) => {
    // A rejected initialization must release its partial entry so corrected data can load immediately.
    const fixture = await createSettingsFixture(t);
    await fixture.writeScope("global", { maxItems: "ten" });

    await assert.rejects(fixture.acquire(), /Invalid value for setting/);
    await fixture.writeScope("global", { maxItems: 40 });
    const repaired = await fixture.acquire();
    assert.equal(repaired.settings.get("maxItems"), 40);
});

test("concurrent writes to separate namespaces preserve every update in their own files", async (t) => {
    // Concurrent writes to independent namespace files must neither lose nor mix updates.
    const fixture = await createSettingsFixture(t);
    const example = await fixture.acquire("example");
    const other = await fixture.acquire("other");

    await Promise.all([
        example.settings.set("maxItems", 30),
        other.settings.set("maxItems", 40),
        example.settings.set("label", "first"),
        other.settings.set("label", "second"),
    ]);

    assert.deepEqual(await fixture.readScope("global"), { maxItems: 30, label: "first" });
    assert.deepEqual(await fixture.readScope("global", "other"), {
        maxItems: 40,
        label: "second",
    });
});

test("failed writes propagate and the settings queue accepts later writes after repair", async (t) => {
    // Filesystem failures must reject the caller and leave the backend usable after the obstruction is removed.
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();
    await rm(fixture.agentDir, { recursive: true, force: true });
    await writeFile(fixture.agentDir, "not a directory", "utf-8");

    await assert.rejects(settings.set("maxItems", 30), { code: "ENOTDIR" });
    await assert.rejects(settings.reset("maxItems"), { code: "ENOTDIR" });
    assert.equal(
        await (await import("node:fs/promises")).readFile(fixture.agentDir, "utf-8"),
        "not a directory",
    );

    await rm(fixture.agentDir);
    await settings.set("maxItems", 40);
    assert.equal(settings.get("maxItems"), 40);
    assert.deepEqual(await fixture.readScope("global"), { maxItems: 40 });
});

test("a prototype-sensitive stored key is rejected as unknown instead of polluting objects", async (t) => {
    // Special object property names must never alter prototypes or be accepted as settings.
    const fixture = await createSettingsFixture(t);
    await fixture.writeRawScope("global", '{"__proto__": {"polluted": true}}');

    await assert.rejects(fixture.acquire(), /Unknown setting "__proto__"/);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("conflicting declarations are rejected until the last lease releases the namespace", async (t) => {
    // A live backing entry has one schema, while a later generation may adopt a deliberate schema change.
    const fixture = await createSettingsFixture(t);
    const first = await fixture.acquire();
    const changedSchema = createSettingsSchema();
    Object.assign(changedSchema.properties.maxItems, { default: 99 });

    await assert.rejects(
        fixture.acquire("example", fixture.cwd, changedSchema),
        /Conflicting settings declaration/,
    );
    await first.release();
    const next = await fixture.acquire("example", fixture.cwd, changedSchema);
    assert.equal(next.settings.get("maxItems"), 99);
});

test("unknown setting names, values, and scopes are rejected before persistence", async (t) => {
    // Runtime checks remain required because JavaScript consumers can bypass TypeScript declarations.
    const fixture = await createSettingsFixture(t);
    const { settings } = await fixture.acquire();

    assert.throws(() => settings.set("unexpected" as never, true as never), /Unknown setting/);
    assert.throws(() => settings.reset("unexpected" as never), /Unknown setting/);
    await assert.rejects(settings.set("maxItems", "ten" as never), /Invalid value/);
    await assert.rejects(
        settings.set("maxItems", 20, { scope: "other" as never }),
        /Unknown settings scope/,
    );
    await assert.rejects(
        settings.reset("maxItems", { scope: "other" as never }),
        /Unknown settings scope/,
    );
    assert.equal(settings.get("maxItems"), 10);
    await assert.rejects(fixture.readRawScope("global"), { code: "ENOENT" });
});

test(
    "settings files are written readable by their owner only because they may hold secrets",
    { skip: process.platform === "win32" },
    async (t) => {
        const fixture = await createSettingsFixture(t);
        const { settings } = await fixture.acquire();

        await settings.set("maxItems", 20);
        await settings.set("maxItems", 30, { scope: "project" });

        for (const scope of ["global", "project"] as const) {
            const actual = (await stat(fixture.settingsPath(scope))).mode & 0o777;
            assert.equal(actual, 0o600, `${scope} file mode`);
        }
    },
);
