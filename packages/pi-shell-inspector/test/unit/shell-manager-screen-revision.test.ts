/**
 * Unit tests for `ShellManager.getScreenRevision`.
 *
 * Readers that derive something expensive from a job's screen (the inspector wraps it into pane
 * rows) skip the work while the revision is equal, so the contract is one-sided but strict: the
 * revision must differ whenever `getScreenLines` could return something different. That includes
 * content the emulator rewrote without adding a line, and a job that reuses the id of a cleared one.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ShellManager } from "../../src/shell/shell-manager.ts";
import { readJobScreen } from "../harness.ts";

/** Job table of the current test; every test starts with an empty one. */
let manager = new ShellManager();

function startJob(id: string): void {
    manager.startJob({
        id,
        command: `cmd ${id}`,
        cwd: "/work",
        controller: new AbortController(),
    });
}

async function writeOutput(id: string, output: string): Promise<void> {
    manager.appendOutput(id, output);
    await readJobScreen(manager, id);
}

describe("shell manager screen revision", () => {
    beforeEach(() => {
        manager = new ShellManager();
    });

    afterEach(() => {
        manager.clearAllJobs();
    });

    it("changes once the emulator has parsed new output", async () => {
        startJob("a");
        const before = manager.getScreenRevision("a");

        await writeOutput("a", "first\n");
        const afterFirst = manager.getScreenRevision("a");

        await writeOutput("a", "second\n");

        assert.notEqual(afterFirst, before);
        assert.notEqual(manager.getScreenRevision("a"), afterFirst);
    });

    it("stays put while the screen is only read", async () => {
        startJob("a");
        await writeOutput("a", "first\n");
        const settled = manager.getScreenRevision("a");

        manager.getScreenLines("a");
        manager.getJob("a");

        assert.equal(manager.getScreenRevision("a"), settled);
    });

    it("changes when output rewrites a line without adding one", async () => {
        startJob("a");
        await writeOutput("a", "progress 10%\r");
        const before = manager.getScreenRevision("a");
        const linesBefore = manager.getScreenLines("a");

        await writeOutput("a", "progress 90%\r");
        const linesAfter = manager.getScreenLines("a");

        assert.equal(linesAfter.length, linesBefore.length);
        assert.notDeepEqual(linesAfter, linesBefore);
        assert.notEqual(manager.getScreenRevision("a"), before);
    });

    it("never repeats a revision across jobs", async () => {
        startJob("a");
        startJob("b");
        await writeOutput("a", "same\n");
        await writeOutput("b", "same\n");

        assert.notEqual(manager.getScreenRevision("a"), manager.getScreenRevision("b"));
    });

    it("gives a job that reuses a cleared id a revision no earlier screen had", async () => {
        startJob("a");
        await writeOutput("a", "old\n");
        const seen = manager.getScreenRevision("a");
        manager.settleJob("a", { type: "completed", exitCode: 0 });
        assert.equal(manager.clearJob("a"), true);

        startJob("a");
        const fresh = manager.getScreenRevision("a");
        await writeOutput("a", "new\n");

        assert.notEqual(fresh, seen);
        assert.notEqual(manager.getScreenRevision("a"), seen);
    });

    it("refuses an unknown job like the other screen readers", () => {
        assert.throws(() => manager.getScreenRevision("missing"), /Unknown shell job/);
        assert.throws(() => manager.getScreenLines("missing"), /Unknown shell job/);
    });
});
