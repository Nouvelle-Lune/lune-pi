import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runCli } from "../harness/cli.ts";
import { sandbox } from "../harness/cli.ts";
import {
    commitRun,
    createMemoryEnv,
    createRepo,
    makeItem,
    seedSession,
} from "../harness/memory.ts";
import type { MemoryEnv } from "../harness/memory.ts";

// Parsed CLI output has a different shape for each command.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(text: string): any {
    return JSON.parse(text);
}

describe("--home before the command name", () => {
    it("selects the home when it comes first, as in generated hook commands", async (t) => {
        const box = sandbox(t);
        const other = join(box.root, "other-home");

        const actual = await runCli(["--home", other, "status", "--json"], {
            env: box.env,
            cwd: box.root,
        });

        assert.equal(actual.code, 0);
        assert.equal(parse(actual.stdout).home, other);
    });

    it("accepts the --home=<dir> form", async (t) => {
        const box = sandbox(t);
        const other = join(box.root, "other-home");

        const actual = await runCli([`--home=${other}`, "status", "--json"], {
            env: box.env,
            cwd: box.root,
        });

        assert.equal(actual.code, 0);
        assert.equal(parse(actual.stdout).home, other);
    });

    it("resolves a relative --home against the working directory", async (t) => {
        const box = sandbox(t);

        const actual = await runCli(["--home", "rel-home", "status", "--json"], {
            env: box.env,
            cwd: box.root,
        });

        assert.equal(parse(actual.stdout).home, join(box.root, "rel-home"));
    });

    it("keeps working with --home after the command", async (t) => {
        const box = sandbox(t);
        const other = join(box.root, "other-home");

        const actual = await runCli(["status", "--home", other, "--json"], {
            env: box.env,
            cwd: box.root,
        });

        assert.equal(parse(actual.stdout).home, other);
    });

    const usageErrors: Array<[string, string[]]> = [
        ["no value at the end", ["--home"]],
        ["a flag instead of a value", ["--home", "--json", "status"]],
        ["an empty --home=", ["--home=", "status"]],
    ];
    for (const [name, argv] of usageErrors) {
        it(`exits 2 with ${name}`, async (t) => {
            const box = sandbox(t);

            const actual = await runCli(argv, { env: box.env, cwd: box.root });

            assert.equal(actual.code, 2);
            assert.match(actual.stderr, /--home needs a value/u);
        });
    }

    it("exits 2 with the usage text when only --home is given", async (t) => {
        const box = sandbox(t);

        const actual = await runCli(["--home", join(box.root, "x")], {
            env: box.env,
            cwd: box.root,
        });

        assert.equal(actual.code, 2);
        assert.match(actual.stderr, /Setup/u);
    });
});

describe("dream filters", () => {
    let env: MemoryEnv;

    beforeEach(async () => {
        env = await createMemoryEnv();
        env.store.run(
            "INSERT INTO projects(id, name, root, merged_into, created_at) VALUES ('p1', 'One', '/one', NULL, 'x')",
        );
        env.store.run(
            "INSERT INTO projects(id, name, root, merged_into, created_at) VALUES ('p2', 'Two', '/two', NULL, 'x')",
        );
        seedSession(env.store, { id: "a", projectId: "p1", events: [{ text: "text a" }] });
        seedSession(env.store, { id: "b", projectId: "p2", events: [{ text: "text b" }] });
        seedSession(env.store, { id: "c", projectId: null, events: [{ text: "text c" }] });
    });

    afterEach(() => {
        env.cleanup();
    });

    // No model is configured, so a pass only counts the sessions that its filters select.
    async function eligible(argv: string[]): Promise<number> {
        const actual = await runCli(["dream", "--json", ...argv]);
        assert.equal(actual.code, 0);
        return parse(actual.stdout).eligible;
    }

    it("selects every session, with and without a project, when no filter is given", async () => {
        assert.equal(await eligible([]), 3);
    });

    it("selects only the sessions outside any project for _unassigned", async () => {
        assert.equal(await eligible(["--project", "_unassigned"]), 1);
    });

    it("selects only the sessions of the named project", async () => {
        assert.equal(await eligible(["--project", "p1"]), 1);
    });

    it("selects only the labeled sessions", async () => {
        assert.equal(await eligible(["pi:a", "pi:c"]), 2);
    });

    it("combines the project filter and session labels", async () => {
        assert.equal(await eligible(["--project", "p1", "pi:b"]), 0);
        assert.equal(await eligible(["--project", "_unassigned", "pi:c"]), 1);
    });
});

describe("revert and forget warn on stderr when the views fail", () => {
    let env: MemoryEnv;
    let repo: string;
    let projectId: string;

    beforeEach(async () => {
        env = await createMemoryEnv();
        repo = createRepo(env.folder("app"));
        const resolution = env.service.resolver.resolve(repo);
        assert.ok(resolution);
        projectId = resolution.projectId;
        env.service.regenerate();
    });

    afterEach(() => {
        env.cleanup();
    });

    /** A file takes the place of the generations folder, so no view write can succeed. */
    function breakViews(): void {
        rmSync(env.service.paths.generations, { recursive: true, force: true });
        writeFileSync(env.service.paths.generations, "not a directory");
    }

    it("revert prints the result on stdout and the warning on stderr, with exit 0", async () => {
        const item = makeItem({ projectId, title: "Created" });
        const runId = commitRun(env.store, { projectId, changes: [{ before: null, after: item }] });
        breakViews();

        const actual = await runCli(["revert", String(runId)]);

        assert.equal(actual.code, 0);
        assert.match(actual.stdout, new RegExp(`^Reverted run ${runId} `, "u"));
        assert.match(actual.stderr, /^Warning: the Markdown views do not show this change yet \(/u);
        assert.doesNotMatch(actual.stdout, /Warning/u);
    });

    it("forget prints the result on stdout and the warning on stderr, with exit 0", async () => {
        env.writePiSession({ id: "sa", cwd: repo, messages: [{ role: "user", text: "Hello." }] });
        env.importNow();
        breakViews();

        const actual = await runCli(["forget", "pi:sa"]);

        assert.equal(actual.code, 0);
        assert.match(actual.stdout, /^Forgot pi:sa /u);
        assert.match(actual.stderr, /^Warning: the Markdown views do not show this change yet \(/u);
    });

    it("prints no warning when the views are written", async () => {
        const item = makeItem({ projectId, title: "Created" });
        const runId = commitRun(env.store, { projectId, changes: [{ before: null, after: item }] });

        const actual = await runCli(["revert", String(runId)]);

        assert.equal(actual.code, 0);
        assert.equal(actual.stderr, "");
    });

    it("status shows the views error and --json keeps it in viewsError", async () => {
        const note = env.service.noteWrite({ title: "A", body: "Body.", cwd: repo });
        assert.equal(note.projectionError, undefined);
        breakViews();
        env.service.noteWrite({ title: "B", body: "Body.", cwd: repo });

        const text = await runCli(["status"]);
        const data = await runCli(["status", "--json"]);

        assert.match(text.stdout, /^Views out of date: .+$/mu);
        assert.equal(typeof parse(data.stdout).viewsError, "string");
    });
});
