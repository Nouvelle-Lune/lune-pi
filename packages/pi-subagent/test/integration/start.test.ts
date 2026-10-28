import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SUBAGENT_GUIDE } from "../../src/run/guide.ts";
import { RUN_ENTRY_TYPE } from "../../src/run/types.ts";
import { SUBAGENT_TOOL_NAMES } from "../../src/tools/subagent-tools.ts";
import {
    createFixture,
    definition,
    liveSessionOf,
    readJsonl,
    reportResponse,
    startGated,
    waitForTurns,
} from "../harness/fixture.ts";

function runFiles(agentDir: string, parentSessionId: string): string[] {
    const dir = join(agentDir, "lune-subagents", "sessions", parentSessionId);

    return existsSync(dir) ? readdirSync(dir) : [];
}

function spawnEntries(parent: { getEntries(): readonly { type: string }[] }) {
    return parent
        .getEntries()
        .filter(
            (entry) =>
                entry.type === "custom" &&
                (entry as { customType?: string }).customType === RUN_ENTRY_TYPE,
        ) as unknown as Array<{ id: string; data: Record<string, unknown> }>;
}

test("start returns at once with the run running; its report goes to the main agent as one steer message", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const { run, gate } = await startGated(fx, manager, { task: "Review the diff" });

    assert.equal(run.state, "running");
    assert.equal(fx.pi.sent.length, 0);

    fx.faux.setResponses([]);
    gate.open();
    await waitForTurns(manager, run, 1);
    const sent = await fx.pi.waitForMessages(1);

    assert.equal(run.state, "idle");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
    const content = String(sent[0]!.message.content);
    assert.match(content, new RegExp(run.id));
    assert.match(content, /Report: done/);
    assert.match(content, /finished/);
});

test("the task reaches the run unchanged as its first user message", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();
    const task = "  Review src/a.ts.\nReport each problem with its line.  ";

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const first = run.transcript().find((message) => message.role === "user");
    const actual =
        first?.role !== "user"
            ? undefined
            : typeof first.content === "string"
              ? first.content
              : first.content.map((part) => (part.type === "text" ? part.text : "")).join("");

    assert.equal(actual, task);
});

test("the parent records the run ID and run file; the run file starts with the snapshot", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "ok")]);
    const run = await manager.start({ task: "work" }, fx.ctx);
    await waitForTurns(manager, run, 1);

    const entries = spawnEntries(fx.parent);
    const expectedFile = join(
        fx.agentDir,
        "lune-subagents",
        "sessions",
        fx.parent.getSessionId(),
        `${run.id}.jsonl`,
    );

    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.data, {
        runId: run.id,
        sessionFile: expectedFile,
        parentSessionId: fx.parent.getSessionId(),
    });
    assert.equal(run.spawnEntryId, entries[0]!.id);
    assert.equal(run.file, expectedFile);

    const lines = readJsonl(expectedFile);

    // Pi writes its own model and thinking-level entries first; the snapshot is the first custom
    // entry and precedes every message.
    const snapshotAt = lines.findIndex((line) => line["customType"] === RUN_ENTRY_TYPE);
    const firstMessageAt = lines.findIndex((line) => line["type"] === "message");

    assert.equal(lines[0]!["type"], "session");
    assert.ok(snapshotAt > 0);
    assert.ok(lines.slice(1, snapshotAt).every((line) => line["type"] !== "custom"));
    assert.ok(snapshotAt < firstMessageAt);
    assert.equal((lines[snapshotAt]!["data"] as { runId: string }).runId, run.id);
});

test("a run cannot spawn runs: none of the four subagent tools exist in its session", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    fx.faux.setResponses([reportResponse("done", "ok"), reportResponse("done", "ok")]);
    const byDefault = await manager.start({ task: "work" }, fx.ctx);
    const explicit = await manager.start({ task: "work", tools: ["read", "bash"] }, fx.ctx);
    await waitForTurns(manager, byDefault, 1);
    await waitForTurns(manager, explicit, 1);

    for (const run of [byDefault, explicit]) {
        const { session } = liveSessionOf(run);
        const all = session.getAllTools().map((tool) => tool.name);
        const active = session.getActiveToolNames();

        for (const name of SUBAGENT_TOOL_NAMES) {
            assert.ok(!all.includes(name), `${name} is registered in run ${run.id}`);
            assert.ok(!active.includes(name), `${name} is active in run ${run.id}`);
        }

        assert.ok(active.includes("report"));
    }
});

test("the system prompt has the subagent guide, and the definition body only for a definition run", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager([
        definition({ name: "reviewer", body: "Review the diff named in the task." }),
    ]);

    fx.faux.setResponses([reportResponse("done", "ok"), reportResponse("done", "ok")]);
    const named = await manager.start({ task: "work", agent: "reviewer" }, fx.ctx);
    const inline = await manager.start({ task: "work" }, fx.ctx);
    await waitForTurns(manager, named, 1);
    await waitForTurns(manager, inline, 1);

    const namedPrompt = liveSessionOf(named).session.systemPrompt;
    const inlinePrompt = liveSessionOf(inline).session.systemPrompt;

    assert.ok(namedPrompt.includes(SUBAGENT_GUIDE));
    assert.ok(namedPrompt.includes("Review the diff named in the task."));
    assert.ok(inlinePrompt.includes(SUBAGENT_GUIDE));
    assert.ok(!inlinePrompt.includes("Review the diff named in the task."));
});

test("the display name is the definition name, or run-1, run-2 per parent session for inline runs", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager([definition({ name: "reviewer" })]);

    fx.faux.setResponses([
        reportResponse("done", "ok"),
        reportResponse("done", "ok"),
        reportResponse("done", "ok"),
    ]);
    const first = await manager.start({ task: "a" }, fx.ctx);
    const named = await manager.start({ task: "b", agent: "reviewer" }, fx.ctx);
    const second = await manager.start({ task: "c" }, fx.ctx);

    assert.deepEqual([first.name, named.name, second.name], ["run-1", "reviewer", "run-2"]);
    assert.equal(named.snapshot?.definition?.name, "reviewer");
    assert.equal(first.snapshot?.definition, undefined);
});

test("an unknown agent fails the start with the loaded names and leaves no run file or entry", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager([definition({ name: "reviewer" })]);

    await assert.rejects(
        manager.start({ task: "work", agent: "ghost" }, fx.ctx),
        /No subagent definition named "ghost"\. Loaded: reviewer\./,
    );

    assert.deepEqual(spawnEntries(fx.parent), []);
    assert.equal(manager.branchRuns().length, 0);
    assert.ok(!existsSync(join(fx.agentDir, "lune-subagents", "sessions")));
});

test("a tool the run does not have fails the start and removes the run file", async (t) => {
    const fx = await createFixture(t);
    const manager = fx.createManager();

    await assert.rejects(
        manager.start({ task: "work", tools: ["read", "no_such_tool"] }, fx.ctx),
        /Not available in a run: no_such_tool/,
    );

    assert.deepEqual(spawnEntries(fx.parent), []);
    assert.equal(manager.branchRuns().length, 0);
    assert.deepEqual(runFiles(fx.agentDir, fx.parent.getSessionId()), []);
});
