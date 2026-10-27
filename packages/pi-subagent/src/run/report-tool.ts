import { defineTool } from "@earendil-works/pi-coding-agent";
import Type from "typebox";

import { stringEnum } from "../schema.ts";
import { REPORT_STATUSES, type RunReport } from "./types.ts";

export const REPORT_TOOL_NAME = "report";

const reportParameters = Type.Object({
    status: stringEnum(REPORT_STATUSES, {
        description:
            '"done": the task is complete. "blocked": you cannot finish, for example because you ' +
            'decline the task or finish only part of it. "needs_input": you need something before ' +
            "you can continue.",
    }),
    summary: Type.String({
        description: "The result for the main agent. For blocked, also what you did.",
    }),
    reason: Type.Optional(
        Type.String({ description: "Required for blocked: why you cannot finish." }),
    ),
    question: Type.Optional(
        Type.String({ description: "Required for needs_input: what you need to continue." }),
    ),
});

/**
 * The run's only own tool, given to the SDK as a plain custom tool. `terminate` ends the turn when
 * `report` is the only call in its batch. A later report in the same turn becomes the turn's report;
 * the earlier ones still reach the main agent.
 */
export function createReportTool(onReport: (report: RunReport) => void) {
    return defineTool({
        name: REPORT_TOOL_NAME,
        label: "Report",
        description:
            "Report your result to the main agent. Call it as the last action of every turn. " +
            "The main agent receives the report when your turn ends.",
        parameters: reportParameters,
        async execute(_toolCallId, params) {
            const report = normalizeReport(params);

            onReport(report);

            return {
                content: [
                    {
                        type: "text",
                        text: "Report recorded. The main agent receives it when this turn ends.",
                    },
                ],
                details: report,
                terminate: true,
            };
        },
    });
}

/** Throws for the model to retry, because a blocked or needs_input report without its field is useless. */
export function normalizeReport(params: {
    status: RunReport["status"];
    summary: string;
    reason?: string;
    question?: string;
}): RunReport {
    const report: RunReport = { status: params.status, summary: params.summary.trim() };
    const reason = params.reason?.trim();
    const question = params.question?.trim();

    if (params.status === "blocked" && !reason) {
        throw new Error('A "blocked" report needs a reason.');
    }

    if (params.status === "needs_input" && !question) {
        throw new Error('A "needs_input" report needs a question.');
    }

    if (reason) {
        report.reason = reason;
    }

    if (question) {
        report.question = question;
    }

    return report;
}
