import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { singleLine } from "../core/question-format.ts";
import type { QuestionManager } from "../core/questionManager.ts";
import { fitRanked, type RankedPart } from "./dock-line.ts";

const WIDGET_ID = "pi-ask-question";

/**
 * Ranks of the parts after the count: a narrow row drops the lowest first. The hint outranks the
 * question, so a narrow terminal still says how to reopen the panel.
 */
const WAITING_RANK = 2;
const HINT_RANK = 1;
const QUESTION_RANK = 0;

/**
 * Persistent hint below the editor that a question is waiting.
 *
 * The panel itself is transient: Esc closes it, so without this row a closed panel
 * would be invisible until the user remembered `/question`. No part is cut: a narrow row
 * leaves out whole parts after the count.
 */
export class QuestionDock {
    private ctx: ExtensionContext | undefined;
    private readonly manager: QuestionManager;

    constructor(manager: QuestionManager) {
        this.manager = manager;
    }

    setCtx(ctx: ExtensionContext | undefined): void {
        this.ctx = ctx;
    }

    render(): void {
        if (!this.ctx || !this.ctx.hasUI) {
            return;
        }

        const pending = this.manager.getPendingRequests();

        if (pending.length === 0) {
            this.ctx.ui.setWidget(WIDGET_ID, undefined);
            return;
        }

        const next = this.manager.nextPendingRequest();
        const theme = this.ctx.ui.theme;
        // The row names questions, so it counts them: one request can hold several. The Lune
        // Dock item counts requests instead, and the two are never shown together.
        const questions = pending.reduce((total, request) => total + request.questions.length, 0);
        const count = `${questions} pending ${questions === 1 ? "question" : "questions"}`;
        // The question the panel would show next, so the hint and `/question` agree. Its header is
        // the shorter variant for a row too narrow for the whole question.
        const first = next?.questions[0];
        const summaries = [
            singleLine(first?.question ?? ""),
            singleLine(first?.header ?? ""),
        ].filter((text) => text.length > 0);
        // A waited-on request is always the next one, and the agent is paused until it settles.
        const waiting = next !== undefined && this.manager.isWaiting(next.id);
        const lead = theme.fg("accent", count);
        const separator = theme.fg("dim", " · ");
        const compose = (texts: readonly string[]): string => [lead, ...texts].join(separator);
        const parts = (summary: string | undefined): RankedPart[] => [
            ...(waiting
                ? [{ text: theme.fg("warning", "agent waiting"), rank: WAITING_RANK }]
                : []),
            ...(summary === undefined
                ? []
                : [{ text: theme.fg("muted", summary), rank: QUESTION_RANK }]),
            { text: theme.fg("dim", "/question to answer"), rank: HINT_RANK },
        ];
        const row = (width: number): string => {
            // The summary ranks lowest, so it stays only when the whole row fits.
            const summary = summaries.find(
                (text) => visibleWidth(compose(parts(text).map((part) => part.text))) <= width,
            );

            return fitRanked(parts(summary), width, compose) ?? "";
        };

        // Pi pads string rows by one column on each side; this row keeps the same margins.
        this.ctx.ui.setWidget(
            WIDGET_ID,
            () => ({
                render: (width) => [` ${row(Math.max(0, width - 2))}`],
                invalidate() {},
            }),
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
