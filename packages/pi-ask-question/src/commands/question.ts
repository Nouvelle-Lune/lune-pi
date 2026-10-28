import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { QuestionManager } from "../core/questionManager.ts";
import type { QuestionPanels } from "../tui/panel/question-panel.ts";

/** Reopen the panel after Esc closed it, without having to ask the model again. */
export function registerQuestionCommand(
    pi: ExtensionAPI,
    manager: QuestionManager,
    panels: QuestionPanels,
    persist: (ctx: ExtensionContext) => void,
): void {
    pi.registerCommand("question", {
        description: "Open the pending question panel",
        handler: (_args, ctx) => openPendingQuestions(ctx, manager, panels, persist),
    });
}

/** The dock and slash command share panel selection, draft persistence and mode checks. */
export async function openPendingQuestions(
    ctx: ExtensionContext,
    manager: QuestionManager,
    panels: QuestionPanels,
    persist: (ctx: ExtensionContext) => void,
): Promise<void> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify("Question panel needs interactive mode", "warning");
        return;
    }
    if (manager.getPendingRequests().length === 0) {
        ctx.ui.notify("No pending questions", "info");
        return;
    }
    await panels.open(ctx, { onDeferred: () => persist(ctx) });
}
