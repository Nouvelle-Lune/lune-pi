import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ProviderStreams } from "@earendil-works/pi-ai";

/** The protocols of a custom provider. pi-ai streams all three, so lune-memory has no client. */
export const CUSTOM_APIS = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
] as const;
export type CustomApi = (typeof CUSTOM_APIS)[number];

export function isCustomApi(value: unknown): value is CustomApi {
    return CUSTOM_APIS.includes(value as CustomApi);
}

/** The lazy wrappers load the SDK of a protocol at its first request. */
export function customApiStreams(): Record<CustomApi, ProviderStreams> {
    return {
        "openai-completions": openAICompletionsApi(),
        "openai-responses": openAIResponsesApi(),
        "anthropic-messages": anthropicMessagesApi(),
    };
}
