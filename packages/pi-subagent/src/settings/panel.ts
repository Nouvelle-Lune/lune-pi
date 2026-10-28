import {
    defineSettingsPanel,
    modelChoices,
    type ModelReference,
    type SettingsChoiceSource,
} from "@lune_99/pi-lune-extensions-core/panel";

import { allowedModels, formatModelRef } from "../models.ts";
import { agentsMenu, type AgentsMenuOptions } from "./agents-menu.ts";
import { subagentSettings, type SubagentSettings } from "./schema.ts";

const classifierChoices: SettingsChoiceSource<ModelReference | null> = modelChoices({
    type: "classifier",
    specialChoices: (_context, classifiers) => [
        {
            value: null,
            label: "None · main session model",
            description: classifiers.length
                ? "Runs started with model auto use the main session's model."
                : "No classifier is available. Configure a classifier provider in Pi with /login " +
                  "or its environment credentials, then press Ctrl+R to refresh.",
        },
    ],
});

/** The models runs may use, plus selected ones the scope no longer allows, so they can be unchecked. */
const candidateChoices: SettingsChoiceSource<
    SubagentSettings["autoModels"][number],
    SubagentSettings
> & {
    multiple: true;
} = {
    multiple: true,
    rowLayout: "inline",
    emptyMessage: "No models are available. Configure a provider in Pi.",
    load: ({ context, values }) => {
        const models = allowedModels(context);
        const allowed = new Set(models.map((model) => formatModelRef(model)));
        const scoped = context.scopedModels.length > 0;

        return [
            ...models.map((model) => ({
                value: { provider: model.provider, id: model.id },
                label: model.id,
                badge: model.provider,
                searchText: `${formatModelRef(model)} ${model.name}`,
                description: `${model.name} · ${scoped ? "in Pi's scoped models" : "available in Pi"}`,
            })),
            ...values.autoModels
                .filter((model) => !allowed.has(formatModelRef(model)))
                .map((model) => ({
                    value: { provider: model.provider, id: model.id },
                    label: model.id,
                    badge: "Not allowed",
                    description: `${formatModelRef(model)} is not in Pi's scoped models now, so auto runs skip it. Uncheck it to remove it.`,
                })),
        ];
    },
};

export function createSubagentPanel(options: AgentsMenuOptions) {
    return defineSettingsPanel(subagentSettings, {
        id: "subagents",
        label: "Subagents",
        fields: (field) => [
            field("autoClassifier", {
                label: "Auto classifier",
                description:
                    "A Pi classifier that chooses the model of each run started with model auto, " +
                    "from its task. Without one, auto runs use the main session's model.",
                formatValue: (value) =>
                    value ? `${value.provider}/${value.id}` : "None · main session model",
                choiceSource: classifierChoices,
            }),
            field("autoModels", {
                label: "Auto candidates →",
                description:
                    "Models the classifier may choose, from Pi's scoped models (all available " +
                    "models without a scope). With none selected, it may choose any allowed model.",
                formatValue: (value) =>
                    value.length > 0 ? `${value.length} selected` : "All allowed models",
                choiceSource: candidateChoices,
            }),
        ],
        menus: [agentsMenu(options)],
    });
}
