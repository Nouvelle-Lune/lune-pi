import { defineSettings, type DeepReadonly } from "@lune_99/pi-lune-extensions-core/settings";
import Type, { type Static } from "typebox";

import type { AutoModelSettings } from "../auto-model.ts";
import { AUTO_TIERS } from "../run/types.ts";

const modelReference = () =>
    Type.Object(
        { provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
    );

const tierModel = () => Type.Union([Type.Null(), modelReference()], { default: null });

export const subagentSchema = Type.Object(
    {
        autoClassifier: Type.Union([Type.Null(), modelReference()], { default: null }),
        autoTiers: Type.Object(
            { light: tierModel(), standard: tierModel(), complex: tierModel(), deep: tierModel() },
            {
                additionalProperties: false,
                default: { light: null, standard: null, complex: null, deep: null },
            },
        ),
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

export function autoModelSettings(settings: DeepReadonly<SubagentSettings>): AutoModelSettings {
    return {
        classifier: settings.autoClassifier ? { ...settings.autoClassifier } : null,
        tiers: Object.fromEntries(
            AUTO_TIERS.map((tier) => {
                const model = settings.autoTiers[tier];

                return [tier, model ? { ...model } : null];
            }),
        ) as AutoModelSettings["tiers"],
    };
}
