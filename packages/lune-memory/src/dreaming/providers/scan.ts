import { validateHeaderName, validateHeaderValue } from "node:http";

import type { ProviderHeaders } from "@earendil-works/pi-ai";

import { MemoryOperationError } from "../../core/errors.ts";
import { errorMessage } from "../../core/util.ts";
import type { CustomApi } from "./apis.ts";
import { isRecord, type ModelsJsonModel } from "./models-json.ts";

type ModelEntry = ModelsJsonModel;

const TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
const ANTHROPIC_VERSION = "2023-06-01";

/** Thinking levels of Pi that a model list can name. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ENDPOINT_APIS: Record<string, CustomApi> = {
    "/v1/chat/completions": "openai-completions",
    "/v1/responses": "openai-responses",
    "/v1/messages": "anthropic-messages",
};

export interface ScanRequest {
    api: CustomApi;
    baseUrl: string;
    apiKey?: string | undefined;
    /** Headers of the resolved auth. They win over the headers that the scan adds. */
    headers?: ProviderHeaders | undefined;
    signal?: AbortSignal | undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positive(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : undefined;
}

/** The Anthropic client of pi-ai adds /v1 itself, so its base URL has none. */
function listUrl(api: CustomApi, baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/u, "");
    return api === "anthropic-messages" ? `${base}/v1/models` : `${base}/models`;
}

function requestHeaders(request: ScanRequest): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (request.api === "anthropic-messages") {
        headers["anthropic-version"] = ANTHROPIC_VERSION;
        if (request.apiKey) headers["x-api-key"] = request.apiKey;
    } else if (request.apiKey) {
        headers.Authorization = `Bearer ${request.apiKey}`;
    }
    // A null value removes a header, as in the request headers of pi-ai.
    for (const [name, value] of Object.entries(request.headers ?? {})) {
        for (const existing of Object.keys(headers)) {
            if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
        }
        if (value !== null) headers[name] = value;
    }
    for (const [name, value] of Object.entries(headers)) {
        if (/[\r\n\0]/u.test(value)) {
            throw new MemoryOperationError(`The value of the ${name} header has a line break`);
        }
        try {
            validateHeaderName(name);
            validateHeaderValue(name, value);
        } catch {
            throw new MemoryOperationError("The model list request has an invalid HTTP header");
        }
    }
    return headers;
}

/** Origin and path only: a query string can hold a secret that the endpoint echoed. */
function displayUrl(value: string, base?: string): string {
    try {
        const url = new URL(value, base);
        return `${url.origin}${url.pathname}`;
    } catch {
        return "an invalid address";
    }
}

function failure(error: unknown): string {
    const cause = isRecord(error) ? error.cause : undefined;
    return cause ? `${errorMessage(error)} (${errorMessage(cause)})` : errorMessage(error);
}

async function getJson(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
): Promise<unknown> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
        // A redirect would carry x-api-key, which fetch does not strip, to another origin.
        response = await fetch(url, {
            headers,
            redirect: "manual",
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
    } catch (error) {
        throw new MemoryOperationError(`Cannot reach ${displayUrl(url)}: ${failure(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
        const target = response.headers.get("location");
        throw new MemoryOperationError(
            `${displayUrl(url)} redirects${target ? ` to ${displayUrl(target, url)}` : ""}. Use the final address as the base URL`,
        );
    }
    if (!response.ok) {
        throw new MemoryOperationError(
            `The model list request to ${displayUrl(url)} failed with HTTP ${response.status}`,
        );
    }
    try {
        return await response.json();
    } catch {
        throw new MemoryOperationError(`${displayUrl(url)} did not return JSON`);
    }
}

/** OpenAI and Anthropic wrap the list in `data`. Some gateways use `models` or a bare array. */
function listOf(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    if (isRecord(body)) {
        for (const key of ["data", "models"]) {
            const list = body[key];
            if (Array.isArray(list)) return list;
        }
    }
    throw new MemoryOperationError("The model list has no data array");
}

function inputOf(raw: Record<string, unknown>): Array<"text" | "image"> | undefined {
    const modalities = isRecord(raw.modalities) ? raw.modalities.input : undefined;
    const architecture = isRecord(raw.architecture) ? raw.architecture.input_modalities : undefined;
    const listed = Array.isArray(modalities) ? modalities : architecture;
    if (Array.isArray(listed)) return listed.includes("image") ? ["text", "image"] : ["text"];
    const capabilities = isRecord(raw.capabilities) ? raw.capabilities : undefined;
    const image = isRecord(capabilities?.image_input) ? capabilities.image_input.supported : null;
    if (typeof image === "boolean") return image ? ["text", "image"] : ["text"];
    return undefined;
}

/** Effort levels of a model: gateways list them, Anthropic reports them as capabilities. */
function levelsOf(raw: Record<string, unknown>): string[] | undefined {
    if (Array.isArray(raw.reasoning_levels)) {
        return raw.reasoning_levels.filter((level): level is string => typeof level === "string");
    }
    if (Array.isArray(raw.supported_reasoning_levels)) {
        return raw.supported_reasoning_levels.flatMap((item): string[] => {
            const level = isRecord(item) ? item.effort : item;
            return typeof level === "string" ? [level] : [];
        });
    }
    const effort = isRecord(raw.capabilities) ? raw.capabilities.effort : undefined;
    if (isRecord(effort)) {
        return Object.entries(effort).flatMap(([level, value]) =>
            isRecord(value) && value.supported === true ? [level] : [],
        );
    }
    return undefined;
}

function reasoningOf(raw: Record<string, unknown>, levels: string[] | undefined) {
    if (typeof raw.reasoning === "boolean") return raw.reasoning;
    const thinking = isRecord(raw.capabilities) ? raw.capabilities.thinking : undefined;
    if (isRecord(thinking) && typeof thinking.supported === "boolean") return thinking.supported;
    if (Array.isArray(raw.supported_parameters))
        return raw.supported_parameters.includes("reasoning");
    return levels && levels.length > 0 ? true : undefined;
}

/** A level that the model does not list is unsupported. Pi already treats xhigh and max as off. */
function levelMap(levels: string[]): Record<string, string | null> {
    const map: Record<string, string | null> = {};
    for (const level of LEVELS) {
        if (levels.includes(level)) map[level] = level;
        else if (level !== "xhigh" && level !== "max") map[level] = null;
    }
    return map;
}

/** Prices are USD per token in the model list and USD per million tokens in models.json. */
function perMillion(value: unknown): number | undefined {
    const price = typeof value === "string" ? Number(value) : value;
    return typeof price === "number" && Number.isFinite(price) && price >= 0
        ? Number((price * 1e6).toPrecision(12))
        : undefined;
}

function costOf(pricing: unknown) {
    if (!isRecord(pricing)) return undefined;
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    if (input === undefined || output === undefined) return undefined;
    return {
        input,
        output,
        cacheRead: perMillion(pricing.input_cache_read) ?? 0,
        cacheWrite: perMillion(pricing.input_cache_write) ?? 0,
    };
}

/** A gateway can serve a model through another endpoint than the one of the provider. */
function apiOverride(raw: Record<string, unknown>, api: CustomApi): CustomApi | undefined {
    if (!Array.isArray(raw.native_endpoints)) return undefined;
    const apis = raw.native_endpoints.flatMap((endpoint): CustomApi[] => {
        const known = typeof endpoint === "string" ? ENDPOINT_APIS[endpoint] : undefined;
        return known ? [known] : [];
    });
    return apis.length === 0 || apis.includes(api) ? undefined : apis[0];
}

/** A model that does not output text is no chat model, for example an embedding or image model. */
function outputsText(raw: Record<string, unknown>): boolean {
    const modalities = isRecord(raw.modalities) ? raw.modalities.output : undefined;
    const architecture = isRecord(raw.architecture)
        ? raw.architecture.output_modalities
        : undefined;
    const listed = Array.isArray(modalities) ? modalities : architecture;
    return !Array.isArray(listed) || listed.includes("text");
}

/** Anthropic adds /v1 in its SDK; OpenAI includes it in the base URL. */
function apiBaseUrl(baseUrl: string, from: CustomApi, to: CustomApi): string | undefined {
    if ((from === "anthropic-messages") === (to === "anthropic-messages")) return undefined;
    const url = new URL(baseUrl);
    const prefix = url.pathname.replace(/\/+$/u, "");
    url.pathname = to === "anthropic-messages" ? prefix.replace(/\/v1$/u, "") : `${prefix}/v1`;
    return url.toString().replace(/\/+$/u, "");
}

function mapModel(raw: unknown, api: CustomApi, baseUrl: string): ModelEntry | null {
    if (!isRecord(raw) || !outputsText(raw)) return null;
    const id = str(raw.id);
    if (!id) return null;
    const entry: ModelEntry = { id };
    const name = str(raw.display_name) ?? str(raw.name);
    if (name && name !== id) entry.name = name;
    const override = apiOverride(raw, api);
    if (override) {
        entry.api = override;
        const modelBaseUrl = apiBaseUrl(baseUrl, api, override);
        if (modelBaseUrl !== undefined) entry.baseUrl = modelBaseUrl;
    }
    const input = inputOf(raw);
    if (input) entry.input = input;
    const levels = levelsOf(raw);
    const reasoning = reasoningOf(raw, levels);
    if (reasoning !== undefined) entry.reasoning = reasoning;
    const known = levels?.filter((level) => (LEVELS as readonly string[]).includes(level)) ?? [];
    if (reasoning && known.length > 0) entry.thinkingLevelMap = levelMap(known);
    const contextWindow =
        positive(raw.context_length) ??
        positive(raw.context_window) ??
        positive(raw.max_input_tokens) ??
        positive(raw.max_model_len);
    if (contextWindow) entry.contextWindow = contextWindow;
    const maxTokens = positive(raw.max_output_tokens) ?? positive(raw.max_tokens);
    if (maxTokens) entry.maxTokens = maxTokens;
    const cost = costOf(raw.pricing);
    if (cost) entry.cost = cost;
    return entry;
}

/**
 * List the models of an endpoint as entries of models.json. Fields that the endpoint does not
 * report stay out, so Pi applies its defaults.
 */
export async function scanModels(request: ScanRequest): Promise<ModelEntry[]> {
    const anthropic = request.api === "anthropic-messages";
    const url = listUrl(request.api, request.baseUrl);
    const headers = requestHeaders(request);
    const raw: unknown[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const query = anthropic
            ? `?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`
            : "";
        const body = await getJson(`${url}${query}`, headers, request.signal);
        raw.push(...listOf(body));
        if (!isRecord(body) || body.has_more !== true) break;
        if (
            !anthropic ||
            typeof body.last_id !== "string" ||
            !body.last_id ||
            body.last_id === after
        ) {
            throw new MemoryOperationError("The model list cannot advance to its next page");
        }
        if (page + 1 === MAX_PAGES) {
            throw new MemoryOperationError(`The model list exceeds ${MAX_PAGES} pages`);
        }
        after = body.last_id;
    }
    const seen = new Set<string>();
    const models: ModelEntry[] = [];
    for (const item of raw) {
        const model = mapModel(item, request.api, request.baseUrl);
        if (!model || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
    }
    return models;
}
