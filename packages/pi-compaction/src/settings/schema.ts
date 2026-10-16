import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsView, DeepReadonly } from "@lune_99/pi-lune-extensions-core/settings";
import { DEFAULT_COMPACTION_POLICY, validateOptions, type CompactionOptions } from "../options.ts";

export const SETTINGS_ID = "pi-compaction";

const modelReference = () =>
    Type.Union(
        [
            Type.Null(),
            Type.Object(
                { provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) },
                { additionalProperties: false },
            ),
        ],
        { default: null },
    );

export const compactionSchema = Type.Object(
    {
        enabled: Type.Boolean({ default: true }),
        summaryModel: modelReference(),
        summaryThinkingLevel: StringEnum(
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
            { default: "off" },
        ),
        jevEnabled: Type.Boolean({ default: false }),
        classifier: modelReference(),
        policy: Type.Object(
            {
                deleteThreshold: Type.Number({ minimum: 0, maximum: 1 }),
                deletableTools: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
            },
            {
                default: {
                    ...DEFAULT_COMPACTION_POLICY,
                    deletableTools: [...DEFAULT_COMPACTION_POLICY.deletableTools],
                },
                additionalProperties: false,
            },
        ),
    },
    { additionalProperties: false },
);

export type CompactionSettings = Static<typeof compactionSchema>;
export type CompactionSettingsView = SettingsView<typeof compactionSchema>;

export function resolveCompactionSettings(
    settings: DeepReadonly<CompactionSettings>,
    session?: Pick<ExtensionContext, "model" | "thinkingLevel">,
): CompactionOptions | null {
    if (!settings.enabled) return null;
    const summaryModel = settings.summaryModel ?? session?.model;
    if (!summaryModel) throw new Error("No session model is available for the compaction summary");
    const options: CompactionOptions = {
        summaryModel: { provider: summaryModel.provider, id: summaryModel.id },
        summaryThinkingLevel: settings.summaryModel
            ? settings.summaryThinkingLevel
            : (session?.thinkingLevel ?? "off"),
        policy: { ...settings.policy, deletableTools: [...settings.policy.deletableTools] },
        jev: settings.jevEnabled
            ? { enabled: true, model: settings.classifier }
            : { enabled: false },
    };
    validateOptions(options);
    return options;
}
