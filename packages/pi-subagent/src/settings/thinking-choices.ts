import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsChoice, SettingsChoiceSource } from "@lune_99/pi-lune-extensions-core/panel";
import type { DeepReadonly } from "@lune_99/pi-lune-extensions-core/settings";

import { AUTO_MODEL, allowedModels, formatModelRef } from "../models.ts";
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
    current?: ThinkingLevel,
): SettingsChoiceSource<ThinkingLevel | null> {
    return {
        load: ({ context }) => {
            const fallback = defaultThinkingChoice(model, values);

            if (model === AUTO_MODEL) {
                return [fallback];
            }

            const levels = getSupportedThinkingLevels(thinkingModel(context, model, values));

            return [
                fallback,
                ...levels.map((level) => ({ value: level, label: level })),
                ...(current !== undefined && !levels.includes(current)
                    ? [
                          {
                              value: current,
                              label: `${current} · saved, unsupported`,
                              disabled:
                                  "This saved level is not supported by the current model selection. " +
                                  "Choose another level or remove the override.",
                          },
                      ]
                    : []),
            ];
        },
    };
}

function thinkingModel(
    context: ExtensionContext,
    model: string | undefined,
    values: DeepReadonly<SubagentSettings>,
): Model<Api> {
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
        return selected(model, allowed());
    }

    if (!context.model) {
        throw new Error("The main agent has no current model for thinking choices.");
    }

    return context.model;
}
