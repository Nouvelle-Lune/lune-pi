/**
 * The models.json of lune-memory, in the format of the models.json of Pi. The schema and the
 * loader come from model-config.ts of the Pi coding agent (MIT, see THIRD_PARTY_NOTICES.md).
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";

import { ProviderCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import {
    ModelCostSchema,
    ModelInputLimitsSchema,
    ModelInputModalitySchema,
    ModelPromptCacheSchema,
    ThinkingLevelMapSchema,
} from "@earendil-works/pi-ai/providers/model-schema";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";

import { MemoryOperationError } from "../../core/errors.ts";
import { errorMessage, writeFileAtomic } from "../../core/util.ts";

const SamplingParamsSchema = Type.Record(Type.String(), Type.Unknown());
const SamplingParamsByThinkingLevelSchema = Type.Object({
    off: Type.Optional(SamplingParamsSchema),
    minimal: Type.Optional(SamplingParamsSchema),
    low: Type.Optional(SamplingParamsSchema),
    medium: Type.Optional(SamplingParamsSchema),
    high: Type.Optional(SamplingParamsSchema),
    xhigh: Type.Optional(SamplingParamsSchema),
    max: Type.Optional(SamplingParamsSchema),
});

const PositiveTokenCountSchema = Type.Number({ exclusiveMinimum: 0 });

const ModelDefinitionSchema = Type.Object({
    id: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(Type.String({ minLength: 1 })),
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
    thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
    input: Type.Optional(Type.Array(ModelInputModalitySchema)),
    inputLimits: Type.Optional(ModelInputLimitsSchema),
    cost: Type.Optional(ModelCostSchema),
    promptCache: Type.Optional(ModelPromptCacheSchema),
    contextWindow: Type.Optional(PositiveTokenCountSchema),
    maxTokens: Type.Optional(PositiveTokenCountSchema),
    samplingParams: Type.Optional(SamplingParamsSchema),
    samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    compat: Type.Optional(ProviderCompatSchema),
});

const ModelOverrideSchema = Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
    thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
    input: Type.Optional(Type.Array(ModelInputModalitySchema)),
    inputLimits: Type.Optional(ModelInputLimitsSchema),
    cost: Type.Optional(Type.Partial(ModelCostSchema)),
    promptCache: Type.Optional(ModelPromptCacheSchema),
    contextWindow: Type.Optional(PositiveTokenCountSchema),
    maxTokens: Type.Optional(PositiveTokenCountSchema),
    samplingParams: Type.Optional(SamplingParamsSchema),
    samplingParamsByThinkingLevel: Type.Optional(SamplingParamsByThinkingLevelSchema),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })),
    baseUrl: Type.Optional(Type.String({ minLength: 1 })),
    apiKey: Type.Optional(Type.String({ minLength: 1 })),
    api: Type.Optional(Type.String({ minLength: 1 })),
    oauth: Type.Optional(Type.Literal("radius")),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    compat: Type.Optional(ProviderCompatSchema),
    authHeader: Type.Optional(Type.Boolean()),
    models: Type.Optional(Type.Array(ModelDefinitionSchema)),
    modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigSchema = Type.Object({
    $schema: Type.Optional(Type.String()),
    providers: Type.Record(Type.String(), ProviderConfigSchema),
});

const validateModelsConfig = Compile(ModelsConfigSchema);

export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;

function formatValidationPath(error: TLocalizedValidationError): string {
    if (error.keyword === "required") {
        const requiredProperties = (error.params as { requiredProperties?: string[] })
            .requiredProperties;
        const requiredProperty = requiredProperties?.[0];
        if (requiredProperty) {
            const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
            return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
        }
    }
    const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
    return path || "root";
}

/** The schema errors of a document as a list, or undefined when the document is valid. */
function schemaErrors(document: unknown): string | undefined {
    if (validateModelsConfig.Check(document)) return undefined;
    return (
        validateModelsConfig
            .Errors(document)
            .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
            .join("\n") || "Unknown schema error"
    );
}

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
function stripJsonComments(input: string): string {
    return input
        .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
        .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function parseModelsText(content: string): unknown {
    try {
        return JSON.parse(stripJsonComments(content.replace(/^\uFEFF/u, "")));
    } catch (error) {
        // JSON.parse can quote the credential next to a syntax error. Keep only its location.
        const location = /at position \d+(?: \(line \d+ column \d+\))?/u.exec(
            errorMessage(error),
        )?.[0];
        throw new SyntaxError(`Invalid JSON syntax${location ? ` ${location}` : ""}`, {
            cause: error,
        });
    }
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One immutable load of models.json. A file with an error loads no provider. */
export class ModelConfig {
    private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
    private readonly error: string | undefined;

    private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
        this.providers = providers;
        this.error = error;
    }

    static load(path: string): ModelConfig {
        let content: string;
        try {
            content = readFileSync(path, "utf8");
        } catch (error) {
            if (isMissing(error)) return new ModelConfig(new Map());
            return new ModelConfig(
                new Map(),
                `Failed to load models.json: ${errorMessage(error)}\n\nFile: ${path}`,
            );
        }

        let parsed: unknown;
        try {
            parsed = parseModelsText(content);
        } catch (error) {
            return new ModelConfig(
                new Map(),
                `Failed to parse models.json: ${errorMessage(error)}\n\nFile: ${path}`,
            );
        }

        if (!validateModelsConfig.Check(parsed)) {
            return new ModelConfig(
                new Map(),
                `Invalid models.json schema:\n${schemaErrors(parsed)}\n\nFile: ${path}`,
            );
        }

        const providers = new Map<string, ModelsJsonProvider>();
        for (const [providerId, provider] of Object.entries(parsed.providers)) {
            providers.set(providerId, deepFreeze(structuredClone(provider)));
        }
        return new ModelConfig(providers);
    }

    getProvider(providerId: string): ModelsJsonProvider | undefined {
        return this.providers.get(providerId);
    }

    getProviderIds(): readonly string[] {
        return [...this.providers.keys()];
    }

    getError(): string | undefined {
        return this.error;
    }
}

// ---------------------------------------------------------------------------------------------
// Editing. The loader reads one immutable view. An edit works on the plain document instead, so
// a field that this version does not know survives it.

export type ModelsDocument = Record<string, unknown> & {
    providers: Record<string, unknown>;
};

/** Read models.json for an edit. A file that does not parse is an error and is never replaced. */
export function readModelsDocument(path: string): ModelsDocument {
    let content: string;
    try {
        content = readFileSync(path, "utf8");
    } catch (error) {
        if (isMissing(error)) return { providers: {} };
        throw new MemoryOperationError(`Cannot read ${path}: ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
        parsed = parseModelsText(content);
    } catch (error) {
        throw new MemoryOperationError(`Cannot parse ${path}: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed) || (parsed.providers !== undefined && !isRecord(parsed.providers))) {
        throw new MemoryOperationError(`${path} must be an object with a "providers" object`);
    }
    return { ...parsed, providers: { ...(parsed.providers as object | undefined) } };
}

/** The provider entry of a document, or undefined when the document has none with this id. */
export function providerEntry(
    document: ModelsDocument,
    providerId: string,
): Record<string, unknown> | undefined {
    const entry = Object.hasOwn(document.providers, providerId)
        ? document.providers[providerId]
        : undefined;
    return isRecord(entry) ? entry : undefined;
}

/**
 * Write models.json as plain JSON, so the `//` comments of a hand-written file are lost. It
 * refuses a document that Pi would reject. A symlink, for example to the models.json of Pi,
 * stays a symlink, and the file keeps its mode.
 */
export function writeModelsDocument(path: string, document: ModelsDocument): void {
    const invalid = schemaErrors(document);
    if (invalid !== undefined) {
        throw new MemoryOperationError(`models.json would be invalid:\n${invalid}`);
    }
    const exists = existsSync(path);
    const target = exists ? realpathSync(path) : path;
    const mode = exists ? statSync(target).mode & 0o777 : 0o600;
    writeFileAtomic(target, `${JSON.stringify(document, null, 2)}\n`, mode);
}

/** A model ref is `provider/id` and splits at the first slash, so a provider id has none. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isProviderId(value: string): boolean {
    return PROVIDER_ID.test(value);
}

/** Check an http(s) URL and drop trailing slashes, so a path joins without a double slash. */
export function normalizeBaseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new MemoryOperationError("Not a URL. Give an absolute http:// or https:// base URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new MemoryOperationError("The base URL must start with http:// or https://");
    }
    // The key has its own field. A key in the URL would reach models.json and the provider list,
    // and fetch rejects a URL with credentials anyway.
    if (url.username || url.password) {
        throw new MemoryOperationError(
            "The base URL has no user name or password. Give the key as the API key",
        );
    }
    // The request path follows the base URL, so a query string or fragment would swallow it.
    if (/[?#]/u.test(url.href)) {
        throw new MemoryOperationError("The base URL has no query string or fragment");
    }
    return url.href.replace(/\/+$/u, "");
}

/** Changes when the file is written, so a cached registry knows that models.json changed. */
export function modelsFileSignature(path: string): string {
    try {
        const stat = statSync(path);
        return `${stat.mtimeMs}:${stat.size}`;
    } catch {
        return "missing";
    }
}
