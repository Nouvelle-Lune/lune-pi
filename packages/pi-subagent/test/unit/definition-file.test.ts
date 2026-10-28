import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { editDefinitionFile, setFrontmatterField } from "../../src/definition-file.ts";
import { loadDefinitions, parseDefinition, type AgentDefinition } from "../../src/definitions.ts";
import { definitionsDir } from "../../src/paths.ts";
import { tempAgentDir, writeDefinition } from "./support.ts";

const FILE = `---
name: reviewer
# keep this comment
description: Reviews diffs.
model: prov/big
---
You review.
`;

test("setting a field keeps comments, other keys and the body", () => {
    const actual = setFrontmatterField(FILE, "thinking", "high");

    assert.equal(
        actual,
        "---\nname: reviewer\n# keep this comment\ndescription: Reviews diffs.\nmodel: prov/big\nthinking: high\n---\nYou review.\n",
    );
});

test("setting an existing field replaces it where it stands", () => {
    const actual = setFrontmatterField(FILE, "model", "auto");

    assert.match(actual, /description: Reviews diffs\.\nmodel: auto\n---/);
});

test("undefined removes the key and leaves the rest as written", () => {
    const actual = setFrontmatterField(FILE, "model", undefined);

    assert.equal(
        actual,
        "---\nname: reviewer\n# keep this comment\ndescription: Reviews diffs.\n---\nYou review.\n",
    );
});

test("an array is written as a flow list", () => {
    const actual = setFrontmatterField(FILE, "tools", ["grep", "bash"]);

    assert.match(actual, /\ntools: \[grep, bash\]\n---/);
});

test("an empty array is written as an empty flow list", () => {
    const actual = setFrontmatterField(FILE, "tools", []);

    assert.match(actual, /\ntools: \[\]\n---/);
});

test("Windows line endings and a byte order mark are accepted and normalized", () => {
    const actual = setFrontmatterField(`\uFEFF${FILE.replace(/\n/g, "\r\n")}`, "thinking", "low");

    assert.equal(actual.includes("\r"), false);
    assert.match(actual, /^---\nname: reviewer\n/);
    assert.match(actual, /thinking: low/);
});

test("a file without frontmatter or with invalid YAML is refused", () => {
    assert.throws(() => setFrontmatterField("Just text.\n", "model", "a/b"), /no frontmatter/);
    assert.throws(
        () => setFrontmatterField("---\nname: [unclosed\n---\n", "model", "a/b"),
        /Invalid frontmatter/,
    );
});

function loaded(t: Parameters<typeof tempAgentDir>[0], files: Record<string, string>) {
    const agentDir = tempAgentDir(t);

    for (const [name, content] of Object.entries(files)) {
        writeDefinition(agentDir, name, content);
    }

    const dir = definitionsDir(agentDir);

    return { dir, definitions: loadDefinitions(dir, "user").definitions };
}

const byName = (definitions: AgentDefinition[], name: string) =>
    definitions.find((definition) => definition.name === name)!;

test("editing a field writes the file and returns the definition it now holds", (t) => {
    const { dir, definitions } = loaded(t, { "reviewer.md": FILE });
    const reviewer = byName(definitions, "reviewer");

    const actual = editDefinitionFile(reviewer, "model", "auto", definitions);

    assert.equal(actual.model, "auto");
    assert.equal(actual.file, reviewer.file);
    assert.match(readFileSync(reviewer.file, "utf8"), /# keep this comment/);
    assert.deepEqual(
        actual,
        parseDefinition(readFileSync(reviewer.file, "utf8"), reviewer.file, "user"),
    );
    assert.deepEqual(readdirSync(dir), ["reviewer.md"]);
});

test("an edit that makes the file invalid writes nothing", (t) => {
    const { dir, definitions } = loaded(t, { "reviewer.md": FILE });
    const reviewer = byName(definitions, "reviewer");

    assert.throws(() => editDefinitionFile(reviewer, "model", "gpt", definitions), /provider\/id/);
    assert.throws(() => editDefinitionFile(reviewer, "thinking", "extreme", definitions), /one of/);

    assert.equal(readFileSync(reviewer.file, "utf8"), FILE);
    assert.deepEqual(readdirSync(dir), ["reviewer.md"]);
});

test("a name that another definition uses is refused and nothing changes", (t) => {
    const { dir, definitions } = loaded(t, {
        "reviewer.md": FILE,
        "other.md": "---\nname: other\ndescription: Other.\n---\n",
    });
    const reviewer = byName(definitions, "reviewer");

    assert.throws(
        () => editDefinitionFile(reviewer, "name", "other", definitions),
        /already uses the name "other"/,
    );

    assert.equal(readFileSync(reviewer.file, "utf8"), FILE);
    assert.deepEqual(readdirSync(dir).sort(), ["other.md", "reviewer.md"]);
});

test("a file named after its agent is renamed with it", (t) => {
    const { dir, definitions } = loaded(t, { "reviewer.md": FILE });
    const reviewer = byName(definitions, "reviewer");

    const actual = editDefinitionFile(reviewer, "name", "code-reviewer", definitions);

    assert.equal(actual.name, "code-reviewer");
    assert.equal(actual.file, join(dir, "code-reviewer.md"));
    assert.deepEqual(readdirSync(dir), ["code-reviewer.md"]);
    assert.equal(existsSync(reviewer.file), false);
    assert.match(readFileSync(actual.file, "utf8"), /name: code-reviewer/);
});

test("a file with another name keeps its file name when the agent is renamed", (t) => {
    const { dir, definitions } = loaded(t, { "notes.md": FILE });
    const reviewer = byName(definitions, "reviewer");

    const actual = editDefinitionFile(reviewer, "name", "renamed", definitions);

    assert.equal(actual.file, join(dir, "notes.md"));
    assert.deepEqual(readdirSync(dir), ["notes.md"]);
});

test("a rename whose target file exists is refused and both files stay", (t) => {
    const { dir, definitions } = loaded(t, { "reviewer.md": FILE });
    const reviewer = byName(definitions, "reviewer");
    const target = join(dir, "taken.md");

    // Not a valid definition, so it is not among the siblings; only the file clash can refuse.
    writeFileSync(target, "not a definition\n");

    assert.throws(
        () => editDefinitionFile(reviewer, "name", "taken", definitions),
        /taken\.md already exists/,
    );

    assert.equal(readFileSync(reviewer.file, "utf8"), FILE);
    assert.equal(readFileSync(target, "utf8"), "not a definition\n");
    assert.deepEqual(readdirSync(dir).sort(), ["reviewer.md", "taken.md"]);
});

test("removing an optional field through undefined drops it from the definition", (t) => {
    const { definitions } = loaded(t, { "reviewer.md": FILE });
    const reviewer = byName(definitions, "reviewer");

    const actual = editDefinitionFile(reviewer, "model", undefined, definitions);

    assert.equal(actual.model, undefined);
});

test("editing a missing folder entry fails instead of creating a file", (t) => {
    const agentDir = tempAgentDir(t);
    const dir = definitionsDir(agentDir);

    mkdirSync(dir, { recursive: true });

    const ghost: AgentDefinition = {
        name: "ghost",
        description: "D.",
        body: "",
        file: join(dir, "ghost.md"),
        scope: "user",
    };

    assert.throws(() => editDefinitionFile(ghost, "model", "a/b", []), /ENOENT/);
    assert.deepEqual(readdirSync(dir), []);
});
