import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { defineTool, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import Type, { type TSchema } from "typebox";

import type { ToolCatalog } from "../catalog.ts";
import type { AgentDefinition } from "../definitions.ts";
import { AUTO_MODEL } from "../models.ts";
import { REPORT_TOOL_NAME } from "../run/report-tool.ts";
import { agentSettingsProblem, type RunManager, type StartParams } from "../run/run-manager.ts";
import type { SendOutcome } from "../run/run.ts";
import { ISOLATION_MODES, THINKING_LEVELS, type Isolation } from "../run/types.ts";
import { stringEnum } from "../schema.ts";
import {
    formatRunList,
    formatRunStatus,
    formatStarted,
    formatStartedBatch,
    type StartOutcome,
} from "./format.ts";

export const SUBAGENT_TOOL_NAMES = [
    "subagent_start",
    "subagent_send",
    "subagent_status",
    "subagent_stop",
] as const;

/** A catalog description keeps only the first sentence of each tool's own description. */
const CATALOG_DESCRIPTION_CHARS = 100;

/** One run's start values: the top level of `subagent_start`, or one entry of its `tasks`. */
interface RunInput {
    task: string;
    title?: string;
    agent?: string;
    model?: string;
    thinking?: ThinkingLevel;
    tools?: string[];
    isolation?: Isolation;
}

interface StartInput extends Partial<RunInput> {
    tasks?: RunInput[];
}

/** The start values that a `tasks` call takes in each entry, not at the top level. */
const RUN_FIELDS = ["title", "agent", "model", "thinking", "tools", "isolation"] as const;

const TASK_DESCRIPTION =
    "The run's first message; it does not inherit your conversation. Give the goal, relevant " +
    "context and paths, expected output, acceptance checks and action limits. For edits, assign " +
    "the files or scope it owns.";

export interface SubagentToolsOptions {
    manager: RunManager;
    definitions: readonly AgentDefinition[];
    /** `provider/id` references the `model` parameter allows. */
    models: readonly string[];
    catalog: ToolCatalog;
}

/**
 * The main agent's four tools. Their descriptions are fixed; only the `subagent_start` schema
 * depends on the session. It is rebuilt only when the allowed model list changes.
 */
export function createSubagentTools(options: SubagentToolsOptions): ToolDefinition[] {
    const { manager } = options;

    const start = defineTool({
        name: "subagent_start",
        label: "Subagent Start",
        description:
            "Start a separate Pi session for a bounded task in the background. Delegate when " +
            "independent execution, isolated context or a fresh verification pass improves speed " +
            "or quality. Handle quick tasks and tightly coupled steps directly. Use agent to " +
            "run a listed role with its own settings; give only task and title with it. Omit " +
            "agent for an inline run that sets model, thinking, tools and isolation in the call. " +
            'Use isolation "shared" to work in your current directory, including uncommitted ' +
            'changes; use "worktree" for a separate Git checkout at HEAD, without uncommitted or ' +
            "untracked files. Tool selection and worktrees are not a security sandbox. Give task " +
            "for one run or tasks for independent runs started together. The call returns run " +
            "IDs immediately; each turn's report arrives as a message.",
        promptSnippet: "Delegate bounded work to a background session and receive its report.",
        promptGuidelines: [
            "Give a run a brief title so the user can identify it in the /agents inspector and Dock.",
            "Keep your work distinct from delegated work unless overlap is intentional verification. Coordinate shared-file edits so writers do not overlap.",
            "Reports arrive when turns end; do not poll subagent_status. Continue other useful work, or end your turn if none remains.",
            "When a run reports needs_input, answer with subagent_send if you can. Ask the user only when only the user can answer.",
            "Pass a run's ID, never its name or title, to subagent_send, subagent_status and subagent_stop.",
            "Validate findings and changes you rely on. Worktree changes stay there until explicitly reviewed and integrated; nothing merges automatically.",
        ],
        parameters: Type.Object(startProperties(options)),

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            // The schema is built at runtime, so its static type is loose; Pi has validated the
            // arguments against it.
            const input = params as unknown as StartInput;
            const progress = (text: string): void =>
                onUpdate?.({ content: [{ type: "text", text }], details: undefined });

            if (input.tasks === undefined) {
                if (input.task === undefined) {
                    throw new Error("Give task for one run, or tasks for several runs.");
                }

                const run = await manager.start(startParams(input.task, input), ctx, {
                    signal,
                    onProgress: progress,
                });

                return {
                    content: [{ type: "text", text: formatStarted(run) }],
                    details: undefined,
                };
            }

            const entries = input.tasks;

            checkBatch(input, entries);

            // Each entry starts on its own, as parallel calls would: a failed one undoes only its
            // own work, because a run that started cannot be taken back.
            const steps = entries.map(() => "Starting");
            const outcomes = await Promise.all(
                entries.map(async (entry, index): Promise<StartOutcome> => {
                    try {
                        const run = await manager.start(startParams(entry.task, entry), ctx, {
                            signal,
                            onProgress: (text) => {
                                steps[index] = text;
                                progress(batchProgress(steps));
                            },
                        });

                        steps[index] = `Started run ${run.id}`;

                        return { run };
                    } catch (error) {
                        steps[index] = "Failed";

                        return { error: error instanceof Error ? error.message : String(error) };
                    } finally {
                        progress(batchProgress(steps));
                    }
                }),
            );
            const text = formatStartedBatch(outcomes);

            if (outcomes.every((outcome) => "error" in outcome)) {
                throw new Error(text);
            }

            return { content: [{ type: "text", text }], details: undefined };
        },

        renderCall(args, theme) {
            const input = args as Partial<StartInput>;

            if (Array.isArray(input.tasks)) {
                return batchCall(theme, input.tasks);
            }

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
            runId: Type.String({
                description:
                    "The run ID that subagent_start returned, such as 8416992c. Pass the ID, not " +
                    "the run's name or title.",
            }),
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
                content: [{ type: "text", text: sendText(run.id, outcome) }],
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
            runId: Type.Optional(
                Type.String({
                    description:
                        "One run ID, such as 8416992c. Default: every run. Pass the ID, not the " +
                        "run's name or title.",
                }),
            ),
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
            runId: Type.String({
                description:
                    "The run ID that subagent_start returned, such as 8416992c. Pass the ID, not " +
                    "the run's name or title.",
            }),
        }),

        async execute(_toolCallId, params) {
            const run = manager.branchRun(params.runId);
            const stopped = await manager.stop(run, "main-agent");
            const text = stopped
                ? `Stopped run ${run.id}.\n\n${formatRunStatus(run)}`
                : `Run ${run.id} is not running; its state is ${run.state}.`;

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
    return {
        ...runProperties(options, {
            task: Type.Optional(
                Type.String({
                    description: `${TASK_DESCRIPTION} Leave it out when you give tasks.`,
                }),
            ),
            toolsText: toolsDescription(options.catalog),
        }),
        tasks: Type.Optional(
            Type.Array(
                Type.Object(
                    runProperties(options, {
                        task: Type.String({ description: TASK_DESCRIPTION }),
                        // The catalog is long, so an entry points to it instead of repeating it.
                        toolsText:
                            "Exact names of the task tools the run gets, from the list of the " +
                            "top-level tools parameter. Default: the defaultTools setting.",
                    }),
                ),
                {
                    description:
                        "Independent runs started together instead of task. Set title, agent, " +
                        "model, thinking, tools and isolation per entry, not at the top level. A " +
                        "failed start does not stop the other runs.",
                },
            ),
        ),
    };
}

/**
 * One run's values, at the top level and in each `tasks` entry. The agent comes first, so a call
 * names its role before it writes the task; the settings after the task are for inline runs.
 */
function runProperties(
    options: SubagentToolsOptions,
    run: { task: TSchema; toolsText: string },
): Record<string, TSchema> {
    const properties: Record<string, TSchema> = {};
    const agents = options.definitions.map((definition) => definition.name);

    if (agents.length > 0) {
        properties.agent = Type.Optional(
            stringEnum(agents, {
                description:
                    "An agent from the subagents list. It runs with its definition's model, " +
                    "thinking, tools and isolation, so give only task and title with it. Leave " +
                    "it out to set these in this call.",
            }),
        );
    }

    properties.title = Type.Optional(
        Type.String({
            description:
                "A brief one-line title for this run, shown in the /agents inspector, Dock and " +
                "run notifications. The subagent tools take a run's ID, never its title.",
        }),
    );
    properties.task = run.task;

    const inlineOnly = agents.length > 0 ? "Only without agent. " : "";

    if (options.models.length > 0) {
        properties.model = Type.Optional(
            stringEnum([AUTO_MODEL, ...options.models], {
                description:
                    `${inlineOnly}provider/id, or "${AUTO_MODEL}" to let a classifier rate the ` +
                    "task and use the model set for its tier; it also sets thinking when the " +
                    "call does not. Default: your current model.",
            }),
        );
    }

    properties.thinking = Type.Optional(
        stringEnum(THINKING_LEVELS, {
            description:
                `${inlineOnly}Default: the classifier's level for model auto, then your ` +
                "current level.",
        }),
    );
    properties.tools = Type.Optional(
        Type.Array(Type.String(), { description: `${inlineOnly}${run.toolsText}` }),
    );
    properties.isolation = Type.Optional(
        stringEnum(ISOLATION_MODES, { description: `${inlineOnly}Default: "shared".` }),
    );

    return properties;
}

function toolsDescription(catalog: ToolCatalog): string {
    const tools = catalog.tools
        .filter((tool) => tool.name !== REPORT_TOOL_NAME)
        .map((tool) => `${tool.name}: ${firstSentence(tool.description)}`);

    return [
        "Exact names of the task tools the run gets. Choose only tools needed for this task; " +
            "prefer read-only tools for investigation. Default: the defaultTools setting. The " +
            "run always gets report as well.",
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

function startParams(task: string, values: Omit<RunInput, "task">): StartParams {
    return {
        task,
        title: values.title,
        agent: values.agent,
        model: values.model,
        thinking: values.thinking,
        tools: values.tools,
        isolation: values.isolation,
    };
}

/**
 * A `tasks` call takes start values only in its entries, and an agent entry takes no inline
 * settings. Both are checked before any entry starts, so a call that breaks either starts nothing.
 */
function checkBatch(input: StartInput, entries: readonly RunInput[]): void {
    if (input.task !== undefined) {
        throw new Error("Give task for one run or tasks for several runs, not both.");
    }

    const topLevel = RUN_FIELDS.filter((field) => input[field] !== undefined);

    if (topLevel.length > 0) {
        throw new Error(
            `With tasks, set ${topLevel.join(", ")} in each entry instead of at the top level.`,
        );
    }

    if (entries.length === 0) {
        throw new Error("tasks has no entries.");
    }

    const problems = entries.flatMap((entry, index) => {
        const problem = agentSettingsProblem(entry);

        return problem ? [`tasks[${index}]: ${problem}`] : [];
    });

    if (problems.length > 0) {
        throw new Error(`No run started.\n${problems.join("\n")}`);
    }
}

function batchProgress(steps: readonly string[]): string {
    return [
        `Starting ${steps.length} run${steps.length === 1 ? "" : "s"}`,
        ...steps.map((step, index) => `tasks[${index}]: ${step}`),
    ].join("\n");
}

function sendText(runId: string, outcome: SendOutcome): string {
    switch (outcome) {
        case "started":
            return `Run ${runId} started a new turn with your message. A message arrives when the turn ends.`;
        case "steered":
            return `Run ${runId} is running; your message steers its current turn.`;
        case "deferred":
            return `Run ${runId} is ending its turn; your message starts the next turn after it.`;
    }
}

function callLine(theme: Theme, tool: string, parts: readonly (string | undefined)[]): Text {
    return new Text(callText(theme, tool, parts), 0, 0);
}

function callText(theme: Theme, tool: string, parts: readonly (string | undefined)[]): string {
    const shown = shownParts(parts);

    return (
        theme.fg("toolTitle", theme.bold(tool)) +
        (shown.length > 0 ? ` ${theme.fg("muted", shown.join(" · "))}` : "")
    );
}

/** A `tasks` call: the run count, then one line per entry. An entry can still be streaming. */
function batchCall(theme: Theme, entries: readonly unknown[]): Text {
    const lines = entries.map((entry) => {
        const run = (typeof entry === "object" && entry !== null ? entry : {}) as Partial<RunInput>;
        const parts = shownParts([
            typeof run.agent === "string" ? run.agent : "inline",
            preview(run.title) || preview(run.task),
        ]);

        return `  ${theme.fg("muted", parts.join(" · "))}`;
    });
    const count = `${entries.length} run${entries.length === 1 ? "" : "s"}`;

    return new Text([callText(theme, "subagent_start", [count]), ...lines].join("\n"), 0, 0);
}

function shownParts(parts: readonly (string | undefined)[]): string[] {
    return parts.filter((part): part is string => part !== undefined && part !== "");
}

/** The call is drawn while the model still streams its arguments, so a value can be missing. */
function preview(text: unknown): string | undefined {
    if (typeof text !== "string") {
        return undefined;
    }

    const line = stripTerminalSequences(text).replace(/\s+/g, " ").trim();

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
