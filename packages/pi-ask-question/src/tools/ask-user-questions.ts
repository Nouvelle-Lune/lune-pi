import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";

import { committedRequestIds } from "../core/question-delivery.ts";
import {
    formatAnswerMessage,
    formatInterruptedMessage,
    formatPendingMessage,
    summarizeText,
} from "../core/question-format.ts";
import { questionManager, toAnswerMessageQuestion } from "../core/questionManager.ts";
import type { AnswerMessageQuestion, AskQuestionAnswer } from "../core/question-types.ts";
import { openQuestionPanel } from "../tui/panel/question-panel.ts";
import { renderQuestionAnswerMessage } from "../tui/question-answer-message.ts";

import Type from "typebox";

export type AskUserQuestionsDetails =
    | {
          /** `waiting` is the partial result of a blocking call. */
          status: "pending" | "waiting" | "interrupted";
          requestId: string;
      }
    | {
          status: "answered" | "skipped";
          requestId: string;
          questions: AnswerMessageQuestion[];
          answers?: AskQuestionAnswer[];
      }
    | {
          status: "unavailable";
      };

/**
 * By default the tool does not wait: it returns as soon as the panel is open, the model keeps
 * working on what it is sure about, and the answers arrive as a follow-up message. In block
 * mode it waits until the user answers or skips, and returns that as its result.
 *
 * `persist` writes the pending questions (with drafts) into the session, which is what
 * keeps them answerable after Esc or a restart.
 */
export function askUserQuestions(persist: (ctx: ExtensionContext) => void) {
    return defineTool({
        name: "ask_user_questions",
        label: "Ask User Questions",
        // Each rule lives in one place: when and how to ask in the guidelines, what a field holds
        // in its schema description. All of it is sent with every request.
        description:
            "Ask the user structured questions about user-owned decisions or meaningful tradeoffs. The panel opens immediately; answers arrive later as a follow-up message, or as this tool's result in block mode.",

        promptSnippet:
            "Ask for user-owned decisions; discover facts and use reasonable defaults yourself.",

        promptGuidelines: [
            "Ask only when the answer materially changes what you do next; inspect the conversation and workspace first, and use reasonable defaults for low-impact choices.",
            "Use ask_user_questions mode 'block' when the next step depends on the answer and no independent work is left, to confirm a hard-to-undo action (delete, push, migrate), or when the choice controls most later work. Otherwise keep 'continue': do the independent work, and stop only when progress depends on the answers.",
            "Add option previews only for concrete alternatives worth comparing - code, configuration, structured text or UI mockups - not for simple preferences. The pane is titled with the option label, so do not repeat it; content shared by every option belongs in displayText.",
            "Give every question a short header naming its subject ('Storage', 'Auth', 'Timeouts'); it is the tab label, so never number questions or repeat the question text.",
        ],
        parameters: askUserQuestionsSchema,
        // The panel is a user interaction, not a nested-tool capability, and shared
        // panel state must not be mutated by parallel calls.
        exposure: "model-only",
        executionMode: "sequential",

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            if (ctx.mode !== "tui") {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: ask_user_questions needs the interactive TUI; ask your questions in plain text in this mode instead.",
                        },
                    ],
                    details: { status: "unavailable" } as AskUserQuestionsDetails,
                    isError: true,
                };
            }

            const request = questionManager.create(params.questions, committedRequestIds(ctx));
            const requestId = request.id;
            // Registered before the panel opens, so the panel picks this request first.
            const wait =
                params.mode === "block"
                    ? questionManager.waitForSettle(requestId, signal)
                    : undefined;

            // Not awaited: Esc closes the panel without an answer, so the overlay closing ends
            // neither this call nor a wait.
            void openQuestionPanel(ctx, { onDeferred: () => persist(ctx) });

            if (!wait) {
                return {
                    content: [{ type: "text" as const, text: formatPendingMessage(requestId) }],
                    details: { status: "pending", requestId } as AskUserQuestionsDetails,
                };
            }

            onUpdate?.({
                content: [{ type: "text" as const, text: "Waiting for the user's answers." }],
                details: { status: "waiting", requestId } as AskUserQuestionsDetails,
            });

            const outcome = await wait;

            if (outcome.status === "interrupted") {
                return {
                    content: [{ type: "text" as const, text: formatInterruptedMessage(requestId) }],
                    details: { status: "interrupted", requestId } as AskUserQuestionsDetails,
                };
            }

            const settled = outcome.request;

            return {
                content: [{ type: "text" as const, text: formatAnswerMessage(settled) }],
                details: {
                    status: settled.status === "skipped" ? "skipped" : "answered",
                    requestId,
                    questions: settled.questions.map(toAnswerMessageQuestion),
                    answers: settled.answers,
                } as AskUserQuestionsDetails,
            };
        },

        renderCall(args, theme, _context) {
            // Pi renders the call while the model still streams its arguments, so any field can
            // be missing yet. A throw here would swap the card for pi's raw-argument fallback.
            const questions = Array.isArray(args.questions) ? args.questions : [];
            const count = questions.length;
            const label = `${count} question${count === 1 ? "" : "s"}${args.mode === "block" ? " · block" : ""}`;

            const lines = questions
                .filter((question) => typeof question?.question === "string")
                .map((question) => theme.fg("text", summarizeText(question.question, 60)));

            return new Text(
                theme.fg("toolTitle", theme.bold("ask_user_questions ")) +
                    theme.fg("muted", label) +
                    (lines.length > 0 ? `\n${lines.join("\n")}` : ""),
                0,
                0,
            );
        },

        renderResult(result, _options, theme, _context) {
            const details = result.details as AskUserQuestionsDetails | undefined;

            switch (details?.status) {
                case "unavailable":
                    return new Text(
                        theme.fg(
                            "error",
                            result.content[0]?.type === "text"
                                ? result.content[0].text
                                : "unavailable",
                        ),
                        0,
                        0,
                    );
                case "answered":
                case "skipped":
                    return renderQuestionAnswerMessage(details, theme);
                case "waiting":
                    return new Text(
                        theme.fg("warning", "the agent waits for your answer") +
                            theme.fg("dim", " · /question to reopen the panel"),
                        0,
                        0,
                    );
                case "interrupted":
                    return new Text(
                        theme.fg("warning", "interrupted, still pending") +
                            theme.fg("dim", " · /question to answer"),
                        0,
                        0,
                    );
                default:
                    return new Text(
                        theme.fg("warning", "waiting for the user") +
                            theme.fg("dim", " · /question to reopen the panel"),
                        0,
                        0,
                    );
            }
        },
    });
}

const askUserQuestionsSchema = Type.Object({
    questions: Type.Array(
        Type.Object({
            question: Type.String({
                description:
                    "One atomic decision prompt in a single sentence, with enough context to answer without reading surrounding prose.",
            }),

            header: Type.String({
                minLength: 1,
                maxLength: 16,
                description: "Tab label naming the question's subject in a word or two.",
            }),

            displayText: Type.Optional(
                Type.String({
                    description:
                        "Markdown shown above the options, the same for every option: context or evidence the whole question needs, such as a diff, an excerpt or the current values.",
                }),
            ),

            options: Type.Optional(
                Type.Array(
                    Type.Object({
                        label: Type.String({
                            description:
                                "Short, scannable choice label, preferably 1-5 words. Put a clearly preferred option first and suffix its label with '(Recommended)'.",
                        }),

                        description: Type.Optional(
                            Type.String({
                                description:
                                    "One short sentence on the consequence or tradeoff of this option.",
                            }),
                        ),

                        preview: Type.Optional(
                            Type.String({
                                description:
                                    "Markdown for this option only, shown beside the options while it is focused. Keep it to about a dozen lines.",
                            }),
                        ),
                    }),
                    {
                        minItems: 2,
                        maxItems: 4,
                        description: "Two to four distinct choices. Omit for free-form input.",
                    },
                ),
            ),

            multiSelect: Type.Optional(
                Type.Boolean({
                    default: false,
                    description:
                        "True when several options can apply at once; keep false for mutually exclusive choices.",
                }),
            ),
        }),
        {
            minItems: 1,
            maxItems: 4,
            description:
                "Questions shown together in one panel. Prefer one; batch up to four only when the decisions are independent and already known to be necessary.",
        },
    ),

    mode: Type.Optional(
        // A plain string enum: some providers reject the anyOf/const schema of a literal union.
        Type.Unsafe<"continue" | "block">({
            type: "string",
            enum: ["continue", "block"],
            default: "continue",
            description:
                "'continue' returns at once and the answers arrive as a follow-up message; 'block' waits and returns them as this tool's result.",
        }),
    ),
});
