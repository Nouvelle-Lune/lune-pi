import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsChoice, SettingsChoiceSource } from "@lune_99/pi-lune-extensions-core/panel";
import type { DeepReadonly } from "@lune_99/pi-lune-extensions-core/settings";

import { AUTO_MODEL, allowedModels, formatModelRef, type ModelRef } from "../models.ts";
import { AUTO_TIERS } from "../run/types.ts";
import type { SubagentSettings } from "./schema.ts";

export function defaultThinkingChoice(
    model: string | undefined,
    values: DeepReadonly<SubagentSettings>,
): SettingsChoice<ThinkingLevel | null> {
    return model === AUTO_MODEL && values.autoClassifier
        ? {
              value: null,
              label: "Automatic thinking",
              description:
                  "Leave thinking out: the classifier chooses a supported level for each task. " +
                  "If classification fails, runs use the main agent's thinking.",
          }
        : {
              value: null,
              label: "Main agent's thinking",
              description:
                  "Leave thinking out: runs use the main agent's level within model limits.",
          };
}

export function thinkingChoices(
    model: string | undefined,
    values: DeepReadonly<SubagentSettings>,
): SettingsChoiceSource<ThinkingLevel | null> {
    return {
        load: ({ context }) => {
            const models = thinkingModels(context, model, values);
            const [first, ...rest] = models.map(getSupportedThinkingLevels);
            const levels = first!.filter((level) => rest.every((each) => each.includes(level)));
            const fallback = defaultThinkingChoice(model, values);

            return [
                levels.length > 0
                    ? fallback
                    : {
                          ...fallback,
                          description:
                              "These models have no shared thinking level. Leave thinking out so " +
                              "each task uses a supported level.",
                      },
                ...levels.map((level) => ({ value: level, label: level })),
            ];
        },
    };
}

function thinkingModels(
    context: ExtensionContext,
    model: string | undefined,
    values: DeepReadonly<SubagentSettings>,
): Model<Api>[] {
    const allowed = (): Model<Api>[] => allowedModels(context, values.allowedModels);
    const selected = (ref: string, models: readonly Model<Api>[]): Model<Api> => {
        const found = models.find((each) => formatModelRef(each) === ref);

        if (!found) {
            throw new Error(
                `The model ${ref} is unavailable or not in the subagent allowed set. ` +
                    "Select an available model before choosing thinking.",
            );
        }

        return found;
    };

    if (model !== undefined && model !== AUTO_MODEL) {
        return [selected(model, allowed())];
    }

    if (!context.model) {
        throw new Error("The main agent has no current model for thinking choices.");
    }

    if (model !== AUTO_MODEL || !values.autoClassifier) {
        return [context.model];
    }

    // A failed classifier uses the main model even when every tier has its own model.
    const models = allowed();
    const refs = AUTO_TIERS.map((tier) => values.autoTiers[tier]).filter(
        (ref): ref is ModelRef => ref !== null,
    );

    return [context.model, ...refs.map((ref) => selected(formatModelRef(ref), models))];
}
