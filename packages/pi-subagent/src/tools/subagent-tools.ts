import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { defineTool, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import Type, { type TSchema } from "typebox";

import type { ToolCatalog } from "../catalog.ts";
import type { AgentDefinition } from "../definitions.ts";
import { REPORT_TOOL_NAME } from "../run/report-tool.ts";
import type { RunManager } from "../run/run-manager.ts";
import type { SendOutcome } from "../run/run.ts";
import { ISOLATION_MODES, THINKING_LEVELS, type Isolation } from "../run/types.ts";
import { stringEnum } from "../schema.ts";
import { formatRunList, formatRunStatus, formatStarted } from "./format.ts";

export const SUBAGENT_TOOL_NAMES = [
    "subagent_start",
    "subagent_send",
    "subagent_status",
    "subagent_stop",
] as const;

/** A catalog description keeps only the first sentence of each tool's own description. */
const CATALOG_DESCRIPTION_CHARS = 100;

interface StartInput {
    task: string;
    agent?: string;
    model?: string;
    thinking?: ThinkingLevel;
    tools?: string[];
    isolation?: Isolation;
}

export interface SubagentToolsOptions {
    manager: RunManager;
    definitions: readonly AgentDefinition[];
    /** `provider/id` references the `model` parameter allows. */
    models: readonly string[];
    catalog: ToolCatalog;
}

/**
 * The main agent's four tools. Their descriptions are fixed; only the `subagent_start` schema
 * depends on the session, and it is built once at `session_start` and kept for the session.
 */
export function createSubagentTools(options: SubagentToolsOptions): ToolDefinition[] {
    const { manager } = options;

    const start = defineTool({
        name: "subagent_start",
        label: "Subagent Start",
        description:
            "Start a subagent run: a separate Pi session with a fresh context that works on one task " +
            "in the background and reports back. Delegate work that can proceed apart from yours, " +
            "such as a review, an investigation or an independent change, or exploration that would " +
            "fill your context. The task is the run's only context: state the goal, the expected " +
            "output and the limits of the work. agent is optional: name an agent from the subagents " +
            "list to reuse its role, or leave it out and set the run up in this call. Use isolation " +
            '"shared" when the run must see or change your working directory, uncommitted changes ' +
            'included. Use "worktree" for parallel changes that must not touch your files: the run ' +
            "gets its own Git worktree at the current HEAD commit, without uncommitted changes. The " +
            "call returns the run ID at once; a message arrives when the run's turn ends.",
        promptSnippet:
            "Delegate a task to a subagent run that works in the background and reports back.",
        promptGuidelines: [
            "A subagent run reports with a message when its turn ends. Continue your own work meanwhile and do not poll subagent_status.",
            "When a run reports needs_input, answer with subagent_send if you can. Ask the user only when only the user can answer.",
            "A worktree run's changes stay in its worktree. Review them before you use them; nothing merges them automatically.",
        ],
        parameters: Type.Object(startProperties(options)),

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            // The schema is built at runtime, so its static type is loose; Pi has validated the
            // arguments against it.
            const input = params as unknown as StartInput;
            const run = await manager.start(
                {
                    task: input.task,
                    agent: input.agent,
                    model: input.model,
                    thinking: input.thinking,
                    tools: input.tools,
                    isolation: input.isolation,
                },
                ctx,
                {
                    signal,
                    onProgress: (text) =>
                        onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
                },
            );

            return { content: [{ type: "text", text: formatStarted(run) }], details: undefined };
        },

        renderCall(args, theme) {
            const input = args as Partial<StartInput>;

            return callLine(theme, "subagent_start", [
                input.agent ?? "inline",
                preview(input.task),
            ]);
        },

        renderResult: renderText,
    });

    const send = defineTool({
        name: "subagent_send",
        label: "Subagent Send",
        description:
            "Send a message to a subagent run of the current branch. A running run receives it as " +
            "a steer message in its current turn. An idle, failed or interrupted run starts a new " +
            "turn with it, in the same session and working directory. Use it to answer a " +
            "needs_input question, to correct a run, or to continue its work. Returns once the run " +
            "accepted the message; a message arrives when the turn ends.",
        promptSnippet: "Answer, steer or continue a subagent run.",
        parameters: Type.Object({
            runId: Type.String({ description: "The run ID that subagent_start returned." }),
            message: Type.String({ description: "The message for the run." }),
        }),

        async execute(_toolCallId, params, signal, onUpdate) {
            const run = manager.branchRun(params.runId);
            const outcome = await manager.send(run, params.message, "main-agent", {
                signal,
                onProgress: (text) =>
                    onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
            });

            return {
                content: [{ type: "text", text: sendText(run.name, run.id, outcome) }],
                details: undefined,
            };
        },

        renderCall(args, theme) {
            return callLine(theme, "subagent_send", [args.runId, preview(args.message)]);
        },

        renderResult: renderText,
    });

    const status = defineTool({
        name: "subagent_status",
        label: "Subagent Status",
        description:
            "Read subagent runs of the current branch without changing them: state, start values, " +
            "workspace, token usage and the last turn's report. Without runId it lists every run " +
            "with a preview of its report; with runId it returns that run's whole report.",
        promptSnippet: "Read the state and last report of subagent runs.",
        parameters: Type.Object({
            runId: Type.Optional(Type.String({ description: "One run ID. Default: every run." })),
        }),

        async execute(_toolCallId, params) {
            const text =
                params.runId === undefined
                    ? formatRunList(manager.branchRuns(), manager.otherBranchRuns().length)
                    : formatRunStatus(manager.branchRun(params.runId));

            return { content: [{ type: "text", text }], details: undefined };
        },

        renderCall(args, theme) {
            return callLine(theme, "subagent_status", [args.runId ?? "all runs"]);
        },

        renderResult: renderText,
    });

    const stop = defineTool({
        name: "subagent_stop",
        label: "Subagent Stop",
        description:
            "Stop the current turn of a subagent run of the current branch. The run becomes " +
            "interrupted; its session and worktree stay, and subagent_send continues it. You get " +
            "no turn-end message for a run you stop; this result holds its state.",
        promptSnippet: "Stop a running subagent run.",
        parameters: Type.Object({
            runId: Type.String({ description: "The run ID that subagent_start returned." }),
        }),

        async execute(_toolCallId, params) {
            const run = manager.branchRun(params.runId);
            const stopped = await manager.stop(run, "main-agent");
            const text = stopped
                ? `Stopped run ${run.name} (${run.id}).\n\n${formatRunStatus(run)}`
                : `Run ${run.name} (${run.id}) is not running; its state is ${run.state}.`;

            return { content: [{ type: "text", text }], details: undefined };
        },

        renderCall(args, theme) {
            return callLine(theme, "subagent_stop", [args.runId]);
        },

        renderResult: renderText,
    });

    return [start, send, status, stop];
}

function startProperties(options: SubagentToolsOptions): Record<string, TSchema> {
    const properties: Record<string, TSchema> = {
        task: Type.String({
            description:
                "The run's first message and only context: the goal, the expected output and the " +
                "limits of the work.",
        }),
    };
    const agents = options.definitions.map((definition) => definition.name);

    if (agents.length > 0) {
        properties.agent = Type.Optional(
            stringEnum(agents, {
                description:
                    "An agent from the subagents list. Leave it out to set up the run in this call.",
            }),
        );
    }

    if (options.models.length > 0) {
        properties.model = Type.Optional(
            stringEnum(options.models, {
                description: "provider/id. Default: the agent's model, then your current model.",
            }),
        );
    }

    properties.thinking = Type.Optional(
        stringEnum(THINKING_LEVELS, {
            description: "Default: the agent's thinking level, then your current level.",
        }),
    );
    properties.tools = Type.Optional(
        Type.Array(Type.String(), { description: toolsDescription(options.catalog) }),
    );
    properties.isolation = Type.Optional(
        stringEnum(ISOLATION_MODES, {
            description: 'Default: the agent\'s isolation, then "shared".',
        }),
    );

    return properties;
}

function toolsDescription(catalog: ToolCatalog): string {
    const tools = catalog.tools
        .filter((tool) => tool.name !== REPORT_TOOL_NAME)
        .map((tool) => `${tool.name}: ${firstSentence(tool.description)}`);

    return [
        "Exact names of the task tools the run gets. Default: the agent's tools, then the " +
            "defaultTools setting. The run always gets report as well.",
        "Available:",
        ...tools.map((line) => `- ${line}`),
        "- mcp__<server>__<tool>: a tool of an MCP server configured for the run's working directory.",
    ].join("\n");
}

function firstSentence(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    const end = line.search(/[.!?](\s|$)/);
    const sentence = end === -1 ? line : line.slice(0, end + 1);

    return sentence.length > CATALOG_DESCRIPTION_CHARS
        ? `${sentence.slice(0, CATALOG_DESCRIPTION_CHARS - 1)}…`
        : sentence;
}

function sendText(name: string, runId: string, outcome: SendOutcome): string {
    switch (outcome) {
        case "started":
            return `Run ${name} (${runId}) started a new turn with your message. A message arrives when the turn ends.`;
        case "steered":
            return `Run ${name} (${runId}) is running; your message steers its current turn.`;
        case "deferred":
            return `Run ${name} (${runId}) is ending its turn; your message starts the next turn after it.`;
    }
}

function callLine(theme: Theme, tool: string, parts: readonly (string | undefined)[]): Text {
    const shown = parts.filter((part): part is string => part !== undefined && part !== "");

    return new Text(
        theme.fg("toolTitle", theme.bold(tool)) +
            (shown.length > 0 ? ` ${theme.fg("muted", shown.join(" · "))}` : ""),
        0,
        0,
    );
}

/** The call is drawn while the model still streams its arguments, so a value can be missing. */
function preview(text: unknown): string | undefined {
    if (typeof text !== "string") {
        return undefined;
    }

    const line = text.replace(/\s+/g, " ").trim();

    return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The result text: its first line, or all of it when expanded. */
function renderText(
    result: { content: readonly { type: string; text?: string }[] },
    options: { expanded: boolean },
    theme: Theme,
    context: { isError: boolean },
): Text {
    const text = result.content
        .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("\n")
        .trim();
    const shown = options.expanded ? text : (text.split("\n")[0] ?? "");

    return new Text(theme.fg(context.isError ? "error" : "toolOutput", shown), 0, 0);
}
