import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
    createDockContribution,
    type LuneDockSnapshot,
} from "@lune_99/pi-lune-extensions-core/dock";
import { openPendingQuestions } from "../commands/question.ts";
import { singleLine } from "../core/question-format.ts";
import { questionManager } from "../core/questionManager.ts";
import { fitRanked, type RankedPart } from "./dock-line.ts";
import { questionDock } from "./question-dock.ts";

export const QUESTION_CONTRIBUTION_ID = "ask-question";

/**
 * Ranks of the line's parts: a narrow cell drops the lowest first, so `agent waiting` stays
 * longest and the request's title goes first.
 */
const WAITING_RANK = 2;
const COUNT_RANK = 1;
const TITLE_RANK = 0;

/**
 * Base says whether the agent waits; detail adds the count; full adds the next request's title.
 * No level cuts a part: a narrow cell leaves out whole parts, then the title, down to the marker.
 */
export function getQuestionDockSnapshot(ctx: ExtensionContext): LuneDockSnapshot {
    const theme = ctx.ui.theme;
    const muted = (text: string): string => theme.fg("muted", text);
    const count = questionManager.getPendingRequests().length;
    const next = questionManager.nextPendingRequest();
    const title = singleLine(next?.questions[0]?.header ?? next?.questions[0]?.question ?? "");
    // A waited-on request is always the next one; every level shows that the agent is paused.
    const waiting: RankedPart[] =
        next !== undefined && questionManager.isWaiting(next.id)
            ? [{ text: muted("agent waiting"), rank: WAITING_RANK }]
            : [];
    const summary: RankedPart[] = [
        ...(count === 0
            ? []
            : [
                  {
                      text: muted(`${count} pending ${count === 1 ? "request" : "requests"}`),
                      rank: COUNT_RANK,
                  },
              ]),
        ...waiting,
    ];
    const marker = theme.fg(count > 0 ? "warning" : "dim", count > 0 ? "●" : "○");
    const component = (parts: readonly RankedPart[]): Component => ({
        render: (width) => [
            fitRanked(parts, width, (texts) => [`${marker} Ask`, ...texts].join(muted(" · "))) ??
                (visibleWidth(marker) <= width ? marker : ""),
        ],
        invalidate() {},
    });
    return {
        base: component(waiting),
        detail: component(summary),
        full: component(
            title.length > 0 ? [...summary, { text: muted(title), rank: TITLE_RANK }] : summary,
        ),
    };
}

export function createQuestionDockContribution(persist: (ctx: ExtensionContext) => void) {
    return createDockContribution({
        id: QUESTION_CONTRIBUTION_ID,
        getSnapshot: getQuestionDockSnapshot,
        activate: (ctx) => openPendingQuestions(ctx, persist),
        standalone: questionDock,
    });
}
