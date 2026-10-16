import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Text } from "@earendil-works/pi-tui";

import { formatPendingMessage, summarizeText } from "../core/question-format.ts";
import { questionManager } from "../core/questionManager.ts";
import { openQuestionPanel } from "../tui/panel/question-panel.ts";

import Type from "typebox";

export type AskUserQuestionsDetails =
    | {
          status: "pending";
          requestId: string;
      }
    | {
          status: "unavailable";
      };

/**
 * The tool is asynchronous by design: it returns as soon as the panel is open, the model
 * keeps working on what it is sure about, and the answers arrive as a follow-up message.
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
            "Ask the user structured questions about user-owned decisions or meaningful tradeoffs. The panel opens immediately and answers arrive later as a follow-up message.",

        promptSnippet:
            "Ask for user-owned decisions; discover facts and use reasonable defaults yourself.",

        promptGuidelines: [
            "Ask only when the answer materially changes what you do next; inspect the conversation and workspace first, and use reasonable defaults for low-impact choices.",
            "After calling the tool, continue independent work and stop only when further progress depends on the answers.",
            "Add option previews only for concrete alternatives worth comparing - code, configuration, structured text or UI mockups - not for simple preferences. The pane is titled with the option label, so do not repeat it; content shared by every option belongs in displayText.",
            "Give every question a short header naming its subject ('Storage', 'Auth', 'Timeouts'); it is the tab label, so never number questions or repeat the question text.",
        ],
        parameters: askUserQuestionsSchema,
        // The panel is a user interaction, not a nested-tool capability, and shared
        // panel state must not be mutated by parallel calls.
        exposure: "model-only",
        executionMode: "sequential",

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

            const request = questionManager.create(params.questions);

            // Not awaited: the tool result is what lets the model keep working while the
            // user reads the panel.
            void openQuestionPanel(ctx, { onDeferred: () => persist(ctx) });

            return {
                content: [
                    {
                        type: "text" as const,
                        text: formatPendingMessage(),
                    },
                ],
                details: {
                    status: "pending",
                    requestId: request.id,
                } as AskUserQuestionsDetails,
            };
        },

        renderCall(args, theme, _context) {
            // Pi renders the call while the model still streams its arguments, so any field can
            // be missing yet. A throw here would swap the card for pi's raw-argument fallback.
            const questions = Array.isArray(args.questions) ? args.questions : [];
            const count = questions.length;
            const label = `${count} question${count === 1 ? "" : "s"}`;

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

            if (details?.status === "unavailable") {
                return new Text(
                    theme.fg(
                        "error",
                        result.content[0]?.type === "text" ? result.content[0].text : "unavailable",
                    ),
                    0,
                    0,
                );
            }

            return new Text(
                theme.fg("warning", "waiting for the user") +
                    theme.fg("dim", " · /question to reopen the panel"),
                0,
                0,
            );
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
});
