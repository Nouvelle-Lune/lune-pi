import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { CORE_HOST_PROTOCOL_VERSION, getCoreHost } from "../src/core/host.ts";
import { getDockRegistry } from "../src/dock/host.ts";
import { LUNE_DOCK_PROTOCOL_VERSION } from "../src/dock/index.ts";
import { getSettingsPanelRegistry } from "../src/panel/host.ts";
import type { SettingsSection } from "../src/panel/index.ts";
import { createSettingsFixture } from "./harness/settings.ts";

const section = (id: string): SettingsSection => ({
    id,
    label: id,
    fields: [],
    scopes: [],
    subscribe: () => () => {},
    reload: async () => {},
});

test("one Host boundary rejects incompatible versions and shapes without creating separate subsystem registries", async (t) => {
    const fixture = await createSettingsFixture(t);
    const lease = await fixture.acquire("host-boundary");
    const host = getCoreHost();
    const mutable = host as unknown as { protocolVersion?: number; panel: unknown };
    const panel = host.panel;
    const symbols = Object.getOwnPropertySymbols(globalThis);
    const namespaces = [...host.settings.namespaces];
    try {
        for (const version of [CORE_HOST_PROTOCOL_VERSION - 1, undefined]) {
            if (version === undefined) delete mutable.protocolVersion;
            else mutable.protocolVersion = version;
            assert.throws(() => getDockRegistry(), /Incompatible Lune Core Host protocol/);
            assert.throws(() => getSettingsPanelRegistry(), /Incompatible Lune Core Host protocol/);
            await assert.rejects(
                fixture.acquire("rejected"),
                /Incompatible Lune Core Host protocol/,
            );
            assert.deepEqual(Object.getOwnPropertySymbols(globalThis), symbols);
            assert.deepEqual([...host.settings.namespaces], namespaces);
            assert.equal(lease.settings.get("maxItems"), 10);
        }
        mutable.protocolVersion = CORE_HOST_PROTOCOL_VERSION;
        mutable.panel = {};
        assert.throws(() => getCoreHost(), /Incompatible Lune Core Host structure/);
    } finally {
        mutable.protocolVersion = CORE_HOST_PROTOCOL_VERSION;
        mutable.panel = panel;
    }
    assert.strictEqual(getCoreHost(), host);
});

test("Dock protocol mismatch or missing version rejects only Dock access without replacing the shared Host", async (t) => {
    const fixture = await createSettingsFixture(t);
    const lease = await fixture.acquire("dock-version-boundary");
    const host = getCoreHost();
    const registry = getDockRegistry();
    const mutable = registry as unknown as { protocolVersion?: number };
    const originalVersion = registry.protocolVersion;
    const panel = getSettingsPanelRegistry();
    const namespaces = [...host.settings.namespaces];
    try {
        for (const version of [LUNE_DOCK_PROTOCOL_VERSION + 1, undefined]) {
            if (version === undefined) delete mutable.protocolVersion;
            else mutable.protocolVersion = version;
            assert.throws(() => getDockRegistry(), /Incompatible Lune Dock protocol/);
            assert.strictEqual(getCoreHost(), host);
            assert.strictEqual(getSettingsPanelRegistry(), panel);
            assert.strictEqual(host.dock, registry);
            assert.deepEqual([...host.settings.namespaces], namespaces);
            assert.equal(lease.settings.get("maxItems"), 10);
        }
    } finally {
        mutable.protocolVersion = originalVersion;
    }
    assert.strictEqual(getDockRegistry(), registry);
});

test("plugins with separate installed Core minor versions share Settings, file queues, Panel and Dock ownership", async (t) => {
    const fixture = await createSettingsFixture(t);
    const root = await mkdtemp(path.join(os.tmpdir(), "lune-installed-copies-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = path.resolve(import.meta.dirname, "..");
    const copies = [];
    for (const [index, version] of ["0.2.0", "0.3.0"].entries()) {
        const plugin = path.join(root, `plugin-${index}`);
        const modules = path.join(plugin, "node_modules");
        const core = path.join(modules, "@lune_99", "pi-lune-extensions-core");
        await mkdir(core, { recursive: true });
        await cp(path.join(repository, "dist"), path.join(core, "dist"), { recursive: true });
        await symlink(
            path.join(repository, "../../node_modules/typebox"),
            path.join(modules, "typebox"),
        );
        await symlink(
            path.join(repository, "../../node_modules/@earendil-works"),
            path.join(modules, "@earendil-works"),
        );
        await writeFile(
            path.join(core, "package.json"),
            JSON.stringify({
                name: "@lune_99/pi-lune-extensions-core",
                version,
                type: "module",
                exports: {
                    "./settings": "./dist/settings/index.js",
                    "./settings/advanced": "./dist/settings/advanced.js",
                    "./panel": "./dist/panel/index.js",
                    "./panel/host": "./dist/panel/host.js",
                    "./dock/host": "./dist/dock/host.js",
                },
            }),
        );
        const entry = path.join(plugin, "index.mjs");
        await writeFile(
            entry,
            [
                'export * from "@lune_99/pi-lune-extensions-core/settings";',
                'export * from "@lune_99/pi-lune-extensions-core/settings/advanced";',
                'export * from "@lune_99/pi-lune-extensions-core/panel";',
                'export * from "@lune_99/pi-lune-extensions-core/panel/host";',
                'export * from "@lune_99/pi-lune-extensions-core/dock/host";',
            ].join("\n"),
        );
        copies.push(await import(pathToFileURL(entry).href));
    }
    const [a, b] = copies;
    const schema = Type.Object({ count: Type.Integer({ default: 1 }) });
    await t.test(
        "SettingsBinding handles stay local even when Core copies share compatible Host services",
        async (t) => {
            const definition = a.defineSettings({ id: "copy-local-binding", schema });
            const binding = a.bindSettings({ on: () => () => {} }, definition);
            t.after(() => binding.dispose());
            const panel = b.defineSettingsPanel(definition, { label: "Copy-local" });
            assert.throws(() => b.registerSettingsPanel(panel, binding), { name: "TypeError" });
            assert.equal(binding.signal.aborted, false);
            const registration = a.registerSettingsPanel(panel, binding);
            t.after(() => registration.dispose());
        },
    );
    const first = await a.acquireSettings(a.defineSettings({ id: "installed", schema }), {
        cwd: fixture.cwd,
        projectTrusted: true,
    });
    const second = await b.acquireSettings(b.defineSettings({ id: "installed", schema }), {
        cwd: fixture.cwd,
        projectTrusted: true,
    });
    t.after(() => first.release());
    t.after(() => second.release());
    const observed: number[] = [];
    t.after(second.settings.subscribe(() => observed.push(second.settings.get("count"))));
    await first.settings.set("count", 3);
    assert.equal(second.settings.get("count"), 3);
    assert.deepEqual(observed, [3]);
    await first.release();
    await second.settings.set("count", 4);
    assert.equal(second.settings.get("count"), 4);
    assert.deepEqual(await fixture.readScope("global", "installed"), { count: 4 });
    assert.strictEqual(a.getSettingsPanelRegistry(), b.getSettingsPanelRegistry());
    assert.strictEqual(a.getDockRegistry(), b.getDockRegistry());
    const scope = {};
    const registered = section("installed-panel");
    const releasePanel = a.registerSettingsSection(scope, registered);
    t.after(releasePanel);
    assert.deepEqual(b.getSettingsPanelRegistry().getSections(scope), [registered]);
    const dock = a.getDockRegistry();
    const releaseDock = dock.registerContribution(scope, {
        id: "installed-dock",
        getSnapshot: () => ({ base: { render: () => ["shared"], invalidate() {} } }),
        subscribe: () => () => {},
        activate() {},
    });
    t.after(releaseDock);
    const detach = b.getDockRegistry().attachHost(scope, { invalidate() {} });
    t.after(detach);
    assert.equal(dock.hasHost(scope), true);
    assert.equal(b.getDockRegistry().getContributions(scope)[0].id, "installed-dock");
    releasePanel();
    assert.deepEqual(b.getSettingsPanelRegistry().getSections(scope), []);

    const incompatiblePlugin = path.join(root, "incompatible-dock");
    const incompatibleModules = path.join(incompatiblePlugin, "node_modules");
    const incompatibleCore = path.join(incompatibleModules, "@lune_99", "pi-lune-extensions-core");
    await mkdir(incompatibleCore, { recursive: true });
    await cp(path.join(repository, "dist"), path.join(incompatibleCore, "dist"), {
        recursive: true,
    });
    await symlink(
        path.join(repository, "../../node_modules/typebox"),
        path.join(incompatibleModules, "typebox"),
    );
    await symlink(
        path.join(repository, "../../node_modules/@earendil-works"),
        path.join(incompatibleModules, "@earendil-works"),
    );
    await writeFile(
        path.join(incompatibleCore, "package.json"),
        await readFile(path.join(repository, "package.json")),
    );
    const dockTypes = path.join(incompatibleCore, "dist/dock/types.js");
    const originalTypes = await readFile(dockTypes, "utf8");
    const current = `export const LUNE_DOCK_PROTOCOL_VERSION = ${LUNE_DOCK_PROTOCOL_VERSION};`;
    const incompatibleVersion = LUNE_DOCK_PROTOCOL_VERSION + 1;
    assert.match(originalTypes, new RegExp(current));
    await writeFile(
        dockTypes,
        originalTypes.replace(
            current,
            `export const LUNE_DOCK_PROTOCOL_VERSION = ${incompatibleVersion};`,
        ),
    );
    const incompatibleEntry = path.join(incompatiblePlugin, "index.mjs");
    await writeFile(
        incompatibleEntry,
        [
            'export * from "@lune_99/pi-lune-extensions-core/settings";',
            'export * from "@lune_99/pi-lune-extensions-core/settings/advanced";',
            'export * from "@lune_99/pi-lune-extensions-core/panel/host";',
            'export * from "@lune_99/pi-lune-extensions-core/dock/host";',
        ].join("\n"),
    );
    const incompatible = await import(pathToFileURL(incompatibleEntry).href);
    const symbolsBefore = Object.getOwnPropertySymbols(globalThis);
    const contributionsBefore = dock.getContributions(scope);
    assert.throws(
        () => incompatible.getDockRegistry(),
        new RegExp(
            `Incompatible Lune Dock protocol: loaded=${LUNE_DOCK_PROTOCOL_VERSION}, required=${incompatibleVersion}`,
        ),
    );
    assert.strictEqual(incompatible.getSettingsPanelRegistry(), a.getSettingsPanelRegistry());
    const settingsOnly = await incompatible.acquireSettings(
        incompatible.defineSettings({ id: "installed", schema }),
        { cwd: fixture.cwd, projectTrusted: true },
    );
    t.after(() => settingsOnly.release());
    assert.equal(settingsOnly.settings.get("count"), 4);
    assert.deepEqual(dock.getContributions(scope), contributionsBefore);
    assert.deepEqual(Object.getOwnPropertySymbols(globalThis), symbolsBefore);
});
