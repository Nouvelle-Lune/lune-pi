import type { ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelReference } from "@lune_99/pi-lune-extensions-core/panel";

const REQUEST_CONCURRENCY = 2;

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
                ? `Classifier ${reference.provider}/${reference.id} is unavailable. Configure its provider in Pi, or select Automatic in Lune settings.`
                : "No classifier is available. Configure a classifier provider in Pi with /login or its environment credentials, then refresh Lune settings.",
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

/** One failed request aborts its siblings; context overflow is a result, not a failure. */
export async function runRequests(
    requests: readonly ClassifierContext[],
    classify: Classify,
    signal: AbortSignal,
    progress: (completed: number, total: number) => void,
): Promise<readonly ClassifierResult[]> {
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
                // A provider may reuse response objects across requests; validate and retain our own snapshot.
                const result = structuredClone(await classify(request, requestSignal));
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
    await Promise.all(
        Array.from({ length: Math.min(REQUEST_CONCURRENCY, requests.length) }, worker),
    );
    signal.throwIfAborted();
    if (cancel.signal.aborted) throw failure;
    return results;
}
