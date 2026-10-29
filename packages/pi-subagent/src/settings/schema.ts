import { defineSettings, type DeepReadonly } from "@lune_99/pi-lune-extensions-core/settings";
import Type, { type Static } from "typebox";

import { DEFAULT_AUTO_MODEL_SETTINGS, type AutoModelSettings } from "../auto-model.ts";
import { AUTO_TIERS } from "../run/types.ts";

const modelReference = () =>
    Type.Object(
        { provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
    );

const tierModel = () => Type.Union([Type.Null(), modelReference()], { default: null });

export const subagentSchema = Type.Object(
    {
        allowedModels: Type.Array(modelReference(), { default: [], uniqueItems: true }),
        autoClassifier: Type.Union([Type.Null(), modelReference()], { default: null }),
        autoTiers: Type.Object(
            { light: tierModel(), standard: tierModel(), complex: tierModel(), deep: tierModel() },
            {
                additionalProperties: false,
                default: { light: null, standard: null, complex: null, deep: null },
            },
        ),
        autoRiskFloor: Type.Union(
            [
                Type.Literal("off"),
                Type.Literal("standard"),
                Type.Literal("complex"),
                Type.Literal("deep"),
            ],
            { default: DEFAULT_AUTO_MODEL_SETTINGS.riskFloor ?? "off" },
        ),
        autoRiskThreshold: Type.Number({
            minimum: 0,
            maximum: 1,
            default: DEFAULT_AUTO_MODEL_SETTINGS.riskThreshold,
        }),
    },
    { additionalProperties: false },
);

export type SubagentSettings = Static<typeof subagentSchema>;

export const subagentSettings = defineSettings({
    id: "pi-subagent",
    schema: subagentSchema,
    migrations: [
        // 1 → 2: one model per task tier replaced the list of candidate models.
        (overrides) => {
            delete overrides.autoModels;

            return overrides;
        },
    ],
});

export function autoModelSettings(
    settings: DeepReadonly<Omit<SubagentSettings, "allowedModels">>,
): AutoModelSettings {
    return {
        classifier: settings.autoClassifier ? { ...settings.autoClassifier } : null,
        tiers: Object.fromEntries(
            AUTO_TIERS.map((tier) => {
                const model = settings.autoTiers[tier];

                return [tier, model ? { ...model } : null];
            }),
        ) as AutoModelSettings["tiers"],
        riskFloor: settings.autoRiskFloor === "off" ? null : settings.autoRiskFloor,
        riskThreshold: settings.autoRiskThreshold,
    };
}
