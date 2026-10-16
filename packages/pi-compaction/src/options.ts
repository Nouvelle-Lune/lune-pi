import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelReference } from "@lune_99/pi-lune-extensions-core/panel";

export interface CompactionPolicy {
    readonly deleteThreshold: number;
    /** Tool names explicitly allowed to lose their whole call. */
    readonly deletableTools: readonly string[];
}

/** A null model selects the first available Pi classifier at run time. */
export type JevOptions =
    | { readonly enabled: false }
    | { readonly enabled: true; readonly model: ModelReference | null };

export interface CompactionOptions {
    readonly summaryModel: ModelReference;
    readonly summaryThinkingLevel: ModelThinkingLevel;
    readonly jev: JevOptions;
    readonly policy: CompactionPolicy;
}

/** Explicit null disables Lune interception and leaves the native Pi operation untouched. */
export type ConfigurationProvider = (
    ctx: ExtensionContext,
) => CompactionOptions | null | Promise<CompactionOptions | null>;

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = Object.freeze({
    deleteThreshold: 0.7,
    deletableTools: Object.freeze([
        "read",
        "grep",
        "find",
        "ls",
        "codemode",
        "bash",
        "edit",
        "powershell",
        "tool_search",
    ]),
});

/** Embedded providers bypass settings schema validation, so every operation rechecks its options. */
export function validateOptions(options: CompactionOptions): void {
    const identity = options.summaryModel;
    if (!identity.provider.trim() || !identity.id.trim())
        throw new Error("A summary model must be explicitly selected");
    const policy = options.policy;
    if (
        !Number.isFinite(policy.deleteThreshold) ||
        policy.deleteThreshold < 0 ||
        policy.deleteThreshold > 1
    ) {
        throw new Error("deleteThreshold must be between 0 and 1, inclusive");
    }
    if (
        new Set(policy.deletableTools).size !== policy.deletableTools.length ||
        policy.deletableTools.some((name) => !name.trim())
    ) {
        throw new Error("deletableTools must contain unique, non-empty tool names");
    }
    if (
        options.jev.enabled &&
        options.jev.model &&
        (!options.jev.model.provider.trim() || !options.jev.model.id.trim())
    ) {
        throw new Error("Classifier reference must contain a provider and model id");
    }
}
