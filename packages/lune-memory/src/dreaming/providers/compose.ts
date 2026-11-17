/**
 * Build a pi-ai provider from an entry of models.json. This is provider-composer.ts of the Pi
 * coding agent (MIT, see THIRD_PARTY_NOTICES.md). Left out: extension providers, OAuth
 * gateways, image and classifier models, and remote model catalogs.
 */
import {
    lazyStream,
    type Api,
    type ApiKeyAuth,
    type AssistantMessageEventStream,
    type AuthContext,
    type AuthInteraction,
    type AuthResult,
    type Credential,
    type FetchFunction,
    type Model,
    type ModelAuth,
    type OAuthAuth,
    type Provider,
    type ProviderHeaders,
    type ProviderStreams,
    type SimpleStreamOptions,
    type StreamOptions,
    type TranscriptContext,
} from "@earendil-works/pi-ai";

import { validateApiKey, validateRequestHeaders } from "../http-headers.ts";
import { CUSTOM_APIS, isCustomApi, type CustomApi } from "./apis.ts";
import {
    getConfigValueEnvVarNames,
    isCommandConfigValue,
    resolveConfigValueOrThrow,
    resolveHeadersOrThrow,
} from "./config-value.ts";
import {
    normalizeBaseUrl,
    type ModelConfig,
    type ModelsJsonModel,
    type ModelsJsonModelOverride,
    type ModelsJsonProvider,
} from "./models-json.ts";

/**
 * A request to a custom endpoint never follows a redirect. fetch keeps x-api-key and custom
 * headers when a redirect leaves the origin, and the body holds the session text. The OpenAI
 * client reads the status of a redirect as an error, so the user sees it and fixes the base URL.
 */
const refuseRedirects: FetchFunction = (input, init) =>
    fetch(input, { ...init, redirect: "manual" });

function mergeCompat(
    base: Model<Api>["compat"],
    override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
    if (!override) return base;
    const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
    const baseNested = base as Record<string, unknown> | undefined;
    const overrideNested = override as Record<string, unknown>;
    const mergedNested = merged as Record<string, unknown>;
    for (const key of [
        "openRouterRouting",
        "vercelGatewayRouting",
        "chatTemplateKwargs",
        "chatTemplateArgs",
    ] as const) {
        const baseValue = baseNested?.[key];
        const overrideValue = overrideNested[key];
        if (
            (typeof baseValue === "object" && baseValue !== null) ||
            (typeof overrideValue === "object" && overrideValue !== null)
        ) {
            mergedNested[key] = {
                ...(baseValue as object | undefined),
                ...(overrideValue as object | undefined),
            };
        }
    }
    return merged;
}

function mergeInputLimits(
    base: Model<Api>["inputLimits"],
    override: ModelsJsonModelOverride["inputLimits"],
): Model<Api>["inputLimits"] {
    if (!override) return base;
    return {
        ...base,
        ...override,
        images: override.images
            ? {
                  ...base?.images,
                  ...override.images,
                  resize: override.images.resize
                      ? { ...base?.images?.resize, ...override.images.resize }
                      : base?.images?.resize,
              }
            : base?.images,
    };
}

function mergeSamplingParamsByThinkingLevel(
    base: Model<Api>["samplingParamsByThinkingLevel"],
    override: Model<Api>["samplingParamsByThinkingLevel"],
): Model<Api>["samplingParamsByThinkingLevel"] {
    if (!override) return base;
    const merged = { ...base };
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
        const params = override[level];
        if (params) merged[level] = { ...base?.[level], ...params };
    }
    return merged;
}

function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
    return {
        ...model,
        name: override.name ?? model.name,
        reasoning: override.reasoning ?? model.reasoning,
        thinkingLevelMap: override.thinkingLevelMap
            ? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
            : model.thinkingLevelMap,
        input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
        inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
        cost: override.cost
            ? {
                  input: override.cost.input ?? model.cost.input,
                  output: override.cost.output ?? model.cost.output,
                  cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
                  cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
                  tiers: override.cost.tiers ?? model.cost.tiers,
              }
            : model.cost,
        promptCache: override.promptCache
            ? { ...model.promptCache, ...override.promptCache }
            : model.promptCache,
        contextWindow: override.contextWindow ?? model.contextWindow,
        maxTokens: override.maxTokens ?? model.maxTokens,
        samplingParams: override.samplingParams
            ? { ...model.samplingParams, ...override.samplingParams }
            : model.samplingParams,
        samplingParamsByThinkingLevel: mergeSamplingParamsByThinkingLevel(
            model.samplingParamsByThinkingLevel,
            override.samplingParamsByThinkingLevel,
        ),
        compat: mergeCompat(model.compat, override.compat),
    };
}

function modelFromJson(
    providerId: string,
    definition: ModelsJsonModel,
    providerConfig: ModelsJsonProvider,
    defaults: Model<Api> | undefined,
): Model<Api> {
    const api = definition.api ?? providerConfig.api ?? defaults?.api;
    if (!api) {
        throw new Error(
            `Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
        );
    }
    const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
    if (!baseUrl) {
        throw new Error(
            `Provider ${providerId}: "baseUrl" is required when defining custom models.`,
        );
    }
    return {
        id: definition.id,
        name: definition.name ?? definition.id,
        api: api as Api,
        provider: providerId,
        baseUrl: normalizeBaseUrl(baseUrl),
        reasoning: definition.reasoning ?? false,
        thinkingLevelMap: definition.thinkingLevelMap,
        input: (definition.input ?? ["text"]) as ("text" | "image")[],
        inputLimits: definition.inputLimits,
        cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        promptCache: definition.promptCache,
        contextWindow: definition.contextWindow ?? 128000,
        maxTokens: definition.maxTokens ?? 16384,
        samplingParams: definition.samplingParams,
        samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel,
        headers: undefined,
        compat: mergeCompat(providerConfig.compat, definition.compat),
    };
}

function findModelDefaults(
    models: readonly Model<Api>[],
    modelId: string,
    api?: Api,
): Model<Api> | undefined {
    return (
        models.find((model) => model.id === modelId) ??
        (api ? models.find((model) => model.api === api) : undefined) ??
        models.find((model) => model.api === "openai-completions") ??
        models[0]
    );
}

function applyModelsJson(
    providerId: string,
    baseModels: readonly Model<Api>[],
    config: ModelsJsonProvider,
): Model<Api>[] {
    const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
    if (
        !config.models?.length &&
        !config.baseUrl &&
        !config.headers &&
        !config.compat &&
        !hasOverrides &&
        !config.apiKey &&
        config.authHeader === undefined
    ) {
        throw new Error(
            `Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
        );
    }

    const models: Model<Api>[] = baseModels.map((model) => ({
        ...model,
        baseUrl: config.baseUrl ?? model.baseUrl,
        compat: mergeCompat(model.compat, config.compat),
    }));
    for (const definition of config.models ?? []) {
        const existingIndex = models.findIndex((model) => model.id === definition.id);
        const defaults = findModelDefaults(
            models,
            definition.id,
            (definition.api ?? config.api) as Api | undefined,
        );
        const model = modelFromJson(providerId, definition, config, defaults);
        if (existingIndex >= 0) models[existingIndex] = model;
        else models.push(model);
    }
    return models;
}

function withConfiguredAuth(
    auth: ModelAuth,
    headers: Record<string, string> | undefined,
    authHeader: boolean,
): ModelAuth {
    if (auth.apiKey !== undefined) validateApiKey(auth.apiKey);
    let mergedHeaders: ProviderHeaders | undefined =
        auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
    if (authHeader) {
        if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
        mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
    }
    validateRequestHeaders(mergedHeaders);
    return { ...auth, headers: mergedHeaders };
}

async function configContextEnv(
    values: readonly string[],
    ctx: AuthContext,
    explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
    const env = { ...explicit };
    for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
        if (env[name] !== undefined) continue;
        const value = await ctx.env(name);
        if (value !== undefined) env[name] = value;
    }
    return Object.keys(env).length > 0 ? env : undefined;
}

function composeApiKeyAuth(
    providerId: string,
    base: Provider | undefined,
    config: ModelsJsonProvider,
): ApiKeyAuth | undefined {
    const inherited = base?.auth.apiKey;
    const rawKey = config.apiKey;
    const oauth = base?.auth.oauth;
    // OAuth-only providers get no fabricated API-key login method.
    if (!inherited && rawKey === undefined && oauth) return undefined;
    const rawHeaders = config.headers;
    const authHeader = config.authHeader ?? false;
    return {
        name: inherited?.name ?? "API key",
        login:
            inherited?.login ??
            (async (interaction: AuthInteraction) => ({
                type: "api_key",
                key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
            })),
        check: async (input) => {
            if (input.credential) {
                if (inherited?.check) return inherited.check(input);
                if (input.credential.key) return { type: "api_key", source: "stored credential" };
                const resolved = await inherited?.resolve(input);
                return resolved ? { type: "api_key", source: resolved.source } : undefined;
            }
            if (rawKey !== undefined) {
                if (isCommandConfigValue(rawKey)) {
                    return { type: "api_key", source: "configured API key" };
                }
                for (const name of getConfigValueEnvVarNames(rawKey)) {
                    if ((await input.ctx.env(name)) === undefined) return undefined;
                }
                return { type: "api_key", source: "configured API key" };
            }
            if (inherited?.check) return inherited.check(input);
            const resolved = await inherited?.resolve(input);
            return resolved ? { type: "api_key", source: resolved.source } : undefined;
        },
        resolve: async (input) => {
            let result: AuthResult | undefined;
            if (input.credential) {
                if (input.credential.key !== undefined) validateApiKey(input.credential.key);
                result = inherited
                    ? await inherited.resolve(input)
                    : input.credential.key
                      ? {
                            auth: { apiKey: input.credential.key },
                            env: input.credential.env,
                            source: "stored credential",
                        }
                      : undefined;
            } else if (rawKey !== undefined) {
                const env = await configContextEnv([rawKey], input.ctx);
                const key = resolveConfigValueOrThrow(
                    rawKey,
                    `API key for provider "${providerId}"`,
                    env,
                );
                validateApiKey(key);
                result = inherited
                    ? await inherited.resolve({ ...input, credential: { type: "api_key", key } })
                    : { auth: { apiKey: key }, source: "configured API key" };
            } else {
                result = await inherited?.resolve(input);
            }
            if (!result) return undefined;
            const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
            const headerEnv = await configContextEnv(
                Object.values(rawHeaders ?? {}),
                input.ctx,
                explicitEnv,
            );
            const headers = resolveHeadersOrThrow(
                rawHeaders,
                `provider "${providerId}"`,
                headerEnv,
            );
            return { ...result, auth: withConfiguredAuth(result.auth, headers, authHeader) };
        },
    };
}

function composeOAuthAuth(
    providerId: string,
    base: Provider | undefined,
    config: ModelsJsonProvider,
): OAuthAuth | undefined {
    const oauth = base?.auth.oauth;
    if (!oauth) return undefined;
    const rawHeaders = config.headers;
    const authHeader = config.authHeader ?? false;
    return {
        ...oauth,
        toAuth: async (credential) => {
            const auth = await oauth.toAuth(credential);
            const env = credential.env;
            const headers = resolveHeadersOrThrow(
                rawHeaders,
                `provider "${providerId}"`,
                typeof env === "object" && env !== null
                    ? (env as Record<string, string>)
                    : undefined,
            );
            return withConfiguredAuth(auth, headers, authHeader);
        },
    };
}

/** A header of a later layer replaces one of an earlier layer by name, ignoring case. */
function mergeHeaders(
    base: ProviderHeaders | undefined,
    override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
    if (!base && !override) return undefined;
    const merged = { ...base };
    for (const [name, value] of Object.entries(override ?? {})) {
        const lowerName = name.toLowerCase();
        for (const existingName of Object.keys(merged)) {
            if (existingName.toLowerCase() === lowerName) delete merged[existingName];
        }
        merged[name] = value;
    }
    return merged;
}

function rawModelHeaders(
    model: Model<Api>,
    config: ModelsJsonProvider,
): Record<string, string> | undefined {
    const definition = config.models?.find((entry) => entry.id === model.id);
    const headers = {
        ...config.modelOverrides?.[model.id]?.headers,
        ...definition?.headers,
    };
    return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Compose the entry of one provider in models.json with the built-in provider of the same id, if
 * there is one. It throws when the entry is not usable, so the caller can leave the provider out.
 * Without a built-in provider, `streams` runs the three protocols of custom providers.
 */
export function composeModelProvider(
    providerId: string,
    base: Provider | undefined,
    modelConfig: ModelConfig,
    streams: Record<CustomApi, ProviderStreams>,
): Provider {
    const config = modelConfig.getProvider(providerId);
    if (!config) throw new Error(`Provider ${providerId}: not in models.json.`);
    if (config.oauth) {
        throw new Error(`Provider ${providerId}: "oauth" is not supported by lune-memory.`);
    }
    if (config.baseUrl) normalizeBaseUrl(config.baseUrl);

    const supportsBaseApi = (model: Model<Api>) =>
        base?.getModels().some((entry) => entry.api === model.api) ?? false;

    // models.json modelOverrides are the topmost layer: they apply once, after the models of
    // models.json are merged into the built-in ones.
    const models = applyModelsJson(providerId, base?.getModels() ?? [], config).map((model) => {
        const override = config.modelOverrides?.[model.id];
        return override ? applyModelOverride(model, override) : model;
    });
    for (const model of models) {
        if (!supportsBaseApi(model) && !isCustomApi(model.api)) {
            throw new Error(
                `Provider ${providerId}, model ${model.id}: api "${model.api}" is not supported. ` +
                    `Use ${CUSTOM_APIS.join(", ")}.`,
            );
        }
    }

    const apiKey = composeApiKeyAuth(providerId, base, config);
    const oauth = composeOAuthAuth(providerId, base, config);
    if (!apiKey && !oauth) {
        throw new Error(`Provider ${providerId}: no authentication method configured.`);
    }

    const streamWith = (
        model: Model<Api>,
        context: TranscriptContext,
        options: StreamOptions | undefined,
        simple: boolean,
    ): AssistantMessageEventStream =>
        lazyStream(model, async () => {
            if (options?.apiKey !== undefined) validateApiKey(options.apiKey);
            // Headers of a single model can hold `$ENV` and `!command` values, which resolve at the
            // request, as the keys do.
            const modelHeaders = resolveHeadersOrThrow(
                rawModelHeaders(model, config),
                `model "${model.provider}/${model.id}"`,
                options?.env,
            );
            const request: StreamOptions = {
                ...options,
                fetch: refuseRedirects,
                ...(modelHeaders ? { headers: mergeHeaders(options?.headers, modelHeaders) } : {}),
            };
            validateRequestHeaders(request.headers);
            const implementation =
                base && supportsBaseApi(model)
                    ? base
                    : isCustomApi(model.api)
                      ? streams[model.api]
                      : undefined;
            if (!implementation) throw new Error(`No API implementation for api: ${model.api}`);
            return simple
                ? implementation.streamSimple(model, context, request as SimpleStreamOptions)
                : implementation.stream(model, context, request);
        });

    return {
        id: providerId,
        name: config.name ?? base?.name ?? providerId,
        baseUrl: config.baseUrl ?? base?.baseUrl,
        headers: base?.headers,
        auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
        getModels: () => models,
        filterModels: base?.filterModels
            ? (list, credential: Credential | undefined) => base.filterModels!(list, credential)
            : undefined,
        stream: (model, context, options) => streamWith(model, context, options, false),
        streamSimple: (model, context, options) => streamWith(model, context, options, true),
    };
}
