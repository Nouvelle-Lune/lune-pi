import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { runSessionFile } from "../../src/paths.ts";
import {
    createRunFile,
    openRunFile,
    readRunFile,
    transcriptMessages,
    usageFromEntries,
} from "../../src/run/run-file.ts";
import { RUN_ENTRY_TYPE, TURN_ENTRY_TYPE } from "../../src/run/types.ts";
import {
    assistantMessage,
    snapshot,
    tempAgentDir,
    turn,
    userMessage,
    writeRunFile,
} from "./support.ts";

test("createRunFile writes the session header at once, with the run ID and parent link", (t) => {
    const agentDir = tempAgentDir(t);
    const file = runSessionFile("parent-1", "run-1", agentDir);

    createRunFile(file, { runId: "run-1", cwd: "/work", parentSessionFile: "/p/parent.jsonl" });

    const lines = readFileSync(file, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;

    assert.equal(lines.length, 1);
    assert.equal(header["type"], "session");
    assert.equal(header["id"], "run-1");
    assert.equal(header["cwd"], "/work");
    assert.equal(header["parentSession"], "/p/parent.jsonl");
});

test("createRunFile refuses to overwrite an existing run file", (t) => {
    const agentDir = tempAgentDir(t);
    const file = runSessionFile("parent-1", "run-1", agentDir);

    createRunFile(file, { runId: "run-1", cwd: "/work" });

    assert.throws(() => createRunFile(file, { runId: "run-1", cwd: "/work" }), /EEXIST/);
});

test("the snapshot entry is the first entry of the file", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeRunFile(agentDir, "parent-1", "run-1", {
        messages: [userMessage("task")],
    });

    const first = SessionManager.open(file).getEntries()[0]!;

    assert.equal(first.type, "custom");
    assert.equal((first as { customType: string }).customType, RUN_ENTRY_TYPE);
});

test("readRunFile restores snapshot, last turn, turn count and usage", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeRunFile(agentDir, "parent-1", "run-1", {
        snapshot: { name: "reviewer", title: "Security review" },
        messages: [
            userMessage("task"),
            assistantMessage("done", { input: 10, output: 5, cost: 0.5 }),
        ],
        turns: [
            turn({ state: "failed", error: "boom" }),
            turn({ report: { status: "done", summary: "ok" } }),
        ],
    });

    const state = readRunFile(file);

    assert.equal(state.snapshot.name, "reviewer");
    assert.equal(state.snapshot.title, "Security review");
    assert.equal(state.turns, 2);
    assert.deepEqual(state.lastTurn?.report, { status: "done", summary: "ok" });
    assert.equal(state.unfinishedTurn, false);
    assert.equal(state.usage.input, 10);
});

test("a message after the last turn record marks the turn as unfinished", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeRunFile(agentDir, "parent-1", "run-1", {
        messages: [userMessage("first")],
        turns: [turn()],
    });

    openRunFile(file).appendMessage(userMessage("second") as never);

    assert.equal(readRunFile(file).unfinishedTurn, true);
});

test("openRunFile fails for a missing path instead of starting an empty session", (t) => {
    const agentDir = tempAgentDir(t);

    assert.throws(() => openRunFile(join(agentDir, "nope.jsonl")), /run file is missing/);
});

test("a file without the snapshot entry or with a broken one is rejected", (t) => {
    const agentDir = tempAgentDir(t);
    const bare = runSessionFile("parent-1", "bare", agentDir);
    const broken = runSessionFile("parent-1", "broken", agentDir);

    createRunFile(bare, { runId: "bare", cwd: "/work" }).appendMessage(userMessage("x") as never);
    createRunFile(broken, { runId: "broken", cwd: "/work" }).appendCustomEntry(RUN_ENTRY_TYPE, {
        ...snapshot("broken"),
        isolation: "sandbox",
    });

    assert.throws(() => readRunFile(bare), new RegExp(`no ${RUN_ENTRY_TYPE} entry`));
    assert.throws(() => readRunFile(broken), /invalid lune-subagent-run entry/);
});

test("a turn record with an unknown state is rejected", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeRunFile(agentDir, "parent-1", "run-1");

    openRunFile(file).appendCustomEntry(TURN_ENTRY_TYPE, { state: "running" });

    assert.throws(() => readRunFile(file), /invalid lune-subagent-turn entry/);
});

test("transcriptMessages returns every message in order and skips other entries", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeRunFile(agentDir, "parent-1", "run-1", {
        messages: [userMessage("a"), assistantMessage("b"), userMessage("c")],
        turns: [turn()],
    });

    const messages = transcriptMessages(openRunFile(file).getEntries());

    assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "assistant", "user"],
    );
});

test("usageFromEntries sums assistant usage and prices, and derives the total", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeRunFile(agentDir, "parent-1", "run-1", {
        messages: [
            userMessage("task"),
            assistantMessage("one", { input: 100, output: 20, cost: 0.25 }),
            assistantMessage("two", { input: 50, output: 30, cost: 0.5 }),
        ],
    });

    const actual = usageFromEntries(openRunFile(file).getEntries());

    assert.deepEqual(actual, {
        input: 150,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        total: 200,
        cost: 0.75,
    });
});

test("usageFromEntries of a file without usage is all zero", (t) => {
    const agentDir = tempAgentDir(t);
    const file = writeRunFile(agentDir, "parent-1", "run-1");

    const actual = usageFromEntries(openRunFile(file).getEntries());

    assert.deepEqual(actual, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
    });
    assert.equal(existsSync(file), true);
});
