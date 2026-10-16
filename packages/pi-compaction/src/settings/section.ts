import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineSettings } from "@lune_99/pi-lune-extensions-core/settings";
import {
    defineSettingsPanel,
    modelChoices,
    type ModelReference,
    type SettingsChoiceSource,
} from "@lune_99/pi-lune-extensions-core/panel";
import { createDefinedSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
import { compactionSchema, SETTINGS_ID, type CompactionSettingsView } from "./schema.ts";

export const summaryModelChoices: SettingsChoiceSource<ModelReference | null> = modelChoices({
    emptyMessage:
        "No summary models are available. Configure a provider in Pi, then press Ctrl+R to refresh.",
    specialChoices: [
        {
            value: null,
            label: "Follow session model",
            description: "Use the current session model and effort for each compaction operation.",
        },
    ],
});

export const classifierChoices: SettingsChoiceSource<ModelReference | null> = modelChoices({
    type: "classifier",
    specialChoices: (_context, entries) => [
        {
            value: null,
            label: "Automatic",
            description: entries.length
                ? `Use the first available Pi classifier at runtime (${entries[0]!.provider}/${entries[0]!.id} currently).`
                : "No classifier is available. Configure a provider in Pi with /login or environment credentials, then press Ctrl+R to refresh.",
        },
    ],
});

export const compactionSettings = defineSettings({ id: SETTINGS_ID, schema: compactionSchema });

export function createCompactionPanel(getTools: ExtensionAPI["getAllTools"]) {
    return defineSettingsPanel(compactionSettings, {
        id: "compaction",
        label: "Compaction",
        fields: (field) => [
            field("enabled", {
                label: "Lune compaction",
                description:
                    "Enabled by default. Follow the session model and effort, or select a separate summary model. Changes apply on the next operation.",
            }),
            field("summaryModel", {
                label: "Compaction model",
                formatValue: (value) =>
                    value ? `${value.provider}/${value.id}` : "Follow session model",
                choiceSource: summaryModelChoices,
            }),
            field("summaryThinkingLevel", {
                label: "Compaction thinking level",
                description:
                    "Inherited from the session when following its model; otherwise configured independently.",
                formatValue: (value, { context, values }) => {
                    if (!values.summaryModel)
                        return `Follow session effort${context.thinkingLevel ? ` · ${context.thinkingLevel}` : ""}`;
                    const model = context.modelRegistry.find(
                        values.summaryModel.provider,
                        values.summaryModel.id,
                    );
                    if (!model) return `${value} (select an available model first)`;
                    const effective = clampThinkingLevel(model, value);
                    return effective === value ? value : `${value} → ${effective} (model limit)`;
                },
                choiceSource: {
                    load: ({ context, values }) => {
                        if (!values.summaryModel)
                            throw new Error(
                                "Effort follows the session. Select a separate summary model to configure it independently.",
                            );
                        const model = context.modelRegistry.find(
                            values.summaryModel.provider,
                            values.summaryModel.id,
                        );
                        if (!model)
                            throw new Error("Selected summary model is no longer registered");
                        return getSupportedThinkingLevels(model).map((value) => ({
                            value,
                            label: value,
                        }));
                    },
                },
            }),
            field("jevEnabled", {
                label: "Jev preprocessing",
                description:
                    "Classify permitted tool outputs before compaction. Configure provider authentication in Pi.",
            }),
            field("classifier", {
                label: "Classifier model",
                formatValue: (value) =>
                    value
                        ? `${value.provider}/${value.id}`
                        : "Automatic · available Pi classifiers",
                choiceSource: classifierChoices,
            }),
            field(["policy", "deleteThreshold"], {
                label: "Drop confidence",
                description:
                    "How confident the classifier must be before dropping an output fragment (0–1). 0.7 means at least 70% confidence. Inherited with the whole policy object.",
            }),
            field(["policy", "deletableTools"], {
                label: "Deletable tools →",
                description:
                    "Select tools whose whole call may be removed after their results are judged disposable. New tools remain unchecked; unavailable selections are retained until you uncheck them. Inherited with the whole policy object.",
                formatValue: (value) => `${value.length} selected`,
                choiceSource: {
                    multiple: true,
                    rowLayout: "inline",
                    load: ({ values }) => {
                        const registered = getTools();
                        const available = new Set(registered.map((tool) => tool.name));
                        return [
                            ...registered.map((tool) => ({
                                value: tool.name,
                                label: tool.name,
                                badge:
                                    tool.namespace?.name.startsWith("mcp__") ||
                                    tool.sourceInfo.path.startsWith("builtin:mcp")
                                        ? `MCP${tool.namespace ? ` · ${tool.namespace.name.replace(/^mcp__/u, "")}` : ""}`
                                        : tool.sourceInfo.path.startsWith("builtin:")
                                          ? "Pi"
                                          : (tool.namespace?.name ?? tool.sourceInfo.source),
                                description: `${tool.annotations?.readOnlyHint ? "Read-only · " : ""}${tool.description}`,
                            })),
                            ...values.policy.deletableTools
                                .filter((name) => !available.has(name))
                                .map((name) => ({
                                    value: name,
                                    label: name,
                                    badge: "Unavailable",
                                    description:
                                        "Not currently registered. Keep selected to restore this permission when the tool returns, or uncheck to remove it.",
                                })),
                        ];
                    },
                },
            }),
        ],
    });
}

export function createCompactionSection(
    settings: CompactionSettingsView,
    getTools: ExtensionAPI["getAllTools"],
) {
    return createDefinedSettingsSection(settings, createCompactionPanel(getTools));
}
