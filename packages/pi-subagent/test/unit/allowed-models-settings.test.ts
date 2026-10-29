import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDefinedSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
import { createSettingsSandbox } from "@lune_99/pi-lune-extensions-core/testing";

import { createSubagentPanel } from "../../src/settings/panel.ts";
import { subagentSettings } from "../../src/settings/schema.ts";

const SMALL = { provider: "prov", id: "small" };
const BIG = { provider: "prov", id: "big" };
const GONE = { provider: "prov", id: "gone" };

function fakeModel(id: string) {
    return { provider: "prov", id, name: id.toUpperCase() };
}

async function setup(
    t: TestContext,
    options: {
        global?: Record<string, unknown>;
        project?: Record<string, unknown>;
        scoped?: string[];
        available?: string[];
    } = {},
) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-allowed-models-" });

    t.after(() => sandbox.dispose());

    if (options.global) await sandbox.writeStored(subagentSettings, "global", options.global);
    if (options.project) await sandbox.writeStored(subagentSettings, "project", options.project);

    const lease = await sandbox.acquire(subagentSettings);
    const panel = createSubagentPanel({ catalog: () => undefined, onEdit: () => {} });
    const section = createDefinedSettingsSection(lease.settings, panel);
    const ctx = {
        cwd: sandbox.cwd,
        isProjectTrusted: () => true,
        scopedModels: (options.scoped ?? []).map((id) => ({ model: fakeModel(id) })),
        modelRegistry: {
            getAvailable: () => (options.available ?? options.scoped ?? []).map(fakeModel),
            getProviderDisplayName: (provider: string) => provider,
        },
    } as unknown as ExtensionContext;
    const field = section.fields.find((candidate) => candidate.id === "allowedModels")!;
    const choices = () =>
        field.choiceSource!.load({
            context: ctx,
            scope: "global",
            values: lease.settings.snapshot(),
            signal: new AbortController().signal,
        });

    return { sandbox, lease, section, field, ctx, choices };
}

test("the Allowed models row leads the section and summarizes the saved count", async (t) => {
    const { section, field, ctx } = await setup(t);

    assert.equal(field.label, "Allowed models");
    assert.deepEqual(
        section.fields.map((candidate) => candidate.id),
        ["allowedModels", "autoClassifier", "tiers", "agents"],
    );
    assert.equal(field.formatValue?.([], ctx, "global"), "Default · Pi's model scope");
    assert.equal(field.formatValue?.([SMALL, BIG], ctx, "global"), "2 selected");
});

test("the picker offers Pi's scoped models and keeps saved models that cannot be offered", async (t) => {
    const { lease, field, choices } = await setup(t, {
        global: { allowedModels: [BIG, GONE] },
        scoped: ["small"],
        available: ["small", "big", "medium"],
    });

    const actual = (await choices()).map((choice) => [choice.value, choice.label, choice.badge]);
    const expected = [
        [BIG, "big", "Outside scope"],
        [GONE, "gone", "Unavailable"],
        [SMALL, "small", "prov"],
    ];

    assert.deepEqual(actual, expected);
    assert.equal(field.choiceSource!.multiple, true);
    assert.deepEqual(lease.settings.get("allowedModels"), [BIG, GONE]);
});

test("without scoped models the picker lists no available models and explains why", async (t) => {
    const { field, choices } = await setup(t, {
        scoped: [],
        available: ["small", "big"],
    });

    const actual = await choices();

    assert.deepEqual(actual, []);
    assert.match(field.choiceSource!.emptyMessage!, /No scoped models/);
});

test("a nonempty selection persists per scope and an empty project value clears the global one", async (t) => {
    const { sandbox, lease } = await setup(t, {
        global: { allowedModels: [SMALL] },
    });

    await lease.settings.set("allowedModels", [BIG], { scope: "project" });

    assert.deepEqual(lease.settings.get("allowedModels"), [BIG]);
    assert.deepEqual((await sandbox.readStored(subagentSettings, "global"))?.allowedModels, [
        SMALL,
    ]);
    assert.deepEqual((await sandbox.readStored(subagentSettings, "project"))?.allowedModels, [BIG]);

    await lease.settings.set("allowedModels", [], { scope: "project" });

    assert.deepEqual(lease.settings.get("allowedModels"), []);
    assert.equal(lease.settings.inspect("allowedModels").source, "project");
});
