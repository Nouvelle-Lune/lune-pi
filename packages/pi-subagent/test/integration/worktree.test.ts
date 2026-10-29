import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { RUN_ENTRY_TYPE } from "../../src/run/types.ts";
import {
    createFixture,
    definition,
    liveSessionOf,
    reportResponse,
    waitForTurns,
} from "../harness/fixture.ts";
import { createRepo, git } from "../harness/git.ts";

function listWorktrees(repo: string): string {
    return git(repo, "worktree", "list", "--porcelain");
}

function listDir(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir) : [];
}

async function repoFixture(t: Parameters<typeof createFixture>[0]) {
    const fx = await createFixture(t);
    const repo = join(fx.root, "repo");
    const head = createRepo(repo, { "a.txt": "committed\n", "sub/b.txt": "sub file\n" });

    return { fx, repo, head };
}

test("a worktree run gets a detached checkout of HEAD without the parent's uncommitted changes", async (t) => {
    const { fx, repo, head } = await repoFixture(t);
    const manager = fx.createManager();

    writeFileSync(join(repo, "a.txt"), "edited but uncommitted\n");
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    fx.faux.setResponses([reportResponse("done", "ok")]);

    const parentCtx = Object.create(fx.ctx, { cwd: { value: repo } });
    const run = await manager.start({ task: "work", isolation: "worktree" }, parentCtx);
    await waitForTurns(manager, run, 1);

    const expectedPath = join(
        fx.agentDir,
        "lune-subagents",
        "worktrees",
        fx.parent.getSessionId(),
        run.id,
    );
    const snapshot = run.snapshot!;

    assert.equal(snapshot.isolation, "worktree");
    assert.equal(snapshot.worktree?.path, expectedPath);
    assert.equal(snapshot.worktree?.baseCommit, head);
    assert.equal(snapshot.worktree?.repoRoot, repo);
    assert.equal(snapshot.cwd, expectedPath);
    assert.equal(liveSessionOf(run).session.sessionManager.getCwd(), expectedPath);
    assert.equal(git(expectedPath, "rev-parse", "HEAD"), head);
    // A detached HEAD: no named branch was created for the run.
    assert.equal(git(expectedPath, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal(git(expectedPath, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(expectedPath, "a.txt"), "utf8"), "committed\n");
    assert.ok(!existsSync(join(expectedPath, "untracked.txt")));
    // The parent's own files stay as they were.
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "edited but uncommitted\n");
    assert.equal(git(repo, "branch", "--list").replace(/^\*\s*/, ""), "main");
});

test("a parent working in a subdirectory gets the matching subdirectory of the worktree", async (t) => {
    const { fx, repo } = await repoFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "ok")]);

    const parentCtx = Object.create(fx.ctx, { cwd: { value: join(repo, "sub") } });
    const run = await manager.start({ task: "work", isolation: "worktree" }, parentCtx);
    await waitForTurns(manager, run, 1);

    assert.equal(run.snapshot!.cwd, join(run.snapshot!.worktree!.path, "sub"));
    assert.equal(readFileSync(join(run.snapshot!.cwd, "b.txt"), "utf8"), "sub file\n");
});

test("isolation: an inline call's isolation beats the shared default; a definition's isolation applies to its agent", async (t) => {
    const { fx, repo } = await repoFixture(t);
    const manager = fx.createManager([
        definition({ name: "isolated", isolation: "worktree" }),
        definition({ name: "plain", isolation: "shared" }),
    ]);
    const parentCtx = Object.create(fx.ctx, { cwd: { value: repo } });

    fx.faux.setResponses([
        reportResponse("done", "ok"),
        reportResponse("done", "ok"),
        reportResponse("done", "ok"),
        reportResponse("done", "ok"),
    ]);
    const fromDefinition = await manager.start({ task: "a", agent: "isolated" }, parentCtx);
    const sharedByDefinition = await manager.start({ task: "b", agent: "plain" }, parentCtx);
    const inlineWorktree = await manager.start({ task: "c", isolation: "worktree" }, parentCtx);
    const byDefault = await manager.start({ task: "d" }, parentCtx);

    assert.deepEqual(
        [fromDefinition, sharedByDefinition, inlineWorktree, byDefault].map((run) => [
            run.snapshot?.isolation,
            run.snapshot?.sources.isolation,
        ]),
        [
            ["worktree", "definition"],
            ["shared", "definition"],
            ["worktree", "call"],
            ["shared", "default"],
        ],
    );
    assert.equal(sharedByDefinition.snapshot?.cwd, repo);
    assert.equal(sharedByDefinition.snapshot?.worktree, undefined);
    assert.equal(byDefault.snapshot?.worktree, undefined);
    assert.notEqual(
        fromDefinition.snapshot?.worktree?.path,
        inlineWorktree.snapshot?.worktree?.path,
    );
});

test("isolation: an agent with an isolation in the call is rejected and creates no worktree", async (t) => {
    const { fx, repo } = await repoFixture(t);
    const manager = fx.createManager([definition({ name: "plain", isolation: "shared" })]);
    const parentCtx = Object.create(fx.ctx, { cwd: { value: repo } });
    const before = listWorktrees(repo);

    await assert.rejects(
        manager.start({ task: "c", agent: "plain", isolation: "worktree" }, parentCtx),
        /leave out isolation\./,
    );

    assert.equal(manager.branchRuns().length, 0);
    assert.deepEqual(listWorktrees(repo), before);
});

test("without a Git repository, a worktree start fails and creates nothing; it never falls back to shared", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    await assert.rejects(
        manager.start({ task: "work", isolation: "worktree" }, fx.ctx),
        /needs a Git repository/,
    );

    assert.equal(manager.branchRuns().length, 0);
    assert.deepEqual(listDir(join(fx.agentDir, "lune-subagents", "worktrees")), []);
    assert.deepEqual(
        listDir(join(fx.agentDir, "lune-subagents", "sessions", fx.parent.getSessionId())),
        [],
    );
    assert.ok(!fx.parent.getEntries().some((entry) => entry.type === "custom"));
});

test("a start that fails after the worktree exists removes the worktree, the run file and its Git record", async (t) => {
    const { fx, repo } = await repoFixture(t);
    const manager = fx.createManager();
    const parentCtx = Object.create(fx.ctx, { cwd: { value: repo } });

    await assert.rejects(
        manager.start({ task: "work", isolation: "worktree", tools: ["no_such_tool"] }, parentCtx),
        /Not available in a run: no_such_tool/,
    );

    const worktrees = join(fx.agentDir, "lune-subagents", "worktrees", fx.parent.getSessionId());
    const listed = git(repo, "worktree", "list", "--porcelain");

    assert.equal(manager.branchRuns().length, 0);
    assert.deepEqual(
        listed.split("\n").filter((line) => line.startsWith("worktree ")),
        [`worktree ${repo}`],
    );
    assert.deepEqual(listDir(worktrees), []);
    assert.deepEqual(
        listDir(join(fx.agentDir, "lune-subagents", "sessions", fx.parent.getSessionId())),
        [],
    );
    assert.ok(
        !fx.parent
            .getEntries()
            .some((entry) => entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE),
    );
});

test("a worktree and its changes stay after stop and shutdown, and a continued run uses the same checkout", async (t) => {
    const { fx, repo } = await repoFixture(t);
    const first = fx.createManager();
    const parentCtx = Object.create(fx.ctx, { cwd: { value: repo } });

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await first.start({ task: "work", isolation: "worktree" }, parentCtx);
    await waitForTurns(first, run, 1);

    const path = run.snapshot!.worktree!.path;

    writeFileSync(join(path, "result.txt"), "work product\n");
    await first.shutdown();

    assert.equal(readFileSync(join(path, "result.txt"), "utf8"), "work product\n");

    const second = fx.createManager();

    second.restore();

    const restored = second.branchRun(run.id);

    fx.faux.setResponses([reportResponse("done", "again")]);
    await second.send(restored, "continue", "main-agent");
    await waitForTurns(second, restored, 2);

    assert.equal(liveSessionOf(restored).session.sessionManager.getCwd(), path);
});

test("continuing a run whose worktree is missing fails explicitly and recreates nothing", async (t) => {
    const { fx, repo } = await repoFixture(t);
    const first = fx.createManager();
    const parentCtx = Object.create(fx.ctx, { cwd: { value: repo } });

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await first.start({ task: "work", isolation: "worktree" }, parentCtx);
    await waitForTurns(first, run, 1);
    await first.shutdown();

    const path = run.snapshot!.worktree!.path;

    git(repo, "worktree", "remove", "--force", path);

    const second = fx.createManager();

    second.restore();

    await assert.rejects(
        second.send(second.branchRun(run.id), "continue", "main-agent"),
        /worktree is missing/,
    );
    assert.ok(!existsSync(path));
    assert.equal(second.branchRun(run.id).isLive, false);
});
