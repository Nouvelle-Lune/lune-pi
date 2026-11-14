import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { coreSettings } from "../src/core/settings.ts";
import { createSettingsSandbox } from "../src/testing/index.ts";

async function fixture(t: TestContext) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-core-settings-" });
    t.after(() => sandbox.dispose());
    return sandbox;
}

test("the session cache size defaults to 4 MB", async (t) => {
    const sandbox = await fixture(t);
    const { settings } = await sandbox.acquire(coreSettings);

    const expected = { cacheSizeMB: 4 };
    const actual = settings.get("mention");

    assert.deepEqual(actual, expected);
});

for (const cacheSizeMB of [0, 65, 2.5]) {
    test(`a session cache size of ${cacheSizeMB} is rejected and the stored value is kept`, async (t) => {
        const sandbox = await fixture(t);
        const { settings } = await sandbox.acquire(coreSettings);

        await assert.rejects(settings.set("mention", { cacheSizeMB }));

        assert.deepEqual(settings.get("mention"), { cacheSizeMB: 4 });
        assert.equal(await sandbox.readStored(coreSettings, "global"), undefined);
    });
}

test("the bounds 1 and 64 MB are accepted and stored globally", async (t) => {
    const sandbox = await fixture(t);
    const { settings } = await sandbox.acquire(coreSettings);

    await settings.set("mention", { cacheSizeMB: 1 });
    await settings.set("mention", { cacheSizeMB: 64 });

    const expected = { mention: { cacheSizeMB: 64 } };
    const actual = await sandbox.readStored(coreSettings, "global");
    assert.deepEqual(actual, expected);
});

test("the session cache size is global only: a project file is refused and a project write is rejected", async (t) => {
    const sandbox = await fixture(t);
    await sandbox.writeStored(coreSettings, "project", { mention: { cacheSizeMB: 9 } });

    await assert.rejects(sandbox.acquire(coreSettings), /can only be stored globally/);

    // An untrusted project is not read, so the same file cannot reach the value.
    const { settings } = await sandbox.acquire(coreSettings, { projectTrusted: false });
    assert.equal(settings.get("mention").cacheSizeMB, 4);
    await assert.rejects(
        settings.set("mention", { cacheSizeMB: 8 }, { scope: "project" }),
        /can only be stored globally/,
    );
});
