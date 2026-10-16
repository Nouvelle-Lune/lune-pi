import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");

test("root and Panel declarations import and execute with only the required TypeBox peer installed", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lune-optional-peers-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const modules = path.join(root, "node_modules");
    const core = path.join(modules, "@lune_99", "pi-lune-extensions-core");
    await mkdir(core, { recursive: true });
    await cp(path.join(repository, "dist"), path.join(core, "dist"), { recursive: true });
    await writeFile(
        path.join(core, "package.json"),
        await readFile(path.join(repository, "package.json")),
    );
    await symlink(
        path.join(repository, "../../node_modules/typebox"),
        path.join(modules, "typebox"),
    );
    const entry = path.join(root, "consumer.mjs");
    await writeFile(
        entry,
        `
import assert from "node:assert/strict";
import { Type } from "typebox";
import * as core from "@lune_99/pi-lune-extensions-core";
import * as panel from "@lune_99/pi-lune-extensions-core/panel";
import * as testing from "@lune_99/pi-lune-extensions-core/testing";
assert.deepEqual(Object.keys(core).sort(), ["ResourceScope", "bindSettings", "createDockContribution", "defineSettings", "defineSettingsPanel", "readGlobalSettings", "registerSettingsPanel", "scopedExtension"]);
assert.deepEqual(Object.keys(testing), ["createSettingsSandbox"]);
const sandbox = await testing.createSettingsSandbox();
const sandboxDefinition = core.defineSettings({ id: "boundary", schema: Type.Object({ count: Type.Integer({ default: 3 }) }) });
await sandbox.writeStored(sandboxDefinition, "global", { count: 5 });
assert.deepEqual(await sandbox.readStored(sandboxDefinition, "global"), { count: 5 });
assert.equal(await sandbox.readStored(sandboxDefinition, "project"), undefined);
await sandbox.dispose();
const definition = core.defineSettings({ id: "minimal", schema: Type.Object({ count: Type.Integer({ default: 3 }) }) });
const declaration = core.defineSettingsPanel(definition, { label: "Minimal" });
assert.equal(declaration.fields[0].path, "count");
assert.equal("openSettingsPanel" in panel, false);
const source = panel.modelChoices({ scopes: ["all"], specialChoices: [{ value: null, label: "Automatic" }] });
const choices = await source.load({ scope: "global", values: {}, signal: new AbortController().signal, context: { scopedModels: [], modelRegistry: { getAvailable: () => [] } } });
assert.deepEqual(choices, [{ value: null, label: "Automatic" }]);
const resources = new core.ResourceScope();
let released = false;
resources.defer(() => { released = true; });
await resources.dispose();
assert.equal(released, true);
const listeners = new Map();
const pi = { on(name, handler) { const group = listeners.get(name) ?? new Set(); group.add(handler); listeners.set(name, group); return () => group.delete(handler); } };
const binding = core.bindSettings(pi, definition);
const registration = core.registerSettingsPanel(declaration, binding);
await registration.dispose();
await binding.dispose();
assert.equal([...listeners.values()].reduce((count, group) => count + group.size, 0), 0);
await assert.rejects(import("@lune_99/pi-lune-extensions-core/panel/tui"), { code: "ERR_MODULE_NOT_FOUND" });
process.stdout.write("Optional runtime peer boundary passed\\n");
`,
    );
    const { stdout } = await execute(process.execPath, [entry], { cwd: root });
    assert.equal(stdout, "Optional runtime peer boundary passed\n");
});

test("every package export resolves to a built module and the testing entry is declared", async () => {
    const manifest = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")) as {
        exports: Record<string, { types: string; default: string }>;
    };
    assert.ok("./testing" in manifest.exports);
    for (const [name, target] of Object.entries(manifest.exports)) {
        for (const file of [target.types, target.default])
            assert.ok(
                (await readFile(path.join(repository, file), "utf8")).length > 0,
                `${name} must resolve to ${file}`,
            );
    }
});

test("README documentation targets exist in the Git-tracked repository rather than ignored local files", async () => {
    const { stdout } = await execute("git", ["ls-files", "-z", "--", "docs"], { cwd: repository });
    const tracked = new Set(stdout.split("\0").filter(Boolean));
    const readme = await readFile(path.join(repository, "README.md"), "utf8");
    const targets = [...readme.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]*)?\)/g)].map(
        (match) => match[1]!,
    );
    assert.ok(targets.length >= 6);
    for (const target of targets) {
        assert.ok(tracked.has(target), `README target must be tracked: ${target}`);
        assert.ok((await readFile(path.join(repository, target), "utf8")).trim().length);
    }
});
