import assert from "node:assert/strict";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { defineSettings } from "../../src/settings/index.ts";
import { createSettingsSandbox } from "../../src/testing/index.ts";

const definition = defineSettings({
    id: "sandboxed",
    schema: Type.Object({ limit: Type.Integer({ default: 1 }) }),
});
const exists = (file: string) =>
    access(file).then(
        () => true,
        () => false,
    );

test("a sandbox exports its agent directory, restores the variable and removes its folders", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/previous/agent";
    try {
        const sandbox = await createSettingsSandbox();
        assert.equal(process.env.PI_CODING_AGENT_DIR, sandbox.agentDir);
        assert.ok((await stat(sandbox.agentDir)).isDirectory());
        assert.ok((await stat(sandbox.cwd)).isDirectory());

        await sandbox.dispose();

        assert.equal(process.env.PI_CODING_AGENT_DIR, "/previous/agent");
        assert.equal(await exists(sandbox.agentDir), false);
        assert.equal(await exists(sandbox.cwd), false);
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    }
});

test("the variable is unset again after disposal when it was unset before", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
        const sandbox = await createSettingsSandbox();
        await sandbox.dispose();
        assert.equal("PI_CODING_AGENT_DIR" in process.env, false);
    } finally {
        if (previous !== undefined) process.env.PI_CODING_AGENT_DIR = previous;
    }
});

test("a second concurrent sandbox is refused until the first is disposed", async (t) => {
    const first = await createSettingsSandbox();
    t.after(() => first.dispose());

    await assert.rejects(createSettingsSandbox(), /Another settings sandbox is still active/);
    assert.equal(process.env.PI_CODING_AGENT_DIR, first.agentDir);

    await first.dispose();
    const second = await createSettingsSandbox();
    await second.dispose();
});

test("stored files are addressed per namespace and scope and can be staged raw", async (t) => {
    const sandbox = await createSettingsSandbox();
    t.after(() => sandbox.dispose());

    assert.equal(
        sandbox.settingsFile(definition, "global"),
        path.join(sandbox.agentDir, "lune-settings", "sandboxed.json"),
    );
    assert.equal(
        sandbox.settingsFile(definition, "project"),
        path.join(sandbox.cwd, ".pi", "lune-settings", "sandboxed.json"),
    );
    assert.equal(await sandbox.readStored(definition, "global"), undefined);

    await sandbox.writeStored(definition, "global", { limit: 4 });
    await sandbox.writeStored(definition, "project", "{ broken");

    assert.deepEqual(await sandbox.readStored(definition, "global"), { limit: 4 });
    assert.equal(await readFile(sandbox.settingsFile(definition, "project"), "utf8"), "{ broken");
    await assert.rejects(sandbox.readStored(definition, "project"), SyntaxError);
});

test("acquire uses the sandbox folders, trusts the project by default and honors an override", async (t) => {
    const sandbox = await createSettingsSandbox();
    t.after(() => sandbox.dispose());
    await sandbox.writeStored(definition, "global", { limit: 2 });
    await sandbox.writeStored(definition, "project", { limit: 3 });

    const trusted = await sandbox.acquire(definition);
    const untrusted = await sandbox.acquire(definition, { projectTrusted: false });

    assert.deepEqual(trusted.settings.scopes, ["global", "project"]);
    assert.equal(trusted.settings.get("limit"), 3);
    assert.deepEqual(untrusted.settings.scopes, ["global"]);
    assert.equal(untrusted.settings.get("limit"), 2);
    await trusted.settings.set("limit", 6);
    assert.deepEqual(await sandbox.readStored(definition, "global"), { limit: 6 });
});

test("dispose releases leases before deleting folders and is idempotent", async () => {
    const sandbox = await createSettingsSandbox();
    const lease = await sandbox.acquire(definition);

    const disposal = sandbox.dispose();
    assert.strictEqual(sandbox.dispose(), disposal);
    await disposal;

    assert.equal(lease.settings.signal.aborted, true);
    assert.throws(() => lease.settings.get("limit"), /released/);
    assert.equal(await exists(sandbox.agentDir), false);
    // A fresh sandbox proves the namespace was released rather than left live.
    const next = await createSettingsSandbox();
    await next.writeStored(definition, "global", { limit: 8 });
    const nextLease = await next.acquire(definition);
    assert.equal(nextLease.settings.get("limit"), 8);
    await next.dispose();
});

test("dispose still restores the environment and folders when a lease fails to release", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const sandbox = await createSettingsSandbox();
    const failing = defineSettings({
        id: "failing",
        schema: Type.Object({ limit: Type.Integer({ default: 1 }) }),
        backend: () => ({
            backend: {
                id: "failing",
                settingSchema: Type.Object({ limit: Type.Integer({ default: 1 }) }) as never,
                inspect: () => ({}) as never,
                set: async () => undefined,
                reset: async () => undefined,
                subscribe: () => () => undefined,
                reload: async () => undefined,
            },
            release() {
                throw new Error("release failed");
            },
        }),
    });
    await sandbox.acquire(failing);
    await writeFile(path.join(sandbox.cwd, "marker"), "x");

    await assert.rejects(sandbox.dispose(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Settings sandbox cleanup failed/);
        return true;
    });

    assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
    assert.equal(await exists(sandbox.cwd), false);
});
