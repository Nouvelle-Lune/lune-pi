import {
    defineSettingsPanel,
    modelChoices,
    type ModelReference,
    type SettingsChoiceSource,
} from "@lune_99/pi-lune-extensions-core/panel";

import { allowedModels, formatModelRef } from "../models.ts";
import { AUTO_TIERS, type AutoTier } from "../run/types.ts";
import { formatPercent } from "../tools/format.ts";
import { agentsMenu, type AgentsMenuOptions } from "./agents-menu.ts";
import { subagentSettings, type SubagentSettings } from "./schema.ts";

const classifierChoices: SettingsChoiceSource<ModelReference | null> = modelChoices({
    type: "classifier",
    specialChoices: (_context, classifiers) => [
        {
            value: null,
            label: "None · main session model",
            description: classifiers.length
                ? "Runs started with model auto use the main session's model and thinking."
                : "No classifier is available. Configure a classifier provider in Pi with /login " +
                  "or its environment credentials, then press Ctrl+R to refresh.",
        },
    ],
});

const TIERS: Record<AutoTier, { label: string; description: string }> = {
    light: {
        label: "Light",
        description: "Tasks that find, read or run something and report what it shows.",
    },
    standard: {
        label: "Standard",
        description: "Clear, well-specified changes and checks with a known path.",
    },
    complex: {
        label: "Complex",
        description: "Several steps across files or sources toward a clear goal.",
    },
    deep: {
        label: "Deep",
        description: "Design decisions, trade-offs, unclear failures and reviews for subtle bugs.",
    },
};

/** The models runs may use, plus a selected one the scope no longer allows, so it can change. */
function tierChoices(
    tier: AutoTier,
): SettingsChoiceSource<SubagentSettings["autoTiers"][AutoTier], SubagentSettings> {
    return {
        rowLayout: "inline",
        load: ({ context, values }) => {
            const models = allowedModels(context);
            const allowed = new Set(models.map((model) => formatModelRef(model)));
            const current = values.autoTiers[tier];

            return [
                { value: null, label: "None", description: emptyTier(tier) },
                ...models.map((model) => ({
                    value: { provider: model.provider, id: model.id },
                    label: model.id,
                    badge: model.provider,
                    searchText: `${formatModelRef(model)} ${model.name}`,
                    description: model.name,
                })),
                ...(current && !allowed.has(formatModelRef(current))
                    ? [
                          {
                              value: { provider: current.provider, id: current.id },
                              label: current.id,
                              badge: "Not allowed",
                              description: `${formatModelRef(current)} is not in Pi's scoped models now, so auto runs of this tier fail to start. Select another model.`,
                          },
                      ]
                    : []),
            ];
        },
    };
}

function emptyTier(tier: AutoTier): string {
    return tier === "deep"
        ? "These tasks use the main agent's model."
        : "These tasks use the next tier up that has a model, else the main agent's model.";
}

export function createSubagentPanel(options: AgentsMenuOptions) {
    return defineSettingsPanel(subagentSettings, {
        id: "subagents",
        label: "Subagents",
        fields: (field) => [
            field("autoClassifier", {
                label: "Auto classifier",
                description:
                    "A Pi classifier that rates each task of a run started with model auto; the " +
                    "rating picks the tier's model and, unless the start sets it, the thinking " +
                    "level. Without one, auto runs use the main session's model and thinking.",
                formatValue: (value) =>
                    value ? `${value.provider}/${value.id}` : "None · main session model",
                choiceSource: classifierChoices,
            }),
            ...AUTO_TIERS.map((tier) =>
                field(["autoTiers", tier], {
                    label: TIERS[tier].label,
                    description: `${TIERS[tier].description} Without a model: ${emptyTier(tier)}`,
                    inMenu: "tiers",
                    formatValue: (value) =>
                        value
                            ? `${value.provider}/${value.id}`
                            : tier === "deep"
                              ? "None · main agent's model"
                              : "None · next tier up",
                    choiceSource: tierChoices(tier),
                }),
            ),
            field("autoRiskFloor", {
                label: "High-risk floor",
                description:
                    "The lowest tier whose model a high-risk task may use. A task is high risk " +
                    "when a mistake in it could seriously harm security, privacy, data, money or " +
                    "production. The rated tier stays as it is; only the model rises. This is a " +
                    "model choice only: it changes no tool permission or approval.",
                inMenu: "tiers",
                choices: [
                    {
                        value: "off",
                        label: "Off",
                        description: "High-risk tasks use the model of their rated tier.",
                    },
                    {
                        value: "standard",
                        label: "Standard",
                        description: "High-risk tasks use at least the Standard model.",
                    },
                    {
                        value: "complex",
                        label: "Complex",
                        description: "High-risk tasks use at least the Complex model.",
                    },
                    {
                        value: "deep",
                        label: "Deep",
                        description:
                            "High-risk tasks use the Deep model, else the main agent's model.",
                    },
                ],
            }),
            field("autoRiskThreshold", {
                label: "High-risk threshold",
                description:
                    "The classifier's probability, from 0 to 1, from which a task counts as high " +
                    "risk. A missed high-risk task usually costs more than a false alarm, so the " +
                    "default 0.4 is below one half. Adjust it with your own tasks.",
                inMenu: "tiers",
                formatValue: (value) => formatPercent(value),
            }),
        ],
        menus: [
            {
                id: "tiers",
                label: "Auto tiers",
                description:
                    "The model for each task tier of runs started with model auto, from Pi's " +
                    "scoped models. A tier without a model uses the next tier up that has one, " +
                    "and the main agent's model is the last step. The high-risk floor raises the " +
                    "model of tasks rated high risk.",
                summary: ({ values }) => {
                    const set = AUTO_TIERS.filter((tier) => values.autoTiers[tier]).length;

                    return set === 0
                        ? "none set · main agent's model"
                        : `${set} of ${AUTO_TIERS.length} set`;
                },
            },
            agentsMenu(options),
        ],
    });
}
