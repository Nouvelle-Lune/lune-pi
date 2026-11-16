import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { transcriptFile } from "../../src/core/paths.ts";
import { getSession, listProjects } from "../../src/store/rows.ts";
import { createMemoryEnv, createRepo, git, type MemoryEnv } from "../harness/memory.ts";

let env: MemoryEnv;

beforeEach(async () => {
    env = await createMemoryEnv();
});

afterEach(() => {
    env.cleanup();
});

function projectOf(cwd: string): string {
    const resolution = env.service.resolver.resolve(cwd);
    assert.ok(resolution, `no project for ${cwd}`);
    return resolution.projectId;
}

function session(id: string, cwd: string, text = `hello from ${id}`): string {
    return env.writePiSession({
        id,
        cwd,
        messages: [
            { role: "user", text },
            { role: "assistant", text: "Done." },
        ],
    });
}

describe("project resolver: one project per repository", () => {
    it("maps a repo and its worktree to one project and reports each branch", () => {
        const repo = createRepo(env.folder("app"));
        const worktree = join(env.root, "app-feature");
        git(repo, "worktree", "add", "--quiet", "-b", "feat/x", worktree);

        const main = env.service.resolver.resolve(repo);
        const feature = env.service.resolver.resolve(worktree);

        assert.ok(main && feature);
        assert.equal(feature.projectId, main.projectId);
        assert.equal(main.branch, "main");
        assert.equal(feature.branch, "feat/x");
        assert.equal(listProjects(env.store).length, 1);
    });

    it("maps two clones with the same remote to one project, whatever the URL form", () => {
        const first = createRepo(env.folder("clone-a"), { remote: "git@GitHub.com:Org/Repo.git" });
        const second = createRepo(env.folder("clone-b"), { remote: "https://github.com/Org/Repo" });

        assert.equal(projectOf(first), projectOf(second));
        assert.equal(listProjects(env.store).length, 1);
    });

    it("gives unrelated repos and local-path remotes separate projects", () => {
        const first = createRepo(env.folder("one"), { remote: "/srv/git/shared.git" });
        const second = createRepo(env.folder("two"), { remote: "/srv/git/shared.git" });

        assert.notEqual(projectOf(first), projectOf(second));
    });

    it("resolves a subfolder and a deleted cwd inside a repo to the repo project", () => {
        const repo = createRepo(env.folder("app"));
        const expected = projectOf(repo);

        assert.equal(projectOf(join(repo, "gone", "deeper")), expected);
    });

    it("gives no project to a folder outside any repo until it is registered", () => {
        const plain = env.folder("plain");
        const nested = join(plain, "sub");
        env.folder("plain/sub");

        assert.equal(env.service.resolver.resolve(plain), null);

        const project = env.service.register(plain);
        const actual = env.service.resolver.resolve(nested);

        assert.equal(actual?.projectId, project.id);
        assert.equal(actual?.branch, null);
        assert.equal(project.root, plain);
        assert.equal(project.name, "plain");
    });
});

describe("project resolver: register and rename", () => {
    it("registers a repo folder as the project of that repo and applies the name", () => {
        const repo = createRepo(env.folder("app"));
        const seen = projectOf(repo);

        const project = env.service.register(repo, "  My App  ");

        assert.equal(project.id, seen);
        assert.equal(project.name, "My App");
    });

    it("rejects a folder that does not exist", () => {
        assert.throws(() => env.service.register(join(env.root, "missing")), /Folder not found/u);
    });

    it("renames a project and rejects an unknown id", () => {
        const project = env.service.register(env.folder("plain"));

        const renamed = env.service.rename(project.id, "Renamed");

        assert.equal(renamed.name, "Renamed");
        assert.throws(() => env.service.rename("p-unknown", "x"), /Unknown project/u);
    });

    it("moves sessions of a registered folder and their transcript on the next import", () => {
        const plain = env.folder("plain");
        const path = session("s-plain", plain);
        env.importNow();
        const before = getSession(env.store, "pi", "s-plain");
        assert.equal(before?.projectId, null);
        const unassigned = transcriptFile(env.service.paths, null, "pi", "s-plain");
        assert.equal(before?.transcriptPath, unassigned);
        assert.ok(existsSync(unassigned));

        const project = env.service.register(plain);
        // The session file changes, so the import reads it again.
        session("s-plain", plain, "a changed message");
        env.importNow();

        const after = getSession(env.store, "pi", "s-plain");
        const expected = transcriptFile(env.service.paths, project.id, "pi", "s-plain");
        assert.equal(after?.projectId, project.id);
        assert.equal(after?.transcriptPath, expected);
        assert.ok(existsSync(expected));
        assert.ok(!existsSync(unassigned));
        assert.ok(existsSync(path));
    });

    it("moves already imported sessions of a registered folder at once, without a new import", () => {
        const plain = env.folder("plain");
        const sibling = env.folder("plain-sibling");
        session("s-plain", plain);
        session("s-sibling", sibling);
        env.importNow();
        // Pretend Dreaming has processed both sessions.
        env.store.run("UPDATE sessions SET processed_revision = revision");
        env.store.run("UPDATE events SET processed_hash = hash");
        const unassigned = transcriptFile(env.service.paths, null, "pi", "s-plain");
        assert.ok(existsSync(unassigned));

        const project = env.service.register(plain);

        const moved = getSession(env.store, "pi", "s-plain");
        const expected = transcriptFile(env.service.paths, project.id, "pi", "s-plain");
        assert.equal(moved?.projectId, project.id);
        assert.equal(moved?.processedRevision, null);
        assert.equal(moved?.transcriptPath, expected);
        assert.ok(existsSync(expected));
        assert.ok(!existsSync(unassigned));
        const processedEvents = env.store.get(
            "SELECT COUNT(*) AS n FROM events WHERE session_id = 's-plain' AND processed_hash IS NOT NULL",
        );
        assert.equal(processedEvents?.n, 0);

        // A folder next to the registered one is not inside it and stays unassigned.
        const other = getSession(env.store, "pi", "s-sibling");
        assert.equal(other?.projectId, null);
        assert.equal(other?.processedRevision, other?.revision);
        assert.equal(
            other?.transcriptPath,
            transcriptFile(env.service.paths, null, "pi", "s-sibling"),
        );
        assert.ok(existsSync(other.transcriptPath));
    });
});

describe("project resolver: merge", () => {
    it("moves locators, sessions and transcripts to the target and hides the source", () => {
        const repoA = createRepo(env.folder("a"));
        const repoB = createRepo(env.folder("b"));
        session("s-a", repoA);
        session("s-b", repoB);
        env.importNow();
        const idA = projectOf(repoA);
        const idB = projectOf(repoB);
        const oldTranscript = transcriptFile(env.service.paths, idA, "pi", "s-a");
        assert.ok(existsSync(oldTranscript));

        const result = env.service.merge(idA, idB);

        assert.deepEqual(result, { source: idA, target: idB });
        assert.equal(getSession(env.store, "pi", "s-a")?.projectId, idB);
        assert.equal(projectOf(repoA), idB);
        const moved = transcriptFile(env.service.paths, idB, "pi", "s-a");
        assert.ok(existsSync(moved));
        assert.ok(!existsSync(oldTranscript));
        assert.equal(getSession(env.store, "pi", "s-a")?.transcriptPath, moved);

        const live = env.service.projects().map((project) => project.id);
        const all = env.service.projects(true);
        assert.deepEqual(live, [idB]);
        assert.equal(all.find((project) => project.id === idA)?.mergedInto, idB);
        const kinds = env.service.projects().flatMap((project) => project.locators);
        assert.equal(kinds.filter((locator) => locator.kind === "git_common_dir").length, 2);
    });

    it("rejects merging a project into itself and unknown projects", () => {
        const id = projectOf(createRepo(env.folder("a")));

        assert.throws(() => env.service.merge(id, id), /same project/u);
        assert.throws(() => env.service.merge(id, "p-unknown"), /Unknown project/u);
    });
});

describe("project resolver: split", () => {
    it("moves the sessions of one clone, marks them unprocessed and relocates transcripts", () => {
        const remote = "https://example.invalid/org/repo.git";
        const cloneA = createRepo(env.folder("clone-a"), { remote });
        const cloneB = createRepo(env.folder("clone-b"), { remote });
        session("s-a", cloneA);
        session("s-b", cloneB);
        env.importNow();
        const shared = projectOf(cloneA);
        assert.equal(projectOf(cloneB), shared);
        // Pretend Dreaming has processed both sessions.
        env.store.run("UPDATE sessions SET processed_revision = revision");
        env.store.run("UPDATE events SET processed_hash = hash");
        const commonDir = env.service
            .projects()
            .flatMap((project) => project.locators)
            .find(
                (locator) => locator.kind === "git_common_dir" && locator.value.includes("clone-a"),
            );
        assert.ok(commonDir);

        const result = env.service.split("git_common_dir", commonDir.value, "Clone A");

        assert.equal(result.moved, 1);
        assert.equal(result.project.name, "Clone A");
        assert.notEqual(result.project.id, shared);
        const moved = getSession(env.store, "pi", "s-a");
        const stayed = getSession(env.store, "pi", "s-b");
        assert.equal(moved?.projectId, result.project.id);
        assert.equal(moved?.processedRevision, null);
        assert.equal(stayed?.projectId, shared);
        assert.equal(stayed?.processedRevision, stayed?.revision);
        const unprocessedEvents = env.store.get(
            "SELECT COUNT(*) AS n FROM events WHERE session_id = 's-a' AND processed_hash IS NOT NULL",
        );
        assert.equal(unprocessedEvents?.n, 0);
        const expected = transcriptFile(env.service.paths, result.project.id, "pi", "s-a");
        assert.equal(moved?.transcriptPath, expected);
        assert.ok(existsSync(expected));
        assert.ok(!existsSync(transcriptFile(env.service.paths, shared, "pi", "s-a")));
    });

    it("rejects an unknown locator and the only locator of a project", () => {
        const repo = createRepo(env.folder("solo"));
        const id = projectOf(repo);
        const [only] = env.service.resolver.locators(id);
        assert.ok(only);

        assert.throws(() => env.service.split("remote", "nope"), /Unknown locator/u);
        assert.throws(() => env.service.split(only.kind, only.value), /only locator/u);
    });

    it("brings a merged-away project back when its locator is split off again", () => {
        const repo = createRepo(env.folder("app"), { remote: "https://example.invalid/o/r.git" });
        const original = projectOf(repo);
        const first = env.service.split("remote", "example.invalid/o/r");
        assert.equal(first.project.mergedInto, null);

        env.service.merge(first.project.id, original);
        const merged = env.service.projects(true).find((p) => p.id === first.project.id);
        assert.equal(merged?.mergedInto, original);

        const again = env.service.split("remote", "example.invalid/o/r");

        assert.equal(again.project.id, first.project.id);
        assert.equal(again.project.mergedInto, null);
        assert.ok(env.service.projects().some((project) => project.id === first.project.id));
    });

    it("revives a merged-away repo project with its original id and name when its git dir is split off", () => {
        const repoA = createRepo(env.folder("alpha"));
        const repoB = createRepo(env.folder("beta"));
        const idA = projectOf(repoA);
        const idB = projectOf(repoB);
        env.service.merge(idA, idB);
        const commonDir = env.service.resolver
            .locators(idB)
            .find(
                (locator) => locator.kind === "git_common_dir" && locator.value.includes("alpha"),
            );
        assert.ok(commonDir);

        const result = env.service.split("git_common_dir", commonDir.value);

        assert.equal(result.project.id, idA);
        assert.equal(result.project.name, "alpha");
        assert.equal(result.project.mergedInto, null);
    });

    it("keeps the renamed name of a revived project and lets an explicit name win", () => {
        const repoA = createRepo(env.folder("alpha"));
        const repoB = createRepo(env.folder("beta"));
        const idA = projectOf(repoA);
        const idB = projectOf(repoB);
        env.service.rename(idA, "Renamed A");
        env.service.merge(idA, idB);
        const commonDir = env.service.resolver
            .locators(idB)
            .find(
                (locator) => locator.kind === "git_common_dir" && locator.value.includes("alpha"),
            );
        assert.ok(commonDir);

        const revived = env.service.split("git_common_dir", commonDir.value);
        assert.equal(revived.project.id, idA);
        assert.equal(revived.project.name, "Renamed A");
        assert.equal(revived.project.mergedInto, null);

        env.service.merge(idA, idB);
        const named = env.service.split("git_common_dir", commonDir.value, "Chosen");
        assert.equal(named.project.id, idA);
        assert.equal(named.project.name, "Chosen");
        assert.equal(named.project.mergedInto, null);
    });

    it("gives a remote locator that never made a project a new id", () => {
        const repo = createRepo(env.folder("app"), { remote: "https://example.invalid/o/r.git" });
        const original = projectOf(repo);
        const before = env.service.projects(true).map((project) => project.id);

        const result = env.service.split("remote", "example.invalid/o/r");

        assert.notEqual(result.project.id, original);
        assert.ok(!before.includes(result.project.id));
    });

    it("splitting the locator that made the project leaves the old project in place", () => {
        const remote = "https://example.invalid/org/repo.git";
        const cloneA = createRepo(env.folder("clone-a"), { remote });
        const cloneB = createRepo(env.folder("clone-b"), { remote });
        const shared = projectOf(cloneA);
        assert.equal(projectOf(cloneB), shared);
        const locators = env.service.resolver.locators(shared);
        const commonA = locators.find(
            (l) => l.kind === "git_common_dir" && l.value.includes("clone-a"),
        );
        const commonB = locators.find(
            (l) => l.kind === "git_common_dir" && l.value.includes("clone-b"),
        );
        assert.ok(commonA && commonB);

        const result = env.service.split("git_common_dir", commonA.value);

        assert.notEqual(result.project.id, shared);
        const old = env.service.projects().find((project) => project.id === shared);
        assert.equal(old?.mergedInto, null);
        const oldLocators = env.service.resolver.locators(shared);
        assert.ok(
            oldLocators.some((l) => l.kind === "git_common_dir" && l.value === commonB.value),
        );
        assert.ok(oldLocators.some((l) => l.kind === "remote"));
        assert.ok(!oldLocators.some((l) => l.value === commonA.value));
        assert.deepEqual(env.service.resolver.locators(result.project.id), [
            { kind: "git_common_dir", value: commonA.value },
        ]);
    });

    describe("when an earlier split moved the founding locator away", () => {
        const remote = "https://example.invalid/org/repo.git";

        function sharedClones(): { shared: string; commonA: string; commonB: string } {
            const cloneA = createRepo(env.folder("clone-a"), { remote });
            const cloneB = createRepo(env.folder("clone-b"), { remote });
            const shared = projectOf(cloneA);
            assert.equal(projectOf(cloneB), shared);
            const locators = env.service.resolver.locators(shared);
            const commonA = locators.find(
                (l) => l.kind === "git_common_dir" && l.value.includes("clone-a"),
            );
            const commonB = locators.find(
                (l) => l.kind === "git_common_dir" && l.value.includes("clone-b"),
            );
            assert.ok(commonA && commonB);
            return { shared, commonA: commonA.value, commonB: commonB.value };
        }

        it("revives the first split project instead of re-entering the live founding project", () => {
            const { shared, commonA, commonB } = sharedClones();
            const other = projectOf(createRepo(env.folder("other")));
            session("s-a", join(env.folder("clone-a")));
            env.importNow();
            const sharedName = env.service.projects().find((p) => p.id === shared)?.name;
            const first = env.service.split("git_common_dir", commonA);
            env.service.merge(first.project.id, other);

            const again = env.service.split("git_common_dir", commonA);

            const expectedId = first.project.id;
            assert.notEqual(again.project.id, shared);
            assert.equal(again.project.id, expectedId);
            assert.equal(again.project.mergedInto, null);
            const sharedProject = env.service.projects().find((p) => p.id === shared);
            assert.equal(sharedProject?.name, sharedName);
            const sharedLocators = env.service.resolver.locators(shared);
            assert.ok(sharedLocators.some((l) => l.value === commonB));
            assert.ok(sharedLocators.some((l) => l.kind === "remote"));
            assert.ok(!sharedLocators.some((l) => l.value === commonA));
            assert.ok(
                env.service.resolver
                    .locators(expectedId)
                    .some((l) => l.kind === "git_common_dir" && l.value === commonA),
            );
            assert.equal(getSession(env.store, "pi", "s-a")?.projectId, expectedId);
        });

        it("names only the revived target when a name is given", () => {
            const { shared, commonA } = sharedClones();
            const other = projectOf(createRepo(env.folder("other")));
            const sharedName = env.service.projects().find((p) => p.id === shared)?.name;
            const first = env.service.split("git_common_dir", commonA);
            env.service.merge(first.project.id, other);

            const again = env.service.split("git_common_dir", commonA, "Clone A");

            assert.equal(again.project.id, first.project.id);
            assert.equal(again.project.name, "Clone A");
            const sharedProject = env.service.projects().find((p) => p.id === shared);
            assert.equal(sharedProject?.name, sharedName);
        });

        it("creates a third project when the founding and first split projects are both live", () => {
            const { shared, commonA, commonB } = sharedClones();
            const first = env.service.split("git_common_dir", commonA);
            const tId = projectOf(createRepo(env.folder("tee")));
            const tLocators = env.service.resolver.locators(tId);
            assert.ok(tLocators.length > 0);
            env.service.merge(tId, first.project.id);
            assert.deepEqual(
                env.service.resolver.locators(first.project.id).length,
                1 + tLocators.length,
            );

            const again = env.service.split("git_common_dir", commonA);

            assert.notEqual(again.project.id, shared);
            assert.notEqual(again.project.id, first.project.id);
            const live = env.service.projects().map((p) => p.id);
            assert.ok(live.includes(shared));
            assert.ok(live.includes(first.project.id));
            assert.ok(live.includes(again.project.id));
            const keptByFirst = env.service.resolver.locators(first.project.id);
            for (const locator of tLocators) {
                assert.ok(
                    keptByFirst.some((l) => l.kind === locator.kind && l.value === locator.value),
                );
            }
            assert.ok(!keptByFirst.some((l) => l.value === commonA));
            assert.ok(env.service.resolver.locators(shared).some((l) => l.value === commonB));
        });
    });

    describe("when two path locators differ only by a numeric suffix", () => {
        it("does not revive the project another locator split off", () => {
            const register = (name: string): string => env.service.register(env.folder(name)).id;
            const x = env.folder("x");
            const x2 = env.folder("x:2");
            const ownX = register("x");
            const own2 = register("x:2");
            const y = register("y");
            const z = register("z");
            const w = register("w");
            const v = register("v");
            // "/x:2" splits into its own project, which is then merged away.
            env.service.merge(y, own2);
            const split2 = env.service.split("path", x2).project.id;
            env.service.merge(split2, w);
            // "/x" has both its own project and its first split project live,
            // so the next split has to reach the second salted candidate.
            env.service.merge(z, ownX);
            const firstX = env.service.split("path", x).project.id;
            env.service.merge(v, firstX);

            const again = env.service.split("path", x);

            assert.notEqual(again.project.id, split2);
            assert.notEqual(again.project.id, ownX);
            assert.notEqual(again.project.id, firstX);
            const expectedRoot = x;
            const actualRoot = again.project.root;
            assert.equal(actualRoot, expectedRoot);
            assert.equal(again.project.mergedInto, null);
            const revived = env.service.projects().find((p) => p.id === split2);
            assert.equal(revived, undefined);
            assert.ok(
                env.service.resolver
                    .locators(again.project.id)
                    .some((l) => l.kind === "path" && l.value === x),
            );
        });
    });
});
