import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsPanelField, SettingsSection } from "@lune_99/pi-lune-extensions-core/panel";
import type { CompactionSettings } from "../../src/settings/schema.ts";
import { classifierChoices, summaryModelChoices } from "../../src/settings/section.ts";
import { createCompactionSection } from "../../src/settings/section.ts";
import { withCompactionSettings } from "../harness/settings-host.ts";

function chatModel(
    id: string,
    options: { provider?: string; reasoning?: boolean } = {},
): Model<string> {
    return {
        id,
        name: id,
        api: "faux",
        provider: options.provider ?? "p",
        baseUrl: "http://localhost:0",
        input: ["text"],
        reasoning: options.reasoning ?? false,
        contextWindow: 128_000,
        maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}

const REASONING_MODEL = chatModel("reasoning-model", {
    provider: "p-reasoning",
    reasoning: true,
});
const PLAIN_MODEL = chatModel("plain-model", { provider: "p-plain" });

function contextFor(models: Model<string>[]): ExtensionContext {
    return {
        cwd: "/unused-by-the-settings-choice-source",
        scopedModels: [],
        modelRegistry: {
            find: (provider: string, id: string) =>
                models.find((model) => model.provider === provider && model.id === id),
            getAvailable: () => models,
            getModelsOfType: () => [],
            getProviderDisplayName: (provider: string) => provider,
        },
    } as unknown as ExtensionContext;
}

function field(section: SettingsSection, id: string): SettingsPanelField {
    const selected = section.fields.find((candidate) => candidate.id === id);
    assert.ok(selected, `missing settings field ${id}`);
    return selected;
}

test("section exposes shared model selectors and only user policy fields", async () => {
    // Nested fields use path-derived public IDs while selectors retain the shared catalog sources.
    await withCompactionSettings("lune-section-", async (settings) => {
        const section = createCompactionSection(settings, () => []);
        const ctx = contextFor([REASONING_MODEL, PLAIN_MODEL]);
        assert.deepEqual(
            section.fields.map(({ id }) => id),
            [
                "enabled",
                "summaryModel",
                "summaryThinkingLevel",
                "jevEnabled",
                "classifier",
                "classifierConcurrency",
                '["policy","deleteThreshold"]',
                '["policy","deletableTools"]',
            ],
        );
        assert.deepEqual(field(section, "summaryModel").choiceSource, summaryModelChoices);
        assert.deepEqual(field(section, "classifier").choiceSource, classifierChoices);
        assert.strictEqual(
            field(section, "summaryModel").choiceSource!.load,
            summaryModelChoices.load,
        );
        assert.strictEqual(field(section, "classifier").choiceSource!.load, classifierChoices.load);
        assert.equal(
            field(section, "summaryModel").formatValue!(
                { provider: "p-reasoning", id: "reasoning-model" },
                ctx,
                "global",
            ),
            "p-reasoning/reasoning-model",
        );
    });
});

test("section shows the saved thinking choice alongside Pi's effective model level", async () => {
    // The UI must explain Pi's clamp without overwriting the independently saved choice.
    await withCompactionSettings("lune-section-", async (settings) => {
        const section = createCompactionSection(settings, () => []);
        const ctx = contextFor([REASONING_MODEL, PLAIN_MODEL]);
        const thinking = field(section, "summaryThinkingLevel");
        const load = (values: CompactionSettings) =>
            thinking.choiceSource!.load({
                context: ctx,
                scope: "global",
                values,
                signal: new AbortController().signal,
            });
        const defaults = settings.snapshot() as CompactionSettings;

        assert.throws(() => load(defaults), /Effort follows the session/);
        ctx.thinkingLevel = "high";
        assert.equal(thinking.formatValue!("off", ctx, "global"), "Follow session effort · high");
        assert.equal(
            field(section, "summaryModel").formatValue!(null, ctx, "global"),
            "Follow session model",
        );
        const reasoningChoices = (
            await load({
                ...defaults,
                summaryModel: { provider: "p-reasoning", id: "reasoning-model" },
            })
        ).map((choice) => choice.value);
        assert.ok(reasoningChoices.includes("high"));
        assert.ok(!reasoningChoices.includes("max"));

        await settings.set(
            "summaryModel",
            { provider: "p-reasoning", id: "reasoning-model" },
            { scope: "global" },
        );
        await settings.set("summaryThinkingLevel", "max", { scope: "global" });
        assert.equal(thinking.formatValue!("max", ctx, "global"), "max → high (model limit)");
        assert.equal(settings.snapshot().summaryThinkingLevel, "max");

        await settings.set(
            "summaryModel",
            { provider: "p-plain", id: "plain-model" },
            { scope: "global" },
        );
        assert.equal(thinking.formatValue!("max", ctx, "global"), "max → off (model limit)");
        assert.throws(
            () =>
                load({
                    ...defaults,
                    summaryModel: { provider: "missing", id: "removed-model" },
                }),
            /no longer registered/,
        );
    });
});

test("thinking choices and effective levels follow Pi model mappings with sparse supported levels", async () => {
    // Sparse Pi effort mappings filter choices without overwriting the saved preference.
    await withCompactionSettings("lune-thinking-map-", async (settings) => {
        const model: Model<string> = {
            ...REASONING_MODEL,
            thinkingLevelMap: {
                off: null,
                minimal: null,
                low: "light",
                medium: null,
                high: null,
                xhigh: "full",
                max: null,
            },
        };
        const ctx = contextFor([model]);
        const section = createCompactionSection(settings, () => []);
        const thinking = field(section, "summaryThinkingLevel");
        await settings.set("summaryModel", { provider: model.provider, id: model.id });
        await settings.set("summaryThinkingLevel", "medium");
        const values = settings.snapshot() as CompactionSettings;
        const choices = await thinking.choiceSource!.load({
            context: ctx,
            scope: "global",
            values,
            signal: new AbortController().signal,
        });
        assert.deepEqual(
            choices.map(({ value }) => value),
            ["low", "xhigh"],
        );
        assert.equal(
            thinking.formatValue!("medium", ctx, "global"),
            "medium → xhigh (model limit)",
        );
        assert.equal(thinking.formatValue!("max", ctx, "global"), "max → xhigh (model limit)");
        assert.equal(settings.snapshot().summaryThinkingLevel, "medium");
    });
});
