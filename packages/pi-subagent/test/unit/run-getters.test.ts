import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import { Run } from "../../src/run/run.ts";
import { restoredRun, runHost, tempAgentDir, writeRunFile } from "./support.ts";

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
