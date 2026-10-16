/**
 * Pi-owned model discovery adapted to the Panel choice-source contract.
 *
 * Persist provider/ID references, not model objects or Core catalogue identities.
 * scoped/all filters only candidates; the editor's global/project write scope stays
 * independent. This module imports Pi AI types only and owns no model cache/execution.
 */
import { Value } from "typebox/value";
import type { ModelType, ModelTypeMap } from "@earendil-works/pi-ai";
import type { SettingsChoiceSource, SettingsChoice, SettingsChoiceContext } from "../section.ts";

/** Stable persisted identity; consumers resolve availability/execution through Pi. */
export interface ModelReference {
    readonly provider: string;
    readonly id: string;
}
/** Candidate ranges, unrelated to SettingsScope; scoped is supported only for chat. */
export type ModelChoiceScope = "scoped" | "all";
/** Discovery/presentation options; business fallback and thinking policy stay caller-owned. */
export interface ModelChoicesOptions<TType extends ModelType, TSpecial, TValues> {
    /** Defaults to chat; classifier/image use Pi's available typed discovery. */
    type?: TType;
    /** Unique, nonempty ranges; chat defaults to scoped/all, other types to all only. */
    scopes?: readonly (TType extends "chat" ? ModelChoiceScope : "all")[];
    /** Shown only when the resulting list (including special choices) is empty. */
    emptyMessage?: string;
    /**
     * Prefix consumer values such as "follow session". A callback receives scoped,
     * available, deduplicated native Pi models; it must not mutate those borrowed models.
     * Static values are cloned at declaration; callbacks are retained, not evaluated now.
     */
    specialChoices?:
        | readonly SettingsChoice<TSpecial>[]
        | ((
              context: SettingsChoiceContext<TValues>,
              models: readonly ModelTypeMap[TType][],
          ) => readonly SettingsChoice<TSpecial>[]);
}

/**
 * Build a dynamic source without changing the session model or running inference.
 *
 * Chat filters Pi's available models by provider/ID in scopedModels order, or uses
 * all available entries. Explicit empty/unavailable scoped lists never broaden to all.
 * The default range is scoped when configured/declared, otherwise a declared all range.
 * Classifier/image queries receive the editor's abort signal; cancellation is rechecked
 * after discovery/special callbacks so late results cannot become selectable.
 *
 * Explicit refresh may use network and surfaces provider/cancellation errors. Invalid
 * type/range declarations throw immediately; loaded choice values are schema-validated
 * by the selector. Persisted references require consumer-owned resolution/execution.
 */
export function modelChoices<TType extends ModelType = "chat", TSpecial = never, TValues = unknown>(
    options: ModelChoicesOptions<TType, TSpecial, TValues> = {},
): SettingsChoiceSource<ModelReference | TSpecial, TValues> {
    const type = options.type === undefined ? "chat" : options.type;
    if (!["chat", "classifier", "image"].includes(type)) throw new TypeError("Invalid model type");
    const scopes: readonly ModelChoiceScope[] = Object.freeze([
        ...(options.scopes ?? (type === "chat" ? ["scoped", "all"] : ["all"])),
    ]);
    if (
        !scopes.length ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => scope !== "scoped" && scope !== "all")
    )
        throw new TypeError("Model candidate scopes must be unique and nonempty");
    if (type !== "chat" && scopes.includes("scoped"))
        throw new TypeError("Pi scoped models only contain chat models");
    const special =
        typeof options.specialChoices === "function"
            ? options.specialChoices
            : (options.specialChoices?.map((choice) => ({
                  ...choice,
                  value: Value.Clone(choice.value),
              })) ?? []);
    const emptyMessage = options.emptyMessage;
    const defaultScope = (context: SettingsChoiceContext["context"]) =>
        scopes.includes("scoped") && context.scopedModels.length
            ? "scoped"
            : scopes.includes("all")
              ? "all"
              : scopes[0]!;
    return {
        rowLayout: "inline",
        scopes,
        defaultScope,
        emptyMessage,
        async load(context) {
            context.signal.throwIfAborted();
            const scope = context.candidateScope ?? defaultScope(context.context);
            if (!scopes.includes(scope as ModelChoiceScope))
                throw new TypeError(`Invalid model candidate scope "${scope}"`);
            const { modelRegistry, scopedModels } = context.context;
            let models: readonly ModelTypeMap[ModelType][];
            if (type === "chat") {
                const available = modelRegistry.getAvailable();
                models =
                    scope === "all"
                        ? available
                        : scopedModels.flatMap((entry) => {
                              const model = available.find(
                                  (model) =>
                                      model.provider === entry.model.provider &&
                                      model.id === entry.model.id,
                              );
                              return model ? [model] : [];
                          });
            } else {
                models = await modelRegistry.getAvailableOfType(type, undefined, {
                    signal: context.signal,
                });
            }
            context.signal.throwIfAborted();
            const seen = new Set<string>();
            models = models.filter((model) => {
                const key = JSON.stringify([model.provider, model.id]);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            const specials =
                typeof special === "function"
                    ? special(context, models as readonly ModelTypeMap[TType][])
                    : special;
            context.signal.throwIfAborted();
            return [
                ...specials,
                ...models.map((model) => {
                    const providerName = modelRegistry.getProviderDisplayName(model.provider);
                    const thinking =
                        type === "chat"
                            ? scopedModels.find(
                                  (entry) =>
                                      entry.model.provider === model.provider &&
                                      entry.model.id === model.id,
                              )?.thinkingLevel
                            : undefined;
                    return {
                        value: { provider: model.provider, id: model.id },
                        label: model.id,
                        badge: model.provider,
                        searchText: `${model.provider}/${model.id} ${model.name} ${providerName}`,
                        description: `Model Name: ${model.name} · ${providerName}${thinking ? ` · scoped thinking: ${thinking}` : ""}`,
                    };
                }),
            ];
        },
        async refresh({ context, signal }) {
            signal.throwIfAborted();
            const result = await context.modelRegistry.refresh({
                signal,
                allowNetwork: true,
                force: true,
            });
            signal.throwIfAborted();
            if (result.aborted) throw new DOMException("Model refresh cancelled", "AbortError");
            if (result.errors.size)
                throw new AggregateError(
                    [...result.errors.values()],
                    [...result.errors]
                        .map(([provider, error]) => `${provider}: ${error.message}`)
                        .join("; "),
                );
        },
    };
}
