import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { defineSettingsPanel, modelChoices } from "@lune_99/pi-lune-extensions-core/panel";
import { recapSettings, resolveRecapModel } from "./settings.ts";

export const recapPanel = defineSettingsPanel(recapSettings, {
    id: "recap",
    label: "Recap",
    fields: [
        {
            path: "enabled",
            label: "Automatic recap",
            description:
                "Off by default. Automatic recap requires real terminal focus reports (e.g. fullscreen); ordinary scrollback may only support /recap.",
        },
        {
            path: "model",
            label: "Recap model",
            formatValue: (value) =>
                value ? `${value.provider}/${value.id}` : "Follow session model",
            choiceSource: modelChoices({
                specialChoices: [{ value: null, label: "Follow session model" }],
            }),
        },
        {
            path: "thinkingLevel",
            label: "Recap thinking level",
            formatValue: (value, { context, values }) => {
                const model = resolveRecapModel(context, values);
                if (!model) return `${value} (select an available model first)`;
                const effective = clampThinkingLevel(model, value);
                return effective === value ? value : `${value} → ${effective} (model limit)`;
            },
            choiceSource: {
                load: ({ context, values }) => {
                    const model = resolveRecapModel(context, values);
                    if (!model) throw new Error("Select an available model first");
                    return getSupportedThinkingLevels(model).map((value) => ({
                        value,
                        label: value,
                    }));
                },
            },
        },
        {
            path: "maxRetries",
            label: "Maximum retries",
            description:
                "Retries after the initial attempt, for temporary provider errors only. Intermediate failures stay silent. 0 disables retries.",
        },
    ],
});
