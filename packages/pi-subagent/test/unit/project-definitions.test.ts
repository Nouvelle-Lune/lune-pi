import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { loadAllDefinitions } from "../../src/definitions.ts";
import { definitionsDir, projectDefinitionsDir } from "../../src/paths.ts";
import { tempAgentDir } from "./support.ts";

function tempCwd(t: TestContext): string {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-project-"));

    t.after(() => rmSync(cwd, { recursive: true, force: true }));

    return cwd;
}

function write(dir: string, fileName: string, name: string, description = `${name}.`): string {
    const file = join(dir, fileName);

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n`);

    return file;
}

test("projectDefinitionsDir is lune-subagents under the project's .pi folder", () => {
    assert.equal(projectDefinitionsDir("/work/app"), join("/work/app", ".pi", "lune-subagents"));
});

test("a trusted project adds its definitions as project scope beside the user's, in name order", (t) => {
    const agentDir = tempAgentDir(t);
    const cwd = tempCwd(t);
    write(definitionsDir(agentDir), "z.md", "zeta");
    write(projectDefinitionsDir(cwd), "b.md", "beta");

    const { definitions, problems } = loadAllDefinitions({
        agentDir,
        cwd,
        projectTrusted: true,
    });

    assert.deepEqual(problems, []);
    assert.deepEqual(
        definitions.map((item) => [item.name, item.scope]),
        [
            ["beta", "project"],
            ["zeta", "user"],
        ],
    );
});

test("an untrusted project is ignored even when its folder exists", (t) => {
    const agentDir = tempAgentDir(t);
    const cwd = tempCwd(t);
    write(definitionsDir(agentDir), "u.md", "user-one");
    write(projectDefinitionsDir(cwd), "p.md", "project-one");
    write(projectDefinitionsDir(cwd), "broken.md", "broken", "");

    const { definitions, problems } = loadAllDefinitions({
        agentDir,
        cwd,
        projectTrusted: false,
    });

    assert.deepEqual(problems, []);
    assert.deepEqual(
        definitions.map((item) => item.name),
        ["user-one"],
    );
});

test("a project definition replaces the user definition of the same name and reports it", (t) => {
    const agentDir = tempAgentDir(t);
    const cwd = tempCwd(t);
    const userFile = write(definitionsDir(agentDir), "r.md", "reviewer", "User version.");
    const projectFile = write(projectDefinitionsDir(cwd), "r.md", "reviewer", "Project version.");
    write(definitionsDir(agentDir), "o.md", "other");

    const { definitions, problems } = loadAllDefinitions({ agentDir, cwd, projectTrusted: true });

    assert.deepEqual(
        definitions.map((item) => [item.name, item.scope, item.description]),
        [
            ["other", "user", "other."],
            ["reviewer", "project", "Project version."],
        ],
    );
    assert.deepEqual(problems, [
        {
            file: userFile,
            message: `The project definition ${projectFile} uses the name "reviewer" and replaces it.`,
        },
    ]);
});

test("problems list project problems, then user problems, then replacements", (t) => {
    const agentDir = tempAgentDir(t);
    const cwd = tempCwd(t);
    const userBad = join(definitionsDir(agentDir), "bad.md");
    const projectBad = join(projectDefinitionsDir(cwd), "bad.md");
    write(definitionsDir(agentDir), "same.md", "same");
    const projectSame = write(projectDefinitionsDir(cwd), "same.md", "same");
    writeFileSync(userBad, "---\nname: bad-user\n---\n");
    writeFileSync(projectBad, "---\nname: bad-project\n---\n");

    const { problems } = loadAllDefinitions({ agentDir, cwd, projectTrusted: true });

    assert.deepEqual(
        problems.map((problem) => problem.file),
        [projectBad, userBad, join(definitionsDir(agentDir), "same.md")],
    );
    assert.equal(
        problems[2]!.message,
        `The project definition ${projectSame} uses the name "same" and replaces it.`,
    );
});

test("duplicate names inside the project folder are rejected and do not replace the user definition", (t) => {
    const agentDir = tempAgentDir(t);
    const cwd = tempCwd(t);
    write(definitionsDir(agentDir), "u.md", "twin", "From the user.");
    const first = write(projectDefinitionsDir(cwd), "a.md", "twin");
    const second = write(projectDefinitionsDir(cwd), "b.md", "twin");

    const { definitions, problems } = loadAllDefinitions({ agentDir, cwd, projectTrusted: true });

    assert.deepEqual(
        definitions.map((item) => [item.name, item.scope]),
        [["twin", "user"]],
    );
    assert.deepEqual(problems.map((problem) => problem.file).sort(), [first, second].sort());
});

test("an agent directory equal to the project's .pi folder loads that folder once as user", (t) => {
    const cwd = tempCwd(t);
    const agentDir = join(cwd, ".pi");
    write(definitionsDir(agentDir), "r.md", "reviewer");

    const { definitions, problems } = loadAllDefinitions({ agentDir, cwd, projectTrusted: true });

    assert.deepEqual(problems, []);
    assert.deepEqual(
        definitions.map((item) => [item.name, item.scope]),
        [["reviewer", "user"]],
    );
});
