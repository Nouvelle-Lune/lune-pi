import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { summarizeText } from "../core/question-format.ts";
import { questionManager } from "../core/questionManager.ts";

const WIDGET_ID = "pi-ask-question";

/** Budget for the question preview before the hint; keeps the hint visible on narrow terminals. */
const SUMMARY_MAX_WIDTH = 40;

/**
 * Persistent hint below the editor that a question is waiting.
 *
 * The panel itself is transient: Esc closes it, so without this row a closed panel
 * would be invisible until the user remembered `/question`.
 */
export class QuestionDock {
    private ctx: ExtensionContext | undefined;

    setCtx(ctx: ExtensionContext | undefined): void {
        this.ctx = ctx;
    }

    render(): void {
        if (!this.ctx || !this.ctx.hasUI) {
            return;
        }

        const pending = questionManager.getPendingRequests();

        if (pending.length === 0) {
            this.ctx.ui.setWidget(WIDGET_ID, undefined);
            return;
        }

        const next = questionManager.nextPendingRequest();
        const theme = this.ctx.ui.theme;
        // The row names questions, so it counts them: one request can hold several. The Lune
        // Dock item counts requests instead, and the two are never shown together.
        const questions = pending.reduce((total, request) => total + request.questions.length, 0);
        const count = `${questions} pending ${questions === 1 ? "question" : "questions"}`;
        // The question the panel would show next, so the hint and `/question` agree.
        const summary = summarizeText(next?.questions[0]?.question ?? "", SUMMARY_MAX_WIDTH);
        // A waited-on request is always the next one, and the agent is paused until it settles.
        const waiting = next !== undefined && questionManager.isWaiting(next.id);

        this.ctx.ui.setWidget(
            WIDGET_ID,
            [
                [
                    theme.fg("accent", count),
                    waiting ? theme.fg("warning", "agent waiting") : undefined,
                    summary.length > 0 ? theme.fg("muted", summary) : undefined,
                    theme.fg("dim", "/question to answer"),
                ]
                    .filter((part): part is string => part !== undefined)
                    .join(theme.fg("dim", " · ")),
            ],
            {
                placement: "belowEditor",
            },
        );
    }

    clear(): void {
        if (!this.ctx || !this.ctx.hasUI) {
            return;
        }

        this.ctx.ui.setWidget(WIDGET_ID, undefined);
    }
}

export const questionDock = new QuestionDock();
