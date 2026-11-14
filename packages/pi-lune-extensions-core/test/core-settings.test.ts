import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { coreSettings } from "../src/core/settings.ts";
import { createSettingsSandbox } from "../src/testing/index.ts";

async function fixture(t: TestContext) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-core-settings-" });
    t.after(() => sandbox.dispose());
    return sandbox;
}

test("the Mention settings default to a 4 MB cache and 8000 characters", async (t) => {
    const sandbox = await fixture(t);
    const { settings } = await sandbox.acquire(coreSettings);

    const expected = { cacheSizeMB: 4, textLimit: 8000 };
    const actual = settings.get("mention");

    assert.deepEqual(actual, expected);
    assert.equal(await sandbox.readStored(coreSettings, "global"), undefined);
});

test("a legacy Mention file keeps its cache size and gains the default text limit and version", async (t) => {
    const sandbox = await fixture(t);
    await sandbox.writeStored(coreSettings, "global", { mention: { cacheSizeMB: 8 } });

    const { settings } = await sandbox.acquire(coreSettings);

    assert.deepEqual(settings.get("mention"), { cacheSizeMB: 8, textLimit: 8000 });
    assert.deepEqual(await sandbox.readStored(coreSettings, "global"), {
        $version: 2,
        mention: { cacheSizeMB: 8, textLimit: 8000 },
    });
});

test("migration does not hide an invalid legacy cache size", async (t) => {
    const sandbox = await fixture(t);
    await sandbox.writeStored(coreSettings, "global", { mention: { cacheSizeMB: 65 } });

    await assert.rejects(sandbox.acquire(coreSettings));
});

for (const cacheSizeMB of [0, 65, 2.5]) {
    test(`a session cache size of ${cacheSizeMB} is rejected and the stored value is kept`, async (t) => {
        const sandbox = await fixture(t);
        const { settings } = await sandbox.acquire(coreSettings);

        await assert.rejects(settings.set("mention", { cacheSizeMB, textLimit: 8000 }));

        assert.deepEqual(settings.get("mention"), { cacheSizeMB: 4, textLimit: 8000 });
        assert.equal(await sandbox.readStored(coreSettings, "global"), undefined);
    });
}

test("the bounds 1 and 64 MB are accepted and stored globally", async (t) => {
    const sandbox = await fixture(t);
    const { settings } = await sandbox.acquire(coreSettings);

    await settings.set("mention", { cacheSizeMB: 1, textLimit: 8000 });
    await settings.set("mention", { cacheSizeMB: 64, textLimit: 8000 });

    const expected = { $version: 2, mention: { cacheSizeMB: 64, textLimit: 8000 } };
    const actual = await sandbox.readStored(coreSettings, "global");
    assert.deepEqual(actual, expected);
});

for (const textLimit of [0, -1, 2.5]) {
    test(`a session text limit of ${textLimit} is rejected without changing storage`, async (t) => {
        const sandbox = await fixture(t);
        const { settings } = await sandbox.acquire(coreSettings);

        await assert.rejects(settings.set("mention", { cacheSizeMB: 4, textLimit }));

        assert.deepEqual(settings.get("mention"), { cacheSizeMB: 4, textLimit: 8000 });
        assert.equal(await sandbox.readStored(coreSettings, "global"), undefined);
    });
}

test("positive session text limits including values above 8000 are stored globally", async (t) => {
    const sandbox = await fixture(t);
    const { settings } = await sandbox.acquire(coreSettings);

    await settings.set("mention", { cacheSizeMB: 4, textLimit: 1 });
    await settings.set("mention", { cacheSizeMB: 4, textLimit: 1000000 });

    assert.deepEqual(await sandbox.readStored(coreSettings, "global"), {
        $version: 2,
        mention: { cacheSizeMB: 4, textLimit: 1000000 },
    });
});

test("the Mention settings are global only: a project file is refused and a project write is rejected", async (t) => {
    const sandbox = await fixture(t);
    await sandbox.writeStored(coreSettings, "project", {
        mention: { cacheSizeMB: 9, textLimit: 12 },
    });

    await assert.rejects(sandbox.acquire(coreSettings), /can only be stored globally/);

    // An untrusted project is not read, so the same file cannot reach the value.
    const { settings } = await sandbox.acquire(coreSettings, { projectTrusted: false });
    assert.deepEqual(settings.get("mention"), { cacheSizeMB: 4, textLimit: 8000 });
    await assert.rejects(
        settings.set("mention", { cacheSizeMB: 8, textLimit: 20 }, { scope: "project" }),
        /can only be stored globally/,
    );
});
