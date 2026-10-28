import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelRef {
    provider: string;
    id: string;
}

/** The `model` value that lets a classifier choose the run's model; never a `provider/id`. */
export const AUTO_MODEL = "auto";

/** Split `provider/id` at the first slash; model IDs may contain more slashes. */
export function parseModelRef(ref: string): ModelRef | undefined {
    const slash = ref.indexOf("/");

    if (slash <= 0 || slash === ref.length - 1) {
        return undefined;
    }

    return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export function formatModelRef(model: ModelRef): string {
    return `${model.provider}/${model.id}`;
}

/**
 * The models `subagent_start` may name: the parent's model scope (`--models` or `enabledModels`),
 * or every available model when no scope is configured.
 */
export function allowedModelRefs(ctx: ExtensionContext): string[] {
    return allowedModels(ctx).map((model) => formatModelRef(model));
}

/** The models of `allowedModelRefs`, once each, in scope order. */
export function allowedModels(ctx: ExtensionContext): Model<Api>[] {
    const models =
        ctx.scopedModels.length > 0
            ? ctx.scopedModels.map((scoped) => scoped.model)
            : ctx.modelRegistry.getAvailable();
    const seen = new Set<string>();

    return models.filter((model) => {
        const ref = formatModelRef(model);

        if (seen.has(ref)) {
            return false;
        }

        seen.add(ref);

        return true;
    });
}
