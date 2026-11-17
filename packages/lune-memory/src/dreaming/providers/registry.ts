import { createModels, type Models } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import { errorMessage } from "../../core/util.ts";
import type { MemoryPaths } from "../../core/paths.ts";
import { FileCredentialStore } from "../credentials.ts";
import { customApiStreams } from "./apis.ts";
import { composeModelProvider } from "./compose.ts";
import { ModelConfig } from "./models-json.ts";

export interface ModelRegistry {
    models: Models;
    /** Why models.json or a provider of it did not load. Undefined when all loaded. */
    error: string | undefined;
    /**
     * The file itself did not parse or validate. No provider has the settings of the file then,
     * so a provider of pi-ai points at its default endpoint.
     */
    fileFailed: boolean;
}

/**
 * The providers of pi-ai and those of models.json, with the credential file of lune-memory. A
 * file that does not parse or validate loads no provider, as in Pi. A provider whose entry is not
 * usable is left out, and it does not fall back to the built-in provider of the same id: a
 * request must not go to another endpoint than the one that models.json names.
 */
export function loadModelRegistry(paths: MemoryPaths): ModelRegistry {
    const config = ModelConfig.load(paths.models);
    const models = createModels({ credentials: new FileCredentialStore(paths.credentials) });
    const errors: string[] = [];
    const configError = config.getError();
    if (configError) errors.push(configError);

    const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
    const streams = customApiStreams();
    for (const providerId of new Set([...builtins.keys(), ...config.getProviderIds()])) {
        const base = builtins.get(providerId);
        if (!config.getProvider(providerId)) {
            if (base) models.setProvider(base);
            continue;
        }
        try {
            models.setProvider(composeModelProvider(providerId, base, config, streams));
        } catch (error) {
            errors.push(`Provider "${providerId}": ${errorMessage(error)}`);
        }
    }
    return {
        models,
        error: errors.length > 0 ? errors.join("\n\n") : undefined,
        fileFailed: configError !== undefined,
    };
}
