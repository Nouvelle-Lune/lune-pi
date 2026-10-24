import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { RunManager } from "../../src/run/run-manager.ts";
import { RUN_ENTRY_TYPE } from "../../src/run/types.ts";
import { createFixture, reportResponse, waitForTurns } from "../harness/fixture.ts";

function runFiles(agentDir: string, parentSessionId: string): string[] {
    const dir = join(agentDir, "lune-subagents", "sessions", parentSessionId);

    return existsSync(dir) ? readdirSync(dir) : [];
}

/** Starts a run, ends the first manager and returns a second one restored over the same parent. */
async function restoredAfter(
    t: Parameters<typeof createFixture>[0],
    damage: (file: string) => void,
) {
    const fx = await createFixture(t);
    const first = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "ok")]);

    const original = await first.start({ task: "work" }, fx.ctx);

    await waitForTurns(first, original, 1);
    await first.shutdown();
    damage(original.file);

    const second = fx.createManager();

    second.restore();

    return { fx, second, run: second.branchRun(original.id) };
}

for (const [problem, damage] of [
    [
        "is corrupt",
        (file: string) => writeFileSync(file, '{"type":"session","id":"x"}\n{not json at all\n'),
    ],
    [
        "has no snapshot",
        (file: string) => writeFileSync(file, `${readFileSync(file, "utf8").split("\n")[0]}\n`),
    ],
    ["is gone", (file: string) => rmSync(file)],
] as Array<[string, (file: string) => void]>) {
    test(`a run whose file ${problem} restores as failed with a load error, and send is refused with it`, async (t) => {
        const { second, run } = await restoredAfter(t, damage);

        assert.equal(run.state, "failed");
        assert.equal(typeof run.loadError, "string");
        assert.notEqual(run.loadError, "");
        assert.equal(run.isLive, false);

        const loadError = run.loadError!;

        await assert.rejects(
            second.send(run, "go on", "main-agent"),
            (error: Error) =>
                error.message.includes(`Run ${run.id} cannot continue`) &&
                error.message.includes(loadError),
        );
        assert.equal(run.isLive, false);
    });
}

test("a model the parent allows but the run's runtime lacks fails start with a clear error and leaves no run file", async (t) => {
    const fx = await createFixture(t);
    // A second runtime without the faux provider: the parent lists the model, the run cannot load it.
    const bareRuntime = await ModelRuntime.create({
        authPath: join(fx.root, "bare-auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
    });
    const manager = new RunManager({
        pi: fx.pi.asApi(),
        ctx: fx.ctx,
        agentDir: fx.agentDir,
        definitions: [],
        modelRuntime: bareRuntime,
    });

    t.after(() => manager.shutdown());

    await assert.rejects(
        manager.start({ task: "work", model: "faux/faux-1" }, fx.ctx),
        /The model faux\/faux-1 is not available to a run/,
    );

    const spawnEntries = fx.parent
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE);

    assert.deepEqual(spawnEntries, []);
    assert.equal(manager.branchRuns().length, 0);
    assert.deepEqual(runFiles(fx.agentDir, fx.parent.getSessionId()), []);
});
