import { defineSettings, type DeepReadonly } from "@lune_99/pi-lune-extensions-core/settings";
import Type, { type Static } from "typebox";

import type { AutoModelSettings } from "../auto-model.ts";

const modelReference = () =>
    Type.Object(
        { provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
    );

export const subagentSchema = Type.Object(
    {
        autoClassifier: Type.Union([Type.Null(), modelReference()], { default: null }),
        autoModels: Type.Array(modelReference(), { default: [], uniqueItems: true }),
    },
    { additionalProperties: false },
);

export type SubagentSettings = Static<typeof subagentSchema>;

export const subagentSettings = defineSettings({ id: "pi-subagent", schema: subagentSchema });

export function autoModelSettings(settings: DeepReadonly<SubagentSettings>): AutoModelSettings {
    return {
        classifier: settings.autoClassifier ? { ...settings.autoClassifier } : null,
        candidates: settings.autoModels.map((model) => ({ ...model })),
    };
}
