import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
    formatDefinitionProblems,
    loadDefinitions,
    parseDefinition,
    renderRoster,
} from "../../src/definitions.ts";
import { definitionsDir } from "../../src/paths.ts";
import { definition, tempAgentDir, writeDefinition } from "./support.ts";

const reviewer = `---
name: reviewer
description: Reviews a diff in a clean context and reports problems.
tools: read, grep, find, ls
model: anthropic/claude-sonnet-4-5
thinking: high
isolation: worktree
---

Review the diff named in the task.
`;

test("a definition file yields every frontmatter field and the body", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeDefinition(agentDir, "reviewer.md", reviewer);

    const { definitions, problems } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.deepEqual(problems, []);
    assert.deepEqual(definitions, [
        {
            name: "reviewer",
            description: "Reviews a diff in a clean context and reports problems.",
            tools: ["read", "grep", "find", "ls"],
            model: "anthropic/claude-sonnet-4-5",
            thinking: "high",
            isolation: "worktree",
            body: definitions[0]!.body,
            file,
            scope: "user",
        },
    ]);
    assert.equal(definitions[0]!.body.trim(), "Review the diff named in the task.");
});

test("optional fields stay unset and a frontmatter-only file has an empty body", (t) => {
    const agentDir = tempAgentDir(t);
    writeDefinition(agentDir, "min.md", "---\nname: min\ndescription: Minimal.\n---\n");

    const { definitions, problems } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.deepEqual(problems, []);
    const loaded = definitions[0]!;

    assert.equal(loaded.body.trim(), "");
    assert.equal(loaded.tools, undefined);
    assert.equal(loaded.model, undefined);
    assert.equal(loaded.thinking, undefined);
    assert.equal(loaded.isolation, undefined);
});

test("tools accept a YAML list and drop duplicates", (t) => {
    const agentDir = tempAgentDir(t);
    writeDefinition(
        agentDir,
        "list.md",
        "---\nname: list\ndescription: D.\ntools:\n  - read\n  - bash\n  - read\n---\n",
    );

    const { definitions } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.deepEqual(definitions[0]!.tools, ["read", "bash"]);
});

test("a folded multi-line description becomes one roster line", (t) => {
    const agentDir = tempAgentDir(t);
    writeDefinition(
        agentDir,
        "folded.md",
        "---\nname: folded\ndescription: >\n  First part\n  second part.\n---\n",
    );

    const { definitions } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.equal(definitions[0]!.description, "First part second part.");
});

test("a missing directory yields no definitions and no problems", (t) => {
    const agentDir = tempAgentDir(t);

    assert.deepEqual(loadDefinitions(definitionsDir(agentDir), "user"), {
        definitions: [],
        problems: [],
    });
});

const invalid: Array<[string, string, RegExp]> = [
    ["a missing name", "---\ndescription: D.\n---\n", /Missing required field "name"/],
    ["a missing description", "---\nname: a\n---\n", /Missing required field "description"/],
    ["a blank description", '---\nname: a\ndescription: "  "\n---\n', /non-empty string/],
    ["a misspelled field", "---\nname: a\ndescription: D.\ntool: read\n---\n", /Unknown.*tool/],
    ["an invalid name", "---\nname: bad name\ndescription: D.\n---\n", /Invalid name/],
    ["an inline run name", "---\nname: run-3\ndescription: D.\n---\n", /reserved for inline/],
    [
        "a tools change expression",
        "---\nname: a\ndescription: D.\ntools: +bash\n---\n",
        /exact tool names/,
    ],
    [
        "a model without a provider",
        "---\nname: a\ndescription: D.\nmodel: gpt\n---\n",
        /provider\/id/,
    ],
    [
        "an unknown thinking level",
        "---\nname: a\ndescription: D.\nthinking: extreme\n---\n",
        /must be one of/,
    ],
    [
        "an unknown isolation mode",
        "---\nname: a\ndescription: D.\nisolation: docker\n---\n",
        /must be one of/,
    ],
    ["no frontmatter at all", "Just text.\n", /Missing required field|frontmatter/],
];

for (const [label, content, message] of invalid) {
    test(`${label} is reported as a problem and the file is not loaded`, (t) => {
        const agentDir = tempAgentDir(t);
        const file = writeDefinition(agentDir, "bad.md", content);

        const { definitions, problems } = loadDefinitions(definitionsDir(agentDir), "user");

        assert.deepEqual(definitions, []);
        assert.equal(problems.length, 1);
        assert.equal(problems[0]!.file, file);
        assert.match(problems[0]!.message, message);
    });
}

test("a bad file does not stop the others from loading", (t) => {
    const agentDir = tempAgentDir(t);
    writeDefinition(agentDir, "bad.md", "---\nname: bad\n---\n");
    writeDefinition(agentDir, "good.md", "---\nname: good\ndescription: Fine.\n---\n");

    const { definitions, problems } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.deepEqual(
        definitions.map((item) => item.name),
        ["good"],
    );
    assert.equal(problems.length, 1);
});

test("a name used by two files loads neither and reports both", (t) => {
    const agentDir = tempAgentDir(t);
    const first = writeDefinition(agentDir, "a.md", "---\nname: same\ndescription: One.\n---\n");
    const second = writeDefinition(agentDir, "b.md", "---\nname: same\ndescription: Two.\n---\n");

    const { definitions, problems } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.deepEqual(definitions, []);
    assert.deepEqual(problems.map((problem) => problem.file).sort(), [first, second].sort());
    assert.match(problems[0]!.message, /also used by/);
});

test("only *.md files directly in the folder are read; sessions/ and worktrees/ are ignored", (t) => {
    const agentDir = tempAgentDir(t);
    const dir = definitionsDir(agentDir);

    writeDefinition(agentDir, "real.md", "---\nname: real\ndescription: Real.\n---\n");
    writeDefinition(agentDir, "notes.txt", "---\nname: txt\ndescription: Not markdown.\n---\n");

    // A run session and a worktree checkout may hold markdown that looks like a definition.
    for (const child of ["sessions/parent-1", "worktrees/parent-1/run-1"]) {
        mkdirSync(join(dir, child), { recursive: true });
        writeFileSync(
            join(dir, child, "inner.md"),
            "---\nname: inner\ndescription: Nested.\n---\n",
        );
    }

    mkdirSync(join(dir, "folder.md"));

    const { definitions, problems } = loadDefinitions(dir, "user");

    assert.deepEqual(problems, []);
    assert.deepEqual(
        definitions.map((item) => item.name),
        ["real"],
    );
});

test("definitions come back in name order regardless of file names", (t) => {
    const agentDir = tempAgentDir(t);
    writeDefinition(agentDir, "1.md", "---\nname: zebra\ndescription: Z.\n---\n");
    writeDefinition(agentDir, "2.md", "---\nname: alpha\ndescription: A.\n---\n");

    const { definitions } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.deepEqual(
        definitions.map((item) => item.name),
        ["alpha", "zebra"],
    );
});

test("the roster has one `- name: description` line per definition, or nothing", () => {
    const expected = "- alpha: The alpha agent.\n- beta: The beta agent.";

    const actual = renderRoster([definition("alpha"), definition("beta")]);

    assert.equal(actual, expected);
    assert.equal(renderRoster([]), undefined);
});

test("the roster marks project definitions and leaves user ones unmarked", () => {
    const expected = "- alpha: The alpha agent.\n- reviewer (project): Reviews diffs.";

    const actual = renderRoster([
        definition("alpha"),
        definition("reviewer", { scope: "project", description: "Reviews diffs." }),
    ]);

    assert.equal(actual, expected);
});

test("the problem report names the count and each file", () => {
    const text = formatDefinitionProblems([
        { file: "/a.md", message: "Bad." },
        { file: "/b.md", message: "Worse." },
    ]);

    assert.equal(text, "Subagent definitions not loaded (2):\n  /a.md: Bad.\n  /b.md: Worse.");
});

test("parseDefinition and loadDefinitions set the given scope on each definition", (t) => {
    const agentDir = tempAgentDir(t);
    writeDefinition(agentDir, "a.md", "---\nname: alpha\ndescription: A.\n---\n");

    const parsed = parseDefinition("---\nname: p\ndescription: P.\n---\n", "/p.md", "project");
    const loaded = loadDefinitions(definitionsDir(agentDir), "project");

    assert.equal(parsed.scope, "project");
    assert.deepEqual(
        loaded.definitions.map((item) => item.scope),
        ["project"],
    );
});

test("model: auto is a valid model and loads as the literal auto", (t) => {
    const agentDir = tempAgentDir(t);

    writeDefinition(
        agentDir,
        "auto.md",
        "---\nname: auto-agent\ndescription: D.\nmodel: auto\n---\n",
    );

    const { definitions, problems } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.deepEqual(problems, []);
    assert.equal(definitions[0]!.model, "auto");
});

test("a model that only starts with auto is still not a provider/id", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeDefinition(
        agentDir,
        "bad.md",
        "---\nname: a\ndescription: D.\nmodel: automatic\n---\n",
    );

    const { definitions, problems } = loadDefinitions(definitionsDir(agentDir), "user");

    assert.deepEqual(definitions, []);
    assert.equal(problems[0]!.file, file);
    assert.match(problems[0]!.message, /Invalid model "automatic": use provider\/id or auto/);
});
