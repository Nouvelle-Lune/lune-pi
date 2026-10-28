import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { formatAnswerMessage } from "./question-format.ts";
import { toAnswerMessageQuestion, type QuestionManager } from "./questionManager.ts";
import type { AskQuestionRequest } from "./question-types.ts";

/** Custom message type carrying answers (or a skip) back to the model. */
export const ASK_QUESTION_ANSWER_MESSAGE = "pi-ask-question-answer";

export interface QuestionDeliveryOptions {
    /**
     * Called when the answer could not be handed to pi at all.
     *
     * The request stays in the durable outbox either way; without this notice the user would
     * never learn that the model never received the answer.
     */
    onError?: (error: unknown) => void;
}

/**
 * Attempt delivery as soon as a request settles.
 *
 * This is the initial attempt only. The persistence listener runs first, so the settled
 * request is already in the durable outbox when this send happens; if pi drops the message,
 * reconciliation recovers it instead of the answer being lost with the call.
 */
export function registerQuestionAnswerNotifications(
    pi: ExtensionAPI,
    manager: QuestionManager,
    options: QuestionDeliveryOptions = {},
): () => void {
    return manager.subscribe((event) => {
        if (event.type !== "request-answered" && event.type !== "request-skipped") {
            return;
        }

        const request = manager.get(event.id);

        // A request answered into a waiting tool call has no outbox entry: the tool result
        // already carries the answer.
        if (!request) {
            return;
        }

        deliverQuestionResult(pi, request, options);
    });
}

/**
 * Attempt delivery of one settled request.
 *
 * A normal return is not an acknowledgement: pi can queue a steered message and drop it
 * before it reaches the session. The caller keeps the request in the durable outbox until
 * the branch really contains its message, so this function never mutates the outbox.
 */
export function deliverQuestionResult(
    pi: ExtensionAPI,
    request: Readonly<AskQuestionRequest>,
    options: QuestionDeliveryOptions = {},
): void {
    try {
        pi.sendMessage(
            {
                customType: ASK_QUESTION_ANSWER_MESSAGE,
                content: formatAnswerMessage(request),
                display: true,
                details: {
                    requestId: request.id,
                    status: request.status,
                    questions: request.questions.map(toAnswerMessageQuestion),
                    answers: request.answers,
                },
            },
            {
                triggerTurn: true,
                deliverAs: "steer",
            },
        );
    } catch (error) {
        options.onError?.(error);
    }
}

/**
 * Reconcile the durable outbox against the session branch of `ctx`.
 *
 * The branch is the only acknowledgement: a settled request whose answer message is really
 * there is released, and the release is persisted; one whose message is missing - never
 * sent, or dropped by pi's queue - is attempted again. Matching is by requestId, so one
 * request's message says nothing about another's.
 */
export function reconcileQuestionDeliveries(
    pi: ExtensionAPI,
    manager: QuestionManager,
    ctx: ExtensionContext,
    options: QuestionDeliveryOptions = {},
): void {
    for (const request of releaseDeliveredQuestions(manager, ctx)) {
        deliverQuestionResult(pi, request, options);
    }
}

/**
 * Release the settled requests whose answer message the active branch already holds, and
 * return the ones still missing.
 *
 * On its own this never sends. It runs while the session is live, where a missing message may
 * have been cleared from pi's queue by an abort: sending it again would start the turn the user
 * just stopped. The next session start or tree move attempts those again.
 */
export function releaseDeliveredQuestions(
    manager: QuestionManager,
    ctx: ExtensionContext,
): Readonly<AskQuestionRequest>[] {
    const undelivered = manager.getUndeliveredRequests();

    if (undelivered.length === 0) {
        return [];
    }

    const committed = committedRequestIds(ctx);
    const missing: Readonly<AskQuestionRequest>[] = [];

    for (const request of undelivered) {
        if (committed.has(request.id)) {
            manager.acknowledgeDelivery(request.id);
        } else {
            missing.push(request);
        }
    }

    return missing;
}

/** Request ids of the answer messages the active branch really holds. */
export function committedRequestIds(ctx: ExtensionContext): Set<string> {
    const ids = new Set<string>();

    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom_message" || entry.customType !== ASK_QUESTION_ANSWER_MESSAGE) {
            continue;
        }

        const requestId = answerRequestId(entry.details);

        if (requestId !== undefined) {
            ids.add(requestId);
        }
    }

    return ids;
}

/** The stable identity of an answer message; details without a string requestId never match. */
function answerRequestId(details: unknown): string | undefined {
    if (details === null || typeof details !== "object") {
        return undefined;
    }

    const candidate = details as { requestId?: unknown };

    return typeof candidate.requestId === "string" ? candidate.requestId : undefined;
}
