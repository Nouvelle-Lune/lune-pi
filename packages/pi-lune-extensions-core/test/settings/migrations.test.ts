import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { defineSettings, type SettingsMigration } from "../../src/settings/index.ts";
import { createSettingsFixture } from "../harness/settings.ts";

const schema = Type.Object({
    limit: Type.Integer({ default: 10, minimum: 0 }),
    title: Type.String({ default: "untitled" }),
});

// v1 stored `max`, v2 stored `count`, v3 stores `limit`.
const rename =
    (from: string, to: string): SettingsMigration =>
    (overrides) => {
        const { [from]: moved, ...rest } = overrides;
        return moved === undefined ? rest : { ...rest, [to]: moved };
    };
const migrating = (id: string, migrations: readonly SettingsMigration[] = chain()) =>
    defineSettings({ id, schema, migrations });
// Untrusted projects read no project file, so these tests observe the global file alone.
const globalOnly = { projectTrusted: false };
const chain = () => [rename("max", "count"), rename("count", "limit")];

test("a version 1 file is upgraded through every migration in order and written back versioned", async (t) => {
    const fixture = await createSettingsFixture(t);
    await fixture.writeScope("global", { max: 20, title: "kept" }, "ordered");
    await fixture.writeScope("project", { max: 30 }, "ordered");

    const lease = await fixture.sandbox.acquire(migrating("ordered"));
    const expectedGlobal = { limit: 20, title: "kept" };
    assert.deepEqual(lease.settings.snapshot({ scope: "global" }), expectedGlobal);
    assert.equal(lease.settings.get("limit"), 30);
    assert.deepEqual(await fixture.readScope("global", "ordered"), {
        $version: 3,
        ...expectedGlobal,
    });
    assert.deepEqual(await fixture.readScope("project", "ordered"), { $version: 3, limit: 30 });
});

test("only the migrations after the stored version run", async (t) => {
    const fixture = await createSettingsFixture(t);
    const seen: string[] = [];
    const migrations: SettingsMigration[] = [
        (overrides) => {
            seen.push("1->2");
            return overrides;
        },
        (overrides) => {
            seen.push("2->3");
            return { ...overrides, title: "from v2" };
        },
    ];
    await fixture.writeScope("global", { $version: 2, limit: 5 }, "partial");

    const lease = await fixture.sandbox.acquire(migrating("partial", migrations), globalOnly);

    assert.deepEqual(seen, ["2->3"]);
    assert.equal(lease.settings.get("title"), "from v2");
    assert.deepEqual(await fixture.readScope("global", "partial"), {
        $version: 3,
        limit: 5,
        title: "from v2",
    });
});

test("a current-version file is not migrated and a missing file creates nothing", async (t) => {
    const fixture = await createSettingsFixture(t);
    let calls = 0;
    const migrations: SettingsMigration[] = [
        (overrides) => {
            calls++;
            return overrides;
        },
    ];
    await fixture.writeScope("global", { $version: 2, limit: 7 }, "current");

    const current = await fixture.sandbox.acquire(migrating("current", migrations), globalOnly);
    assert.equal(calls, 0);
    assert.equal(current.settings.get("limit"), 7);

    const missing = await fixture.sandbox.acquire(migrating("missing", migrations), globalOnly);
    assert.equal(missing.settings.get("limit"), 10);
    await assert.rejects(fixture.readRawScope("global", "missing"), { code: "ENOENT" });
});

test("migrations receive an isolated copy without version metadata", async (t) => {
    const fixture = await createSettingsFixture(t);
    const received: unknown[] = [];
    await fixture.writeScope("global", { $version: 1, limit: 4 }, "isolated");

    await fixture.sandbox.acquire(
        migrating("isolated", [
            (overrides) => {
                received.push(structuredClone(overrides));
                overrides.limit = 99;
                return { limit: 4 };
            },
        ]),
        globalOnly,
    );

    assert.deepEqual(received, [{ limit: 4 }]);
});

test("writes persist the current version only when it is above 1", async (t) => {
    const fixture = await createSettingsFixture(t);
    const plain = await fixture.sandbox.acquire(defineSettings({ id: "plain", schema }));
    const versioned = await fixture.sandbox.acquire(migrating("versioned"));

    await plain.settings.set("limit", 1);
    await versioned.settings.set("limit", 2);

    assert.deepEqual(await fixture.readScope("global", "plain"), { limit: 1 });
    assert.deepEqual(await fixture.readScope("global", "versioned"), { $version: 3, limit: 2 });
});

test("a file written by a newer version is rejected, named and left untouched", async (t) => {
    const fixture = await createSettingsFixture(t);
    const contents = JSON.stringify({ $version: 9, limit: 1 });
    await fixture.writeRawScope("global", contents, "newer");

    await assert.rejects(
        fixture.sandbox.acquire(migrating("newer"), globalOnly),
        (error: Error) => {
            assert.match(error.message, /was written by a newer version of "newer"/);
            assert.ok(error.message.includes(fixture.settingsPath("global", "newer")));
            return true;
        },
    );
    assert.equal(await fixture.readRawScope("global", "newer"), contents);
});

test("a throwing migration reports the step and file with the original cause", async (t) => {
    const fixture = await createSettingsFixture(t);
    const failure = new Error("cannot upgrade");
    const contents = JSON.stringify({ limit: 1 });
    await fixture.writeRawScope("global", contents, "throwing");

    await assert.rejects(
        fixture.sandbox.acquire(
            migrating("throwing", [
                () => {
                    throw failure;
                },
            ]),
            globalOnly,
        ),
        (error: Error) => {
            assert.match(error.message, /Settings migration 1 -> 2 for "throwing" failed on /);
            assert.ok(error.message.includes(fixture.settingsPath("global", "throwing")));
            assert.strictEqual(error.cause, failure);
            return true;
        },
    );
    assert.equal(await fixture.readRawScope("global", "throwing"), contents);
});

test("a migration returning a non-object is rejected", async (t) => {
    const fixture = await createSettingsFixture(t);
    for (const [index, result] of [null, [], "text", 3].entries()) {
        const id = `non-object-${index}`;
        await fixture.writeScope("global", { limit: 1 }, id);
        await assert.rejects(
            fixture.sandbox.acquire(migrating(id, [() => result as never]), globalOnly),
            (error: Error) => {
                assert.match(error.message, /Settings migration 1 -> 2/);
                assert.match(String((error.cause as Error).message), /must return a plain object/);
                return true;
            },
        );
    }
});

test("migrated data that violates the current schema is rejected without being written", async (t) => {
    const fixture = await createSettingsFixture(t);
    const contents = JSON.stringify({ limit: 1 });
    await fixture.writeRawScope("global", contents, "invalid-result");

    await assert.rejects(
        fixture.sandbox.acquire(
            migrating("invalid-result", [() => ({ limit: "many" })]),
            globalOnly,
        ),
        { name: "TypeError", message: /Invalid value for setting "limit"/ },
    );
    assert.equal(await fixture.readRawScope("global", "invalid-result"), contents);
});

test("invalid $version values and unknown $ metadata keys are rejected", async (t) => {
    const fixture = await createSettingsFixture(t);
    const cases: [string, unknown, RegExp][] = [
        ["zero", { $version: 0 }, /Invalid "\$version"/],
        ["negative", { $version: -1 }, /Invalid "\$version"/],
        ["fraction", { $version: 1.5 }, /Invalid "\$version"/],
        ["string", { $version: "2" }, /Invalid "\$version"/],
        ["null", { $version: null }, /Invalid "\$version"/],
        ["metadata", { $extra: true }, /Unknown settings metadata "\$extra"/],
    ];
    for (const [name, stored, message] of cases) {
        const id = `meta-${name}`;
        await fixture.writeScope("global", stored, id);
        await assert.rejects(fixture.acquire(id), { name: "TypeError", message });
    }
});
