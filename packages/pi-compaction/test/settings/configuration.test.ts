import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveCompactionSettings } from "../../src/settings/schema.ts";
import { createCompactionSection } from "../../src/settings/section.ts";
import { withCompactionSettings } from "../harness/settings-host.ts";

const SUMMARY_REFERENCE = { provider: "summary-provider", id: "summary-model" };
const CLASSIFIER_REFERENCE = { provider: "jev-provider", id: "jev-classifier" };

test("configuration defaults enable session-following summaries and automatic classifier selection", async () => {
    // A fresh settings lease exposes schema defaults and follows Pi's session model and effort.
    await withCompactionSettings("lune-configuration-", async (settings) => {
        const actual = settings.snapshot();
        assert.equal(actual.enabled, true);
        assert.equal(actual.summaryModel, null);
        assert.equal(actual.classifier, null);
        assert.equal(actual.jevEnabled, false);
        assert.equal(actual.classifierConcurrency, 2);
        assert.deepEqual(actual.policy, {
            deleteThreshold: 0.7,
            deletableTools: [
                "read",
                "grep",
                "find",
                "ls",
                "codemode",
                "bash",
                "edit",
                "powershell",
                "tool_search",
            ],
        });
        const expected = { provider: "session-provider", id: "session-model" };
        const resolved = resolveCompactionSettings(actual, {
            model: expected as never,
            thinkingLevel: "high",
        });
        assert.deepEqual(resolved?.summaryModel, expected);
        assert.equal(resolved?.summaryThinkingLevel, "high");
        assert.equal(resolveCompactionSettings({ ...actual, enabled: false }), null);
    });
});

test("following requires a session model while explicit models preserve independent thinking", async () => {
    // Session-following requires a model, while an explicitly selected model keeps its saved effort.
    await withCompactionSettings("lune-configuration-", async (settings) => {
        await settings.set("enabled", true);
        assert.throws(() => resolveCompactionSettings(settings.snapshot()), /No session model/);
        await settings.set("summaryModel", SUMMARY_REFERENCE);
        await settings.set("summaryThinkingLevel", "max");
        const actual = resolveCompactionSettings(settings.snapshot(), {
            model: { provider: "session-provider", id: "session-model" } as never,
            thinkingLevel: "low",
        });
        assert.deepEqual(actual?.summaryModel, SUMMARY_REFERENCE);
        assert.equal(actual?.summaryThinkingLevel, "max");
        assert.deepEqual(actual?.jev, { enabled: false });
    });
});

test("preprocessing supports automatic or explicit classifiers without endpoint settings", async () => {
    // Jev resolves to the automatic classifier until the user selects a provider-qualified model.
    await withCompactionSettings("lune-configuration-", async (settings) => {
        await settings.set("enabled", true);
        await settings.set("summaryModel", SUMMARY_REFERENCE);
        await settings.set("jevEnabled", true);
        assert.deepEqual(resolveCompactionSettings(settings.snapshot())?.jev, {
            enabled: true,
            model: null,
            concurrency: 2,
        });
        await settings.set("classifier", CLASSIFIER_REFERENCE);
        assert.deepEqual(resolveCompactionSettings(settings.snapshot())?.jev, {
            enabled: true,
            model: CLASSIFIER_REFERENCE,
            concurrency: 2,
        });
        await assert.rejects(
            settings.set("policy", {
                deleteThreshold: 0.1,
                deletableTools: [],
                concurrency: 2,
            } as never),
            /Invalid/,
        );
    });
});

test("settings accept direct drop confidence from zero through one and reject values outside it", async () => {
    // The schema accepts both confidence endpoints and rejects values outside the closed interval.
    await withCompactionSettings("lune-confidence-", async (settings) => {
        for (const value of [0, 0.7, 1]) {
            await settings.set("policy", { ...settings.get("policy"), deleteThreshold: value });
            assert.equal(settings.get("policy").deleteThreshold, value);
        }
        for (const value of [-0.01, 1.01])
            await assert.rejects(
                settings.set("policy", { ...settings.get("policy"), deleteThreshold: value }),
                /Invalid/,
            );
    });
});

test("confidence saved through either settings scope reloads unchanged without version markers", async () => {
    // Nested field edits persist independently by scope and survive a backend reload.
    await withCompactionSettings("lune-confidence-reload-", async (settings, environment) => {
        const section = createCompactionSection(settings, () => []);
        const confidence = section.fields.find(({ id }) => id === '["policy","deleteThreshold"]')!;
        await confidence.set(0.7, "global");
        await confidence.set(0.2, "project");
        await settings.reload();
        assert.equal(settings.inspect("policy").globalValue?.deleteThreshold, 0.7);
        assert.equal(settings.get("policy").deleteThreshold, 0.2);
        for (const [settingsPath, expectedThreshold] of [
            [environment.settingsPath("global"), 0.7],
            [environment.settingsPath("project"), 0.2],
        ] as const) {
            const saved = JSON.parse(await readFile(settingsPath, "utf8"));
            assert.equal(saved.policy.deleteThreshold, expectedThreshold);
            assert.equal(Object.hasOwn(saved, "version"), false);
        }
    });
});

test("classifier concurrency resolves into the Jev options and is validated by the schema", async () => {
    // The configured value reaches the resolved Jev options only while Jev is enabled.
    await withCompactionSettings("lune-concurrency-", async (settings) => {
        await settings.set("enabled", true);
        await settings.set("summaryModel", SUMMARY_REFERENCE);
        await settings.set("classifierConcurrency", 5);
        assert.deepEqual(resolveCompactionSettings(settings.snapshot())?.jev, { enabled: false });
        await settings.set("jevEnabled", true);
        assert.deepEqual(resolveCompactionSettings(settings.snapshot())?.jev, {
            enabled: true,
            model: null,
            concurrency: 5,
        });
        for (const value of [1, 16]) {
            await settings.set("classifierConcurrency", value);
            assert.equal(settings.get("classifierConcurrency"), value);
        }
        for (const value of [0, 17, 1.5])
            await assert.rejects(settings.set("classifierConcurrency", value), /Invalid/);
    });
});
