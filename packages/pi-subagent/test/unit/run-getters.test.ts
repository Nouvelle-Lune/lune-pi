import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import { Run } from "../../src/run/run.ts";
import { parentSession, restoredRun, runHost, tempAgentDir, writeRunFile } from "./support.ts";

test("a restored run reports the model and thinking level of its snapshot", (t) => {
    const run = restoredRun(tempAgentDir(t), "r1", {
        snapshot: { model: "anthropic/claude-opus-5-5", thinking: "high" },
    });

    assert.equal(run.isLive, false);
    assert.equal(run.model, "anthropic/claude-opus-5-5");
    assert.equal(run.thinkingLevel, "high");
});

test("a run whose file cannot be read has neither model nor thinking level", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeRunFile(agentDir, "parent", "r1");

    writeFileSync(file, "{not json at all\n");

    const run = Run.restore(
        { id: "r1", file, spawnEntryId: "spawn", parentSessionId: "parent", readOnly: false },
        runHost(agentDir),
    );

    assert.equal(typeof run.loadError, "string");
    assert.equal(run.model, undefined);
    assert.equal(run.thinkingLevel, undefined);
});

test("runsByBranch splits the runs by the active branch in one call, in start order", (t) => {
    const session = parentSession(t, tempAgentDir(t));

    session.spawn("aaaa0001");
    session.spawn("aaaa0002");

    const manager = session.manager();
    const ids = (runs: Array<{ id: string }>) => runs.map((run) => run.id);

    assert.deepEqual(ids(manager.runsByBranch().here), ["aaaa0001", "aaaa0002"]);
    assert.deepEqual(manager.runsByBranch().elsewhere, []);

    // An empty leaf puts every run on another branch.
    session.sessionManager.resetLeaf();

    const { here, elsewhere } = manager.runsByBranch();

    assert.deepEqual(here, []);
    assert.deepEqual(ids(elsewhere), ["aaaa0001", "aaaa0002"]);
});

test("branchRuns and otherBranchRuns return the two halves of runsByBranch", (t) => {
    const session = parentSession(t, tempAgentDir(t));

    session.spawn("aaaa0001");

    const manager = session.manager();

    session.spawn("aaaa0002");
    manager.restore();
    session.sessionManager.resetLeaf();
    session.spawn("aaaa0003");
    manager.restore();

    const { here, elsewhere } = manager.runsByBranch();

    assert.deepEqual(manager.branchRuns(), here);
    assert.deepEqual(manager.otherBranchRuns(), elsewhere);
    assert.ok(here.length + elsewhere.length >= 2);
});
