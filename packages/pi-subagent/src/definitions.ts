import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { parseModelRef } from "./models.ts";
import { definitionsDir, projectDefinitionsDir } from "./paths.ts";
import { ISOLATION_MODES, THINKING_LEVELS, type Isolation } from "./run/types.ts";

/** `user`: Pi's agent directory. `project`: the project's `.pi` folder. */
export type DefinitionScope = "user" | "project";

export interface AgentDefinition {
    name: string;
    description: string;
    tools?: string[];
    /** `provider/id`. */
    model?: string;
    thinking?: ThinkingLevel;
    isolation?: Isolation;
    /** Appended to Pi's system prompt; empty when the file has only frontmatter. */
    body: string;
    file: string;
    scope: DefinitionScope;
}

export interface DefinitionProblem {
    file: string;
    message: string;
}

export interface LoadedDefinitions {
    /** In name order, the order of the roster and the `agent` enum. */
    definitions: AgentDefinition[];
    problems: DefinitionProblem[];
}

const FIELDS = new Set(["name", "description", "tools", "model", "thinking", "isolation"]);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INLINE_NAME_PATTERN = /^run-\d+$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * User definitions and, in a trusted project, the project's own. A project definition replaces a
 * user definition of the same name, and the replaced file is reported as not loaded.
 */
export function loadAllDefinitions(options: {
    agentDir: string;
    cwd: string;
    projectTrusted: boolean;
}): LoadedDefinitions {
    const userDir = definitionsDir(options.agentDir);
    const projectDir = projectDefinitionsDir(options.cwd);
    const user = loadDefinitions(userDir, "user");

    // An agent directory set to the project's `.pi` folder makes the two folders one.
    if (!options.projectTrusted || resolve(projectDir) === resolve(userDir)) {
        return user;
    }

    const project = loadDefinitions(projectDir, "project");
    const definitions = [...project.definitions];
    const problems = [...project.problems, ...user.problems];

    for (const definition of user.definitions) {
        const replacement = project.definitions.find(
            (candidate) => candidate.name === definition.name,
        );

        if (replacement) {
            problems.push({
                file: definition.file,
                message: `The project definition ${replacement.file} uses the name "${definition.name}" and replaces it.`,
            });
        } else {
            definitions.push(definition);
        }
    }

    definitions.sort(compareNames);

    return { definitions, problems };
}

/**
 * Read the `*.md` files directly in `dir`. A file that fails any check is skipped and reported,
 * so a typo such as `tool:` cannot silently start runs with the default tools instead.
 */
export function loadDefinitions(dir: string, scope: DefinitionScope): LoadedDefinitions {
    if (!existsSync(dir)) {
        return { definitions: [], problems: [] };
    }

    const problems: DefinitionProblem[] = [];
    const parsed: AgentDefinition[] = [];

    for (const entry of readdirSync(dir).sort()) {
        if (!entry.endsWith(".md")) {
            continue;
        }

        const file = join(dir, entry);

        try {
            if (!statSync(file).isFile()) {
                continue;
            }

            parsed.push(parseDefinition(readFileSync(file, "utf8"), file, scope));
        } catch (error) {
            problems.push({
                file,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const byName = new Map<string, AgentDefinition[]>();

    for (const definition of parsed) {
        byName.set(definition.name, [...(byName.get(definition.name) ?? []), definition]);
    }

    const definitions: AgentDefinition[] = [];

    for (const [name, group] of byName) {
        if (group.length === 1) {
            definitions.push(group[0]!);
            continue;
        }

        // No file wins: loading either one would depend on directory order.
        for (const definition of group) {
            problems.push({
                file: definition.file,
                message: `The name "${name}" is also used by ${group
                    .filter((other) => other !== definition)
                    .map((other) => other.file)
                    .join(", ")}.`,
            });
        }
    }

    definitions.sort(compareNames);

    return { definitions, problems };
}

export function parseDefinition(
    content: string,
    file: string,
    scope: DefinitionScope,
): AgentDefinition {
    let frontmatter: unknown;
    let body: string;

    try {
        ({ frontmatter, body } = parseFrontmatter(content));
    } catch (error) {
        throw new Error(
            `Invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }

    if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
        throw new Error("The frontmatter must be a YAML mapping.");
    }

    const fields = frontmatter as Record<string, unknown>;
    const unknown = Object.keys(fields).filter((key) => !FIELDS.has(key));

    if (unknown.length > 0) {
        throw new Error(
            `Unknown frontmatter field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. ` +
                `Allowed: ${[...FIELDS].join(", ")}.`,
        );
    }

    const name = requiredString(fields, "name");

    if (!NAME_PATTERN.test(name)) {
        throw new Error(
            `Invalid name "${name}": use letters, digits, ".", "_" and "-", at most 64 characters.`,
        );
    }

    if (INLINE_NAME_PATTERN.test(name)) {
        throw new Error(`The name "${name}" is reserved for inline runs.`);
    }

    const definition: AgentDefinition = {
        name,
        // The roster has one line per definition, so a folded YAML description must stay on one line.
        description: requiredString(fields, "description").replace(/\s+/g, " "),
        body,
        file,
        scope,
    };

    if (fields.tools !== undefined) {
        definition.tools = parseTools(fields.tools);
    }

    if (fields.model !== undefined) {
        const model = requiredString(fields, "model");

        if (!parseModelRef(model)) {
            throw new Error(`Invalid model "${model}": use provider/id.`);
        }

        definition.model = model;
    }

    if (fields.thinking !== undefined) {
        definition.thinking = oneOf(fields, "thinking", THINKING_LEVELS);
    }

    if (fields.isolation !== undefined) {
        definition.isolation = oneOf(fields, "isolation", ISOLATION_MODES);
    }

    return definition;
}

/**
 * The `subagents` system prompt section: one line per definition, in name order, with project
 * definitions marked.
 */
export function renderRoster(definitions: readonly AgentDefinition[]): string | undefined {
    if (definitions.length === 0) {
        return undefined;
    }

    return definitions
        .map(
            (definition) =>
                `- ${definition.name}${definition.scope === "project" ? " (project)" : ""}: ` +
                definition.description,
        )
        .join("\n");
}

export function formatDefinitionProblems(problems: readonly DefinitionProblem[]): string {
    return [
        `Subagent definitions not loaded (${problems.length}):`,
        ...problems.map((problem) => `  ${problem.file}: ${problem.message}`),
    ].join("\n");
}

function compareNames(a: AgentDefinition, b: AgentDefinition): number {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function requiredString(fields: Record<string, unknown>, key: string): string {
    const value = fields[key];

    if (value === undefined || value === null) {
        throw new Error(`Missing required field "${key}".`);
    }

    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`The field "${key}" must be a non-empty string.`);
    }

    return value.trim();
}

function oneOf<const T extends readonly string[]>(
    fields: Record<string, unknown>,
    key: string,
    values: T,
): T[number] {
    const value = fields[key];

    if (typeof value !== "string" || !values.includes(value)) {
        throw new Error(`The field "${key}" must be one of: ${values.join(", ")}.`);
    }

    return value as T[number];
}

/** `tools` takes a YAML list or a comma-separated string of exact names. */
function parseTools(value: unknown): string[] {
    let names: unknown[];

    if (typeof value === "string") {
        names = value
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== "");
    } else if (Array.isArray(value)) {
        names = value;
    } else {
        throw new Error('The field "tools" must be a list or a comma-separated string.');
    }

    const tools: string[] = [];

    for (const name of names) {
        if (typeof name !== "string" || name.trim() === "") {
            throw new Error('Every entry of "tools" must be a non-empty tool name.');
        }

        const trimmed = name.trim();

        if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
            throw new Error(
                `"tools" takes exact tool names, not +name or -name changes: ${trimmed}.`,
            );
        }

        if (!TOOL_NAME_PATTERN.test(trimmed)) {
            throw new Error(`Invalid tool name "${trimmed}".`);
        }

        if (!tools.includes(trimmed)) {
            tools.push(trimmed);
        }
    }

    return tools;
}
