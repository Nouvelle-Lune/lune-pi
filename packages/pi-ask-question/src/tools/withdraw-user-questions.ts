import { defineTool } from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";

import { committedRequestIds } from "../core/question-delivery.ts";
import { requestHeaders, singleLine, summarizeText } from "../core/question-format.ts";
import type { QuestionManager } from "../core/questionManager.ts";

import Type from "typebox";

export type WithdrawUserQuestionsDetails =
    | {
          status: "withdrawn";
          requestId: string;
          headers: string;
          reason: string;
      }
    | {
          /** The user answered or skipped first; the answer reaches the model anyway. */
          status: "too-late";
          requestId: string;
      }
    | {
          status: "refused";
          requestId: string;
      };

/**
 * Lets the agent take back its own pending question. The tool stays active at all times:
 * switching tools on and off changes the system prompt and breaks the prompt cache.
 */
export function withdrawUserQuestions(manager: QuestionManager) {
    return defineTool({
        name: "withdraw_user_questions",
        label: "Withdraw User Questions",
        description:
            "Withdraw your own pending ask_user_questions request by its request id when it no longer needs the user's answer.",

        promptSnippet: "Withdraw your own pending question when it no longer needs the user.",

        promptGuidelines: [
            "Withdraw a pending question when a file, tool or test answered it, the user answered it in a chat message, or the plan changed so it no longer matters; to improve a question, withdraw it and ask again.",
            "Never withdraw because the user is slow or to decide a user-owned question yourself; if you withdraw and use a default, say which and why.",
        ],
        parameters: withdrawUserQuestionsSchema,
        // It closes the shared panel, so it runs alone like `ask_user_questions`.
        exposure: "model-only",
        executionMode: "sequential",

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const requestId = params.requestId.trim();
            const reason = singleLine(params.reason);
            const outcome = manager.withdraw(requestId, reason);

            if (outcome.status === "withdrawn") {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Withdrew request ${requestId}. The user will not answer it.`,
                        },
                    ],
                    details: {
                        status: "withdrawn",
                        requestId,
                        headers: requestHeaders(outcome.request),
                        reason,
                    } as WithdrawUserQuestionsDetails,
                };
            }

            if (outcome.status === "waiting") {
                return refused(
                    requestId,
                    `Request ${requestId} cannot be withdrawn: a blocking ask_user_questions call waits on it.`,
                );
            }

            // A settled request leaves the outbox once its message is on the branch, so the
            // branch is what still knows about it.
            const inConversation = committedRequestIds(ctx).has(requestId);

            if (outcome.status === "unknown" && !inConversation) {
                return refused(requestId, `No pending question request has id ${requestId}.`);
            }

            const settled =
                outcome.status !== "settled"
                    ? "answered or skipped"
                    : outcome.request.status === "skipped"
                      ? "skipped"
                      : "answered";

            return {
                content: [
                    {
                        type: "text" as const,
                        text: [
                            `Too late: the user already ${settled} request ${requestId}.`,
                            inConversation
                                ? "The answer message is already in the conversation."
                                : "The answer message will arrive as a follow-up message.",
                        ].join(" "),
                    },
                ],
                details: { status: "too-late", requestId } as WithdrawUserQuestionsDetails,
            };
        },

        renderCall(args, theme, _context) {
            // Pi renders the call while the model still streams its arguments.
            const requestId = typeof args.requestId === "string" ? args.requestId : "";

            return new Text(
                theme.fg("toolTitle", theme.bold("withdraw_user_questions ")) +
                    theme.fg("muted", summarizeText(requestId, 40)),
                0,
                0,
            );
        },

        renderResult(result, _options, theme, _context) {
            const details = result.details as WithdrawUserQuestionsDetails | undefined;
            const text = result.content[0]?.type === "text" ? result.content[0].text : "";

            if (details?.status === "withdrawn") {
                return new Text(
                    theme.bold(theme.fg("warning", "Question withdrawn")) +
                        theme.fg(
                            "muted",
                            [details.headers, details.reason]
                                .filter((part) => part.length > 0)
                                .map((part) => ` · ${summarizeText(part, 60)}`)
                                .join(""),
                        ),
                    0,
                    0,
                );
            }

            return new Text(
                theme.fg(details?.status === "too-late" ? "warning" : "error", text),
                0,
                0,
            );
        },
    });
}

function refused(requestId: string, text: string) {
    return {
        content: [{ type: "text" as const, text }],
        details: { status: "refused", requestId } as WithdrawUserQuestionsDetails,
        isError: true,
    };
}

const withdrawUserQuestionsSchema = Type.Object({
    requestId: Type.String({
        minLength: 1,
        description: "The request id from the ask_user_questions result.",
    }),

    reason: Type.String({
        minLength: 1,
        description:
            "Short reason shown to the user, such as 'answered by the test run' or 'replaced by a clearer question'.",
    }),
});
