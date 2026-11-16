import {
    clampThinkingLevel,
    retryAssistantCall,
    type Api,
    type AssistantMessage,
    type Model,
    type Models,
    type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { parseModelRef, type DreamingConfig } from "../core/config.ts";
import type { MemoryPaths } from "../core/paths.ts";
import { FileCredentialStore } from "./credentials.ts";

/** Token and cost totals of the model calls of one run. */
export type Usage = Record<string, number>;

export function emptyUsage(): Usage {
    return {
        calls: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
    };
}

export function addUsage(target: Usage, source: Usage): Usage {
    for (const [key, value] of Object.entries(source)) {
        target[key] = (target[key] ?? 0) + value;
    }
    return target;
}

function usageOf(message: AssistantMessage): Usage {
    const usage = message.usage;
    return {
        calls: 1,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        cost: usage.cost.total,
    };
}

export interface CompletionResult {
    text: string;
    usage: Usage;
}

/** One model with the settings of Dreaming. All provider access goes through pi-ai. */
export interface DreamingModel {
    /** `provider/id` of the model. */
    readonly ref: string;
    complete(system: string, user: string, signal?: AbortSignal): Promise<CompletionResult>;
}

export interface ModelOptions {
    /** Model registry. Tests give a registry with the faux provider. */
    models?: Models;
}

function reasoningFor(model: Model<Api>, thinking: DreamingConfig["thinking"]) {
    const level = clampThinkingLevel(model, thinking as ModelThinkingLevel);
    return level === "off" ? undefined : level;
}

/**
 * Create the Dreaming model from the config. It throws when no model is set, the reference is
 * not `provider/id`, or pi-ai does not know the model.
 */
export function createDreamingModel(
    config: DreamingConfig,
    paths: MemoryPaths,
    options: ModelOptions = {},
): DreamingModel {
    if (!config.model) throw new Error("No Dreaming model configured");
    const parsed = parseModelRef(config.model);
    if (!parsed) throw new Error(`Dreaming model must be provider/id: ${config.model}`);
    const models =
        options.models ??
        builtinModels({ credentials: new FileCredentialStore(paths.credentials) });
    const model = models.getModel(parsed.provider, parsed.id);
    if (!model) throw new Error(`Unknown Dreaming model: ${config.model}`);
    const reasoning = reasoningFor(model, config.thinking);
    const ref = config.model;
    return {
        ref,
        async complete(system, user, signal) {
            const message = await retryAssistantCall(
                () =>
                    models.completeSimple(
                        model,
                        {
                            systemPrompt: system,
                            messages: [{ role: "user", content: user, timestamp: Date.now() }],
                        },
                        { reasoning, signal },
                    ),
                { enabled: true, maxRetries: config.maxRetries, baseDelayMs: 1000 },
                signal,
            );
            if (message.stopReason !== "stop") {
                const reason = message.errorMessage ? `: ${message.errorMessage}` : "";
                throw new Error(`Model call ended with ${message.stopReason}${reason}`);
            }
            const text = message.content
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("")
                .trim();
            if (!text) throw new Error("Model call returned no text");
            return { text, usage: usageOf(message) };
        },
    };
}

/**
 * Parse the JSON object of a model reply. The reply can wrap the object in a code fence or put
 * text around it. It throws when no JSON object parses.
 */
export function parseJsonReply(text: string): Record<string, unknown> {
    const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/u.exec(text);
    const candidates = [fenced?.[1], text];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const start = candidate.indexOf("{");
        const end = candidate.lastIndexOf("}");
        if (start < 0 || end <= start) continue;
        try {
            const value: unknown = JSON.parse(candidate.slice(start, end + 1));
            if (value && typeof value === "object" && !Array.isArray(value)) {
                return value as Record<string, unknown>;
            }
        } catch {
            // Try the next candidate.
        }
    }
    throw new Error("Model reply has no JSON object");
}
