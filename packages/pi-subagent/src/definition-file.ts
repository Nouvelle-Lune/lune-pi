import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { parseDocument } from "yaml";

import { parseDefinition, type AgentDefinition } from "./definitions.ts";

/** The frontmatter fields the settings panel edits; the body stays as written. */
export type DefinitionField = "name" | "description" | "model" | "thinking" | "tools" | "isolation";

/**
 * Set one frontmatter field of a definition file, or remove it with `undefined`, and return the
 * definition the file then holds. The new text must parse as a definition before it replaces the
 * file, and a file named after its agent is renamed with it. `siblings` are the other definitions
 * of the same folder, which a new name must not reuse.
 */
export function editDefinitionFile(
    definition: AgentDefinition,
    field: DefinitionField,
    value: string | readonly string[] | undefined,
    siblings: readonly AgentDefinition[],
): AgentDefinition {
    const content = setFrontmatterField(readFileSync(definition.file, "utf8"), field, value);
    const renamed =
        field === "name" &&
        typeof value === "string" &&
        value !== definition.name &&
        basename(definition.file) === `${definition.name}.md`;
    const file = renamed ? join(dirname(definition.file), `${value}.md`) : definition.file;
    const edited = parseDefinition(content, file, definition.scope);
    const clash = siblings.find(
        (other) => other.file !== definition.file && other.name === edited.name,
    );

    if (clash) {
        throw new Error(`The agent ${clash.file} already uses the name "${edited.name}".`);
    }

    if (renamed && existsSync(file)) {
        throw new Error(`The file ${file} already exists; rename or remove it first.`);
    }

    // A temporary file in the same folder makes the replacement one rename; it is not a `.md`
    // file, so the definition loader never reads it.
    const temporary = join(
        dirname(definition.file),
        `.${basename(file)}.${randomBytes(4).toString("hex")}.tmp`,
    );

    writeFileSync(temporary, content, { flag: "wx" });

    try {
        renameSync(temporary, file);
    } catch (error) {
        rmSync(temporary, { force: true });

        throw error;
    }

    if (renamed) {
        try {
            rmSync(definition.file);
        } catch (error) {
            throw new Error(
                `The agent was written to ${file}, but ${definition.file} could not be removed, ` +
                    `so both files now use the name "${edited.name}": ${message(error)}`,
                { cause: error },
            );
        }
    }

    return edited;
}

/** Edit the YAML document in place, so comments and the order of other fields stay. */
export function setFrontmatterField(
    content: string,
    field: DefinitionField,
    value: string | readonly string[] | undefined,
): string {
    // The same split as Pi's parseFrontmatter, which reads the file afterwards.
    const normalized = content
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    const end = normalized.startsWith("---") ? normalized.indexOf("\n---", 3) : -1;

    if (end === -1) {
        throw new Error("The file has no frontmatter.");
    }

    const document = parseDocument(normalized.slice(4, end));

    if (document.errors.length > 0) {
        throw new Error(`Invalid frontmatter: ${document.errors[0]!.message}`);
    }

    if (value === undefined) {
        document.delete(field);
    } else if (typeof value === "string") {
        document.set(field, value);
    } else {
        document.set(field, document.createNode([...value], { flow: true }));
    }

    return `---\n${document.toString({ flowCollectionPadding: false }).trimEnd()}${normalized.slice(end)}`;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
