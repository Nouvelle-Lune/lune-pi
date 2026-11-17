import { setTimeout as delay } from "node:timers/promises";
import type { ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelReference } from "@lune_99/pi-lune-extensions-core/panel";

export type Classify = (
    context: ClassifierContext,
    signal: AbortSignal,
) => Promise<ClassifierResult>;

/** Availability is rechecked per run so an unconfigured provider is never sent a request. */
export async function resolveClassifier(
    reference: ModelReference | null,
    ctx: ExtensionContext,
    signal?: AbortSignal,
): Promise<ClassifierModel<string>> {
    signal?.throwIfAborted();
    const models = await ctx.modelRegistry.getAvailableOfType("classifier", undefined, { signal });
    signal?.throwIfAborted();
    const model = reference
        ? models.find((model) => model.provider === reference.provider && model.id === reference.id)
        : models[0];
    if (!model)
        throw new Error(
            reference
                ? `Classifier ${reference.provider}/${reference.id} is unavailable. Configure its provider in Pi, or select Automatic in /lune-core-settings → Compaction → Classifier model.`
                : "No classifier is available. Configure a classifier provider in Pi with /login or its environment credentials, then refresh the list in /lune-core-settings → Compaction → Classifier model.",
        );
    return model;
}

export function isClassifierOverflow(result: ClassifierResult): boolean {
    return (
        result.stopReason === "error" &&
        /\b(?:max_tokens_exceeded|context_length_exceeded|input_too_long|prompt_too_long)\b|maximum context length|context (?:window|length).*exceed|(?:input|prompt) is too long/iu.test(
            result.errorMessage ?? "",
        )
    );
}

export function validateAnswers(result: ClassifierResult, context: ClassifierContext): void {
    if (result.stopReason !== "stop")
        throw new Error(
            `Jev ${result.stopReason}: ${result.errorMessage ?? "classification did not complete"}`,
        );
    const expected = Object.keys(context.questions);
    if (Object.keys(result.answers).some((id) => !expected.includes(id)))
        throw new Error("Jev returned unknown answer IDs");
    for (const id of expected) {
        const answer = result.answers[id];
        if (
            !answer ||
            answer.type !== "bool" ||
            !Number.isFinite(answer.probability) ||
            answer.probability < 0 ||
            answer.probability > 1
        ) {
            throw new Error(`Jev returned an invalid probability for ${id}`);
        }
    }
}

const MAX_TRANSPORT_RETRIES = 2;
const TRANSPORT_RETRY_DELAY_MS = 500;
// Provider bodies can contain transport words even when account limits make retries futile.
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR =
    /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/iu;
const TRANSIENT_TRANSPORT_ERROR =
    /\b(?:UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)\b|fetch failed|other side closed|network.?error|connection.?(?:error|reset|refused|closed|lost)|getaddrinfo|upstream.?connect|reset before headers|socket (?:hang up|connection was closed)|timed? out|timeout|\bterminated\b|websocket.?(?:closed|error)|ended without|stream ended before (?:message_stop|a terminal response event)|http2 request did not get a response|pending stream has been canceled/iu;

function isTransientTransportError(message: string): boolean {
    return (
        !NON_RETRYABLE_PROVIDER_LIMIT_ERROR.test(message) && TRANSIENT_TRANSPORT_ERROR.test(message)
    );
}

async function classifyWithRetry(
    context: ClassifierContext,
    classify: Classify,
    signal: AbortSignal,
): Promise<ClassifierResult> {
    for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        let message: string;
        try {
            // Snapshot before another request can reuse the provider's response object.
            const result = structuredClone(await classify(context, signal));
            signal.throwIfAborted();
            if (result.stopReason !== "error" || isClassifierOverflow(result)) return result;
            message = result.errorMessage ?? "";
            if (attempt >= MAX_TRANSPORT_RETRIES || !isTransientTransportError(message))
                return result;
        } catch (error) {
            signal.throwIfAborted();
            if (
                attempt >= MAX_TRANSPORT_RETRIES ||
                !(error instanceof Error) ||
                error.name === "AbortError" ||
                !isTransientTransportError(error.message)
            )
                throw error;
            message = error.message;
        }
        const delayMs = TRANSPORT_RETRY_DELAY_MS * 2 ** attempt;
        console.warn(
            `[pi-compaction] Classifier transport retry ${attempt + 1}/${MAX_TRANSPORT_RETRIES} in ${delayMs}ms: ${message}`,
        );
        await delay(delayMs, undefined, { signal });
    }
}

/** A terminal request failure aborts its siblings; context overflow is a result, not a failure. */
export async function runRequests(
    requests: readonly ClassifierContext[],
    classify: Classify,
    concurrency: number,
    signal: AbortSignal,
    progress: (completed: number, total: number) => void,
): Promise<readonly ClassifierResult[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
        throw new Error("Classifier concurrency must be a positive integer");
    signal.throwIfAborted();
    const cancel = new AbortController();
    const requestSignal = AbortSignal.any([signal, cancel.signal]);
    const results: ClassifierResult[] = new Array(requests.length);
    let cursor = 0;
    let completed = 0;
    let failure: unknown;
    progress(0, requests.length);
    const worker = async (): Promise<void> => {
        while (cursor < requests.length && !requestSignal.aborted) {
            requestSignal.throwIfAborted();
            const index = cursor++;
            const request = requests[index]!;
            try {
                const result = await classifyWithRetry(request, classify, requestSignal);
                requestSignal.throwIfAborted();
                if (!isClassifierOverflow(result)) validateAnswers(result, request);
                results[index] = result;
                progress(++completed, requests.length);
            } catch (error) {
                if (!cancel.signal.aborted) {
                    failure = error;
                    cancel.abort(error);
                }
                return;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker));
    signal.throwIfAborted();
    if (cancel.signal.aborted) throw failure;
    return results;
}
