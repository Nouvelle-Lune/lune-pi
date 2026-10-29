import { basename } from "node:path";

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    createSettingsMenuField,
    type SettingsChoice,
    type SettingsChoiceSource,
    type SettingsMenu,
    type SettingsMenuDefinition,
    type SettingsPanelField,
    type SettingsPanelSchema,
} from "@lune_99/pi-lune-extensions-core/panel";
import type { DeepReadonly, SettingsScope } from "@lune_99/pi-lune-extensions-core/settings";
import Type from "typebox";

import type { ToolCatalog } from "../catalog.ts";
import { editDefinitionFile, type DefinitionField } from "../definition-file.ts";
import { loadDefinitions, type AgentDefinition, type LoadedDefinitions } from "../definitions.ts";
import { AUTO_MODEL, allowedModels, formatModelRef, type ModelRef } from "../models.ts";
import { definitionsDir, projectDefinitionsDir } from "../paths.ts";
import { REPORT_TOOL_NAME } from "../run/report-tool.ts";
import { ISOLATION_MODES, THINKING_LEVELS } from "../run/types.ts";
import type { SubagentSettings } from "./schema.ts";

export interface AgentsMenuOptions {
    /** The tools runs can select in the current session; undefined until it has started. */
    catalog(): ToolCatalog | undefined;
    /** After a file was written; `previousFile` differs from `edited.file` after a rename. */
    onEdit(previousFile: string, edited: AgentDefinition): void;
}

/**
 * The Custom agents menu: one entry per definition file of the viewed scope, global for the user
 * folder and project for the project folder, and one page of fields per agent. Every field reads
 * and writes the file itself, so the page always shows what the next session loads.
 */
export function agentsMenu(options: AgentsMenuOptions): SettingsMenuDefinition<SubagentSettings> {
    // A renamed file keeps the entry ID it had, so its open page stays open.
    const entryIds = new Map<string, string>();
    const entryId = (file: string): string => entryIds.get(file) ?? file;
    const edited = (previousFile: string, definition: AgentDefinition): void => {
        if (definition.file !== previousFile) {
            entryIds.set(definition.file, entryId(previousFile));
        }

        options.onEdit(previousFile, definition);
    };

    return {
        id: "agents",
        label: "Custom agents",
        description:
            "Edit agent definition files: your user agents at global scope, this project's agents " +
            "at project scope. Model, thinking, tools and isolation apply to the next run; names " +
            "and descriptions apply after /reload.",
        summary: ({ context, scope }) => {
            // An untrusted project's folder is not read; the panel refuses its scope anyway.
            if (scope === "project" && !context.isProjectTrusted()) {
                return "";
            }

            const { definitions, problems } = loadScope(context, scope);

            return [
                count(definitions.length, scope === "global" ? "user agent" : "project agent"),
                problems.length > 0 ? `${problems.length} not loaded` : "",
            ]
                .filter(Boolean)
                .join(" · ");
        },
        open: ({ context, scope, values }): SettingsMenu => {
            const loaded = loadScope(context, scope);

            return {
                fields: [
                    ...loaded.definitions.map((definition) =>
                        createSettingsMenuField({
                            id: entryId(definition.file),
                            label: definition.name,
                            description: definition.description,
                            scopes: [scope],
                            summary: () => agentSummary(definition),
                            menu: () => ({
                                fields: agentFields(
                                    definition,
                                    loaded,
                                    scope,
                                    options,
                                    edited,
                                    values,
                                ),
                            }),
                        }),
                    ),
                    ...loaded.problems.map((problem) =>
                        createSettingsMenuField({
                            id: `problem:${problem.file}`,
                            label: basename(problem.file),
                            description: problem.message,
                            scopes: [scope],
                            summary: () => "Not loaded",
                            disabled: () => "Fix the file by hand; it does not load.",
                            menu: () => ({ fields: [] }),
                        }),
                    ),
                ],
                emptyMessage:
                    `No ${scope === "global" ? "user" : "project"} agents in ` +
                    `${scopeDir(context, scope)}. The create-lune-subagent skill creates one.`,
            };
        },
    };
}

function scopeDir(context: ExtensionContext, scope: SettingsScope): string {
    return scope === "global" ? definitionsDir(getAgentDir()) : projectDefinitionsDir(context.cwd);
}

function loadScope(context: ExtensionContext, scope: SettingsScope): LoadedDefinitions {
    return loadDefinitions(scopeDir(context, scope), scope === "global" ? "user" : "project");
}

function agentSummary(definition: AgentDefinition): string {
    return [
        definition.model ?? "main model",
        definition.thinking ?? "main thinking",
        definition.tools ? count(definition.tools.length, "tool") : "default tools",
        definition.isolation ?? "shared",
    ].join(" · ");
}

function agentFields(
    definition: AgentDefinition,
    loaded: LoadedDefinitions,
    scope: SettingsScope,
    options: AgentsMenuOptions,
    edited: (previousFile: string, definition: AgentDefinition) => void,
    values: DeepReadonly<SubagentSettings>,
): SettingsPanelField[] {
    const field = <T>(spec: {
        id: DefinitionField;
        label: string;
        description: string;
        schema: SettingsPanelSchema;
        editor: "text" | "select" | "cycle";
        value: T | undefined;
        required?: boolean;
        choices?: readonly SettingsChoice<T | null>[];
        choiceSource?: SettingsChoiceSource;
        formatValue?: (value: T | null) => string;
    }): SettingsPanelField => {
        const write = (value: string | readonly string[] | undefined): Promise<void> => {
            try {
                edited(
                    definition.file,
                    editDefinitionFile(definition, spec.id, value, loaded.definitions),
                );

                return Promise.resolve();
            } catch (error) {
                return Promise.reject(error instanceof Error ? error : new Error(String(error)));
            }
        };
        const value = spec.value ?? null;

        return {
            id: spec.id,
            label: spec.label,
            description: spec.description,
            schema: spec.schema,
            editor: spec.editor,
            scopes: [scope],
            choices: spec.choices,
            choiceSource: spec.choiceSource,
            formatValue: spec.formatValue
                ? (shown) => spec.formatValue!(shown as T | null)
                : undefined,
            inspect: () => ({
                defaultValue: null,
                globalValue: scope === "global" && spec.value !== undefined ? value : undefined,
                projectValue: scope === "project" && spec.value !== undefined ? value : undefined,
                value,
                source: spec.value === undefined ? "default" : scope,
            }),
            // null is the "leave it out" choice of the optional fields.
            set: (next) => write(next === null ? undefined : (next as string | string[])),
            reset: () =>
                spec.required
                    ? Promise.reject(
                          new Error(`${spec.label} is required; enter a new value instead.`),
                      )
                    : write(undefined),
        };
    };
    const nullable = (schema: SettingsPanelSchema) =>
        Type.Union([Type.Null(), schema]) as SettingsPanelSchema;

    return [
        field({
            id: "name",
            label: "Name",
            description:
                "Letters, digits, '.', '_' and '-'. A file named after the agent is renamed with " +
                "it. The main agent sees the new name after /reload.",
            schema: Type.String({ minLength: 1 }),
            editor: "text",
            value: definition.name,
            required: true,
        }),
        field({
            id: "description",
            label: "Description",
            description:
                "When the main agent should choose this agent; one line in its subagents list. " +
                "Applies after /reload.",
            schema: Type.String({ minLength: 1 }),
            editor: "text",
            value: definition.description,
            required: true,
        }),
        field<string>({
            id: "model",
            label: "Model",
            description:
                "A model of the subagent allowed set, auto for the classifier's choice per task, or the " +
                "main agent's model. Ctrl+R removes the field.",
            schema: nullable(Type.String({ minLength: 1 })),
            editor: "select",
            value: definition.model,
            choiceSource: modelChoices(definition.model, values.allowedModels),
            formatValue: (value) => value ?? "Main agent's model",
        }),
        field<string>({
            id: "thinking",
            label: "Thinking",
            description:
                "Pi lowers a level that the run's model does not support. Ctrl+R removes the field.",
            schema: nullable(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
            editor: "select",
            value: definition.thinking,
            choices: [
                {
                    value: null,
                    label: "Main agent's thinking",
                    description: "Leave thinking out: runs use the main agent's level.",
                },
                ...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
            ],
            formatValue: (value) => value ?? "Main agent's thinking",
        }),
        field<string[]>({
            id: "tools",
            label: "Tools →",
            description:
                "Space toggles a tool. Unchecked everywhere means no task tools, only report. " +
                "Ctrl+R removes the field, so runs get the defaultTools setting. MCP tools are " +
                "not listed; keep them in the file by hand.",
            schema: Type.Array(Type.String({ minLength: 1 }), {
                uniqueItems: true,
            }) as SettingsPanelSchema,
            editor: "select",
            value: definition.tools,
            choiceSource: toolChoices(options, definition.tools),
            formatValue: (value) =>
                value === null
                    ? "Default tools"
                    : value.length === 0
                      ? "None · report only"
                      : `${value.length} selected`,
        }),
        field<string>({
            id: "isolation",
            label: "Isolation",
            description:
                "shared works in your directory; worktree gets its own Git worktree. Enter " +
                "cycles; Ctrl+R removes the field.",
            schema: nullable(Type.Union(ISOLATION_MODES.map((mode) => Type.Literal(mode)))),
            editor: "cycle",
            value: definition.isolation,
            choices: [
                { value: null, label: "Default · shared" },
                ...ISOLATION_MODES.map((mode) => ({ value: mode, label: mode })),
            ],
        }),
    ];
}

function modelChoices(
    current: string | undefined,
    selection: readonly ModelRef[],
): SettingsChoiceSource<string | null> {
    return {
        rowLayout: "inline",
        load: ({ context }) => {
            const models = allowedModels(context, selection);
            const refs = models.map((model) => formatModelRef(model));

            return [
                {
                    value: null,
                    label: "Main agent's model",
                    description: "Leave model out: runs use the main agent's model.",
                },
                {
                    value: AUTO_MODEL,
                    label: AUTO_MODEL,
                    description:
                        "The classifier in the Subagents settings chooses a model for each task.",
                },
                ...models.map((model) => ({
                    value: formatModelRef(model),
                    label: model.id,
                    badge: model.provider,
                    searchText: `${formatModelRef(model)} ${model.name}`,
                    description: model.name,
                })),
                ...(current !== undefined && current !== AUTO_MODEL && !refs.includes(current)
                    ? [
                          {
                              value: current,
                              label: current,
                              badge: "Not allowed",
                              description:
                                  "Not in the subagent allowed set now, so runs of this agent fail to start.",
                          },
                      ]
                    : []),
            ];
        },
    };
}

function toolChoices(
    options: AgentsMenuOptions,
    current: readonly string[] | undefined,
): SettingsChoiceSource<string> {
    return {
        multiple: true,
        rowLayout: "inline",
        load: () => {
            const catalog = options.catalog();

            if (!catalog) {
                throw new Error("The tool list loads with the session; try again in a moment.");
            }

            const tools = catalog.tools.filter((tool) => tool.name !== REPORT_TOOL_NAME);
            const known = new Set(tools.map((tool) => tool.name));

            return [
                ...tools.map((tool) => ({
                    value: tool.name,
                    label: tool.name,
                    badge: tool.source === "native" ? "Pi" : tool.source,
                    description: tool.description,
                })),
                ...(current ?? [])
                    .filter((name) => !known.has(name))
                    .map((name) => ({
                        value: name,
                        label: name,
                        badge: name.startsWith("mcp__") ? "MCP" : "Unavailable",
                        description: name.startsWith("mcp__")
                            ? "An MCP tool; its server connects in the run."
                            : "Not registered now. Runs of this agent fail to start until it is.",
                    })),
            ];
        },
    };
}

function count(value: number, noun: string): string {
    return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
