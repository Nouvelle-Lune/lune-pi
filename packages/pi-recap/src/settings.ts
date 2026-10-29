import { Type, type Static } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineSettings, type SettingsView } from "@lune_99/pi-lune-extensions-core/settings";

export const recapSchema = Type.Object({
    enabled: Type.Boolean({ default: false }),
    maxRetries: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 3 }),
    model: Type.Union(
        [
            Type.Null(),
            Type.Object({
                provider: Type.String({ minLength: 1 }),
                id: Type.String({ minLength: 1 }),
            }),
        ],
        { default: null },
    ),
    thinkingLevel: Type.Union(
        [
            Type.Literal("off"),
            Type.Literal("minimal"),
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("xhigh"),
            Type.Literal("max"),
        ],
        { default: "off" },
    ),
});
export type RecapSettings = Static<typeof recapSchema>;
export type RecapSettingsView = SettingsView<typeof recapSchema>;

/** Resolve references at use time so registry changes cannot leave a cached model behind. */
export function resolveRecapModel(ctx: ExtensionContext, settings: RecapSettings) {
    return settings.model
        ? ctx.modelRegistry.find(settings.model.provider, settings.model.id)
        : ctx.model;
}

export const recapSettings = defineSettings({
    id: "pi-recap",
    schema: recapSchema,
});
