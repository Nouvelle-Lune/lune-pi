import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDefinedSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
import { createSettingsSandbox } from "@lune_99/pi-lune-extensions-core/testing";

import { DEFAULT_AUTO_MODEL_SETTINGS } from "../../src/auto-model.ts";
import { createSubagentPanel } from "../../src/settings/panel.ts";
import { autoModelSettings, subagentSettings } from "../../src/settings/schema.ts";

const SMALL = { provider: "prov", id: "small" };
const BIG = { provider: "prov", id: "big" };
const NO_TIERS = { light: null, standard: null, complex: null, deep: null };
const DEFAULTS = {
    autoClassifier: null,
    autoTiers: NO_TIERS,
    autoRiskFloor: "deep" as const,
    autoRiskThreshold: 0.4,
};

function fakeModel(id: string) {
    return { provider: "prov", id, name: id.toUpperCase() };
}

async function setup(
    t: TestContext,
    options: { stored?: Record<string, unknown>; scoped?: string[] } = {},
) {
    const sandbox = await createSettingsSandbox({ prefix: "lune-auto-tiers-" });

    t.after(() => sandbox.dispose());

    if (options.stored) await sandbox.writeStored(subagentSettings, "global", options.stored);

    const lease = await sandbox.acquire(subagentSettings);
    const panel = createSubagentPanel({ catalog: () => undefined, onEdit: () => {} });
    const section = createDefinedSettingsSection(lease.settings, panel);
    const available = [fakeModel("small"), fakeModel("big")];
    const ctx = {
        cwd: sandbox.cwd,
        isProjectTrusted: () => true,
        scopedModels: (options.scoped ?? []).map((id) => ({ model: fakeModel(id) })),
        modelRegistry: { getAvailable: () => available },
    } as unknown as ExtensionContext;
    const menu = section.fields.find((field) => field.id === "tiers")!;

    return { sandbox, lease, section, menu, ctx };
}

test("the settings migration drops the stored candidate list and keeps the classifier", async (t) => {
    const { sandbox, lease } = await setup(t, {
        stored: { autoClassifier: { provider: "cls", id: "judge" }, autoModels: [SMALL, BIG] },
    });

    const stored = await sandbox.readStored(subagentSettings, "global");

    assert.equal(stored?.autoModels, undefined);
    assert.deepEqual(stored?.autoClassifier, { provider: "cls", id: "judge" });
    assert.deepEqual(lease.settings.get("autoTiers"), NO_TIERS);
    assert.deepEqual(lease.settings.get("autoClassifier"), { provider: "cls", id: "judge" });
});

test("autoModelSettings maps the stored tiers and classifier to what the auto choice reads", async (t) => {
    const { lease } = await setup(t, {
        stored: { $version: 2, autoClassifier: SMALL, autoTiers: { ...NO_TIERS, deep: BIG } },
    });

    const actual = autoModelSettings(lease.settings.snapshot());

    assert.deepEqual(actual, {
        classifier: SMALL,
        tiers: { light: null, standard: null, complex: null, deep: BIG },
        riskFloor: "deep",
        riskThreshold: 0.4,
    });
    assert.deepEqual(autoModelSettings(DEFAULTS), DEFAULT_AUTO_MODEL_SETTINGS);
});

test("the Auto tiers menu lists the tier and high-risk fields on its page and none in the section", async (t) => {
    const { section, menu, ctx } = await setup(t);

    const actual = menu.menu!(ctx, "global").fields.map((field) => field.label);

    assert.deepEqual(actual, [
        "Light",
        "Standard",
        "Complex",
        "Deep",
        "High-risk floor",
        "High-risk threshold",
    ]);
    assert.equal(menu.label, "Auto tiers");
    assert.deepEqual(
        section.fields.map((field) => field.id),
        ["autoClassifier", "tiers", "agents"],
    );
});

test("the Auto tiers summary says none are set, then counts the tiers that have a model", async (t) => {
    const { menu, ctx, lease } = await setup(t);

    assert.equal(menu.formatValue?.(undefined, ctx, "global"), "none set · main agent's model");

    await lease.settings.set("autoTiers", { ...NO_TIERS, light: SMALL }, { scope: "global" });
    assert.equal(menu.formatValue?.(undefined, ctx, "global"), "1 of 4 set");

    await lease.settings.set(
        "autoTiers",
        { light: SMALL, standard: BIG, complex: SMALL, deep: BIG },
        { scope: "global" },
    );
    assert.equal(menu.formatValue?.(undefined, ctx, "global"), "4 of 4 set");
});

test("an unset tier shows where its tasks go: the next tier up, and for deep the main agent's model", async (t) => {
    const { menu, ctx } = await setup(t);

    const fields = menu.menu!(ctx, "global").fields;
    const shown = fields.slice(0, 4).map((field) => field.formatValue?.(null, ctx, "global"));

    assert.deepEqual(shown, [
        "None · next tier up",
        "None · next tier up",
        "None · next tier up",
        "None · main agent's model",
    ]);
});

test("a tier's choices are None, then every allowed model", async (t) => {
    const { menu, ctx, lease } = await setup(t);
    const light = menu.menu!(ctx, "global").fields[0]!;

    const choices = await light.choiceSource!.load({
        context: ctx,
        scope: "global",
        values: lease.settings.snapshot(),
        signal: new AbortController().signal,
    });

    assert.deepEqual(
        choices.map((choice) => [choice.value, choice.label, choice.badge]),
        [
            [null, "None", undefined],
            [SMALL, "small", "prov"],
            [BIG, "big", "prov"],
        ],
    );
});

test("a tier's model that Pi's scope no longer allows stays listed with a Not allowed badge", async (t) => {
    const { menu, ctx, lease } = await setup(t, {
        stored: { $version: 2, autoTiers: { ...NO_TIERS, light: SMALL } },
        scoped: ["big"],
    });
    const fields = menu.menu!(ctx, "global").fields;
    const load = (index: number) =>
        fields[index]!.choiceSource!.load({
            context: ctx,
            scope: "global",
            values: lease.settings.snapshot(),
            signal: new AbortController().signal,
        });

    const light = await load(0);
    const standard = await load(1);

    assert.deepEqual(
        light.map((choice) => [choice.label, choice.badge]),
        [
            ["None", undefined],
            ["big", "prov"],
            ["small", "Not allowed"],
        ],
    );
    assert.deepEqual(
        standard.map((choice) => choice.label),
        ["None", "big"],
    );
});

test("the high-risk settings default to the deep floor and a threshold of 0.4", async (t) => {
    const { lease } = await setup(t);

    assert.equal(lease.settings.get("autoRiskFloor"), "deep");
    assert.equal(lease.settings.get("autoRiskThreshold"), 0.4);
    assert.deepEqual(autoModelSettings(lease.settings.snapshot()), DEFAULT_AUTO_MODEL_SETTINGS);
    assert.equal(DEFAULT_AUTO_MODEL_SETTINGS.riskFloor, "deep");
    assert.equal(DEFAULT_AUTO_MODEL_SETTINGS.riskThreshold, 0.4);
});

test("autoModelSettings maps the off floor to null and keeps the other floors and the threshold", () => {
    const of = (autoRiskFloor: "off" | "standard" | "complex" | "deep") =>
        autoModelSettings({ ...DEFAULTS, autoRiskFloor, autoRiskThreshold: 0.25 });

    assert.equal(of("off").riskFloor, null);
    assert.equal(of("standard").riskFloor, "standard");
    assert.equal(of("complex").riskFloor, "complex");
    assert.equal(of("deep").riskFloor, "deep");
    assert.equal(of("off").riskThreshold, 0.25);
});

test("the floor and the threshold are fields on the Auto tiers page, with the floor as four choices", async (t) => {
    const { menu, ctx } = await setup(t);

    const fields = menu.menu!(ctx, "global").fields;
    const floor = fields.find((field) => field.id === "autoRiskFloor")!;
    const threshold = fields.find((field) => field.id === "autoRiskThreshold")!;

    assert.deepEqual(
        floor.choices?.map((choice) => choice.value),
        ["off", "standard", "complex", "deep"],
    );
    assert.ok(threshold);
});

test("the threshold shows as a percent", async (t) => {
    const { menu, ctx } = await setup(t);
    const threshold = menu.menu!(ctx, "global").fields.find(
        (field) => field.id === "autoRiskThreshold",
    )!;

    assert.equal(threshold.formatValue?.(0.4, ctx, "global"), "40%");
    assert.equal(threshold.formatValue?.(0, ctx, "global"), "0%");
    assert.equal(threshold.formatValue?.(1, ctx, "global"), "100%");
});

test("the threshold accepts 0 and 1 and rejects values outside 0 to 1", async (t) => {
    const { lease } = await setup(t);
    const set = (value: number) =>
        lease.settings.set("autoRiskThreshold", value, { scope: "global" });

    await set(0);
    await set(1);
    assert.equal(lease.settings.get("autoRiskThreshold"), 1);
    await assert.rejects(set(1.01));
    await assert.rejects(set(-0.01));
    assert.equal(lease.settings.get("autoRiskThreshold"), 1);
});

test("the floor rejects a value that is not off or a tier above light", async (t) => {
    const { lease } = await setup(t);

    await assert.rejects(
        lease.settings.set("autoRiskFloor", "light" as never, { scope: "global" }),
    );
    await lease.settings.set("autoRiskFloor", "off", { scope: "global" });
    assert.equal(lease.settings.get("autoRiskFloor"), "off");
});
