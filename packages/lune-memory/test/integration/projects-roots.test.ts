import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getProject, getSession } from "../../src/store/rows.ts";
import { createMemoryEnv, createRepo, git, type MemoryEnv } from "../harness/memory.ts";

let env: MemoryEnv;

beforeEach(async () => {
    env = await createMemoryEnv();
});

afterEach(() => {
    env.cleanup();
});

const REMOTE = "https://example.invalid/org/shared.git";

function commonDirOf(clone: string): string {
    return join(clone, ".git");
}

function rootOf(projectId: string): string | null | undefined {
    return getProject(env.store, projectId)?.root;
}

function projectOf(cwd: string): string {
    const resolution = env.service.resolver.resolve(cwd);
    assert.ok(resolution, `no project for ${cwd}`);
    return resolution.projectId;
}

describe("a changed session on a detached HEAD", () => {
    it("imports with no branch instead of the old branch of the session", () => {
        const repo = createRepo(env.folder("app"));
        const messages = [{ role: "user" as const, text: "first" }];
        env.writePiSession({ id: "s1", cwd: repo, messages });
        env.importNow();
        assert.equal(getSession(env.store, "pi", "s1")?.branch, "main");

        git(repo, "checkout", "--quiet", "--detach");
        env.writePiSession({
            id: "s1",
            cwd: repo,
            messages: [...messages, { role: "user", text: "second, after detaching" }],
        });
        env.importNow();

        assert.equal(getSession(env.store, "pi", "s1")?.branch, null);
    });
});

describe("the root of a project after a split", () => {
    it("moves the old root to a remaining clone when its git_common_dir is split away", () => {
        const cloneA = createRepo(env.folder("clone-a"), { remote: REMOTE });
        const cloneB = createRepo(env.folder("clone-b"), { remote: REMOTE });
        const shared = projectOf(cloneA);
        assert.equal(projectOf(cloneB), shared);
        assert.equal(rootOf(shared), cloneA);

        env.service.split("git_common_dir", commonDirOf(cloneA));

        assert.equal(rootOf(shared), cloneB);
    });

    it("moves the root to a remaining path when the root path is split away", () => {
        const base = env.folder("plain");
        const sub = env.folder("plain/sub");
        const project = env.service.resolver.register(base);
        env.store.run(
            "INSERT INTO project_locators(kind, value, project_id, created_at) VALUES ('path', ?, ?, '2026-01-01T00:00:00.000Z')",
            sub,
            project.id,
        );
        assert.equal(rootOf(project.id), base);

        env.service.split("path", base);

        assert.equal(rootOf(project.id), sub);
    });

    it("keeps the root when a remote is split away", () => {
        const clone = createRepo(env.folder("clone"), { remote: REMOTE });
        const shared = projectOf(clone);
        const remote = env.service
            .projects()
            .flatMap((p) => p.locators)
            .find((l) => l.kind === "remote");
        assert.ok(remote);

        env.service.split("remote", remote.value);

        assert.equal(rootOf(shared), clone);
    });

    it("gives a project with no root the repo root on the next resolve", () => {
        const clone = createRepo(env.folder("clone"), { remote: REMOTE });
        const shared = projectOf(clone);
        env.store.run("UPDATE projects SET root = NULL WHERE id = ?", shared);
        env.service.resolver.clearCache();

        projectOf(clone);

        assert.equal(rootOf(shared), clone);
    });
});
