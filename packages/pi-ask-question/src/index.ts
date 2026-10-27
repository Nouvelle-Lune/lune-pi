import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerQuestionCommand } from "./commands/question.ts";
import {
    ASK_QUESTION_ANSWER_MESSAGE,
    reconcileQuestionDeliveries,
    registerQuestionAnswerNotifications,
    releaseDeliveredQuestions,
    type QuestionDeliveryOptions,
} from "./core/question-delivery.ts";
import { QuestionManager } from "./core/questionManager.ts";
import { askUserQuestions } from "./tools/ask-user-questions.ts";
import { withdrawUserQuestions } from "./tools/withdraw-user-questions.ts";
import {
    renderQuestionAnswerMessage,
    type AskQuestionAnswerMessageDetails,
} from "./tui/question-answer-message.ts";
import { createQuestionDockContribution } from "./tui/question-dock-contribution.ts";
import { QuestionPanels } from "./tui/panel/question-panel.ts";

export default function (pi: ExtensionAPI): void {
    installAskQuestion(pi);
}

/**
 * Register the extension on `pi` and return the question manager of this load.
 *
 * The manager and the panel ownership belong to the load, not to the module: Pi reuses a loaded
 * module for the sessions it starts in the same working directory, subagent runs included, and
 * each of them owns its questions.
 */
export function installAskQuestion(pi: ExtensionAPI): QuestionManager {
    const questionManager = new QuestionManager();
    const panels = new QuestionPanels(questionManager);

    /**
     * Write the question state, and report a failure instead of throwing it.
     *
     * Everything that persists does a lifecycle step right after - the overlay closes, the
     * session shuts down, the branch switches - and a throw from `appendEntry` would leave
     * that step half done. The user still has to learn that the state will not survive a
     * restart, so the failure is shown rather than dropped.
     */
    const persist = (ctx: ExtensionContext): void => {
        try {
            questionManager.persist(pi);
        } catch (error) {
            ctx.ui.notify(
                `Question state could not be saved: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
        }
    };

    const dock = createQuestionDockContribution(questionManager, panels, persist);

    let unsubscribeManager: (() => void) | undefined;
    let unsubscribeNotifications: (() => void) | undefined;

    const unsubscribe = (): void => {
        unsubscribeManager?.();
        unsubscribeManager = undefined;
        unsubscribeNotifications?.();
        unsubscribeNotifications = undefined;
    };

    /** Report a delivery attempt that pi rejected synchronously; the outbox keeps the request. */
    const deliveryOptions = (ctx: ExtensionContext): QuestionDeliveryOptions => ({
        onError: (error) => {
            ctx.ui.notify(
                `Question answers could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
        },
    });

    pi.on("session_start", (_event, ctx) => {
        // The previous session's listeners close over its ctx and a duplicate subscription
        // would render and persist twice per event, so they go first - before the state
        // changes below would wake them.
        unsubscribe();
        dock.detach({ retired: true });

        // A session starts from the question state recorded on its branch.
        questionManager.restore(ctx);
        dock.attach(ctx);

        unsubscribeManager = questionManager.subscribe(
            (event) => {
                try {
                    // `requests-cleared` is the session-boundary reset, not a state change;
                    // writing an empty snapshot there would shadow the pending questions of
                    // the branch being restored.
                    if (event.type !== "requests-cleared") {
                        persist(ctx);
                    }
                } finally {
                    // A snapshot that failed must not also leave the dock showing stale order.
                    dock.refresh();
                }
            },
            (error) => {
                // Persistence reports its own failures; this is for a listener that threw for
                // another reason, such as the dock render.
                ctx.ui.notify(
                    `Question dock could not be updated: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            },
        );

        // Registered after the persist listener: the snapshot has to exist before the
        // answer message resumes the model.
        unsubscribeNotifications = registerQuestionAnswerNotifications(
            pi,
            questionManager,
            deliveryOptions(ctx),
        );

        // A session can start with settled answers whose message never reached the previous
        // one; the outbox is durable, so reconcile it against this branch. Confirmed answers
        // are released (and persisted), the rest are attempted again.
        reconcileQuestionDeliveries(pi, questionManager, ctx, deliveryOptions(ctx));
    });

    // A settled run has appended every answer message it accepted, so the confirmed ones leave
    // the outbox here instead of riding along in every snapshot until the next session start.
    pi.on("agent_settled", (_event, ctx) => {
        releaseDeliveredQuestions(questionManager, ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        // Drafts change without a manager event, so the final snapshot is written here.
        persist(ctx);
        unsubscribe();
        dock.detach();
        // A panel that is still up belongs to the session that ends; the reset stops it from
        // continuing after the boundary.
        panels.reset();
        questionManager.clearAll();
    });

    pi.on("session_before_tree", (_event, ctx) => {
        persist(ctx);
    });

    pi.on("session_tree", (_event, ctx) => {
        // The branch changed under the overlay, so a panel that is still up belongs to the
        // branch being left; the reset stops it from continuing into this one.
        panels.reset();
        questionManager.clearAll();
        questionManager.restore(ctx);

        // Reconciliation reads the branch that is active now, never the one being left:
        // branch A's undelivered answers must not be sent into branch B.
        reconcileQuestionDeliveries(pi, questionManager, ctx, deliveryOptions(ctx));

        dock.refresh();
    });

    pi.registerTool(askUserQuestions(questionManager, panels, persist));
    pi.registerTool(withdrawUserQuestions(questionManager));
    registerQuestionCommand(pi, questionManager, panels, persist);

    pi.registerMessageRenderer<AskQuestionAnswerMessageDetails>(
        ASK_QUESTION_ANSWER_MESSAGE,
        (message, _options, theme) => renderQuestionAnswerMessage(message.details, theme),
    );

    return questionManager;
}
