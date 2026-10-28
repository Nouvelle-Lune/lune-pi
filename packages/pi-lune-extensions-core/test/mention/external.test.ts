import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionCatalog } from "../../src/mention/catalog.ts";
import { parseClaudeSession } from "../../src/mention/claude.ts";
import { parseCodexSession } from "../../src/mention/codex.ts";
import {
    codexMeta,
    codexMessage,
    claudeMessage,
    jsonl,
} from "../harness/external-session-fixtures.ts";
import { isolateExternalSessions, SessionFile } from "../harness/session-fixtures.ts";

const ID = "01a14931-31bb-7000-8000-aaaaaaaaaaaa";

test("Codex uses response text once and excludes desktop context, analysis and tool payloads", () => {
    const parsed = parseCodexSession(
        jsonl([
            codexMeta(ID),
            codexMessage("developer", "SYSTEM"),
            codexMessage("user", "AGENTS", {
                internal_chat_message_metadata_passthrough: {
                    content_item_kinds: ["agents_md.instructions"],
                },
            }),
            codexMessage("user", "Question", {
                internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
            }),
            { type: "event_msg", payload: { type: "user_message", message: "Question" } },
            codexMessage("assistant", "PRIVATE", { channel: "analysis" }),
            { type: "response_item", payload: { type: "function_call_output", output: "TOOL" } },
            codexMessage("assistant", "Answer", {
                content: [
                    { type: "output_text", text: "Answer" },
                    { type: "input_image", image_url: "IMAGE" },
                ],
            }),
        ]),
        "/codex/session.jsonl",
    )!;

    assert.deepEqual(parsed.messages, [
        { role: "user", text: "Question" },
        { role: "assistant", text: "Answer" },
    ]);
    assert.equal(parsed.session.source, "codex");
    assert.equal(parsed.session.firstMessage, "Question");
    assert.equal(parsed.session.messageCount, 2);
    assert.equal(parsed.session.modified.toISOString(), "2026-02-02T01:00:00.000Z");
});

test("Codex replacement history supplies the readable summary and replaces compacted conversation", () => {
    const parsed = parseCodexSession(
        jsonl([
            codexMeta(ID),
            codexMessage("user", "Ancient request"),
            codexMessage("assistant", "Ancient answer"),
            {
                type: "compacted",
                payload: {
                    message: "Summary of the plan",
                    replacement_history: [
                        codexMessage("user", "Retained request").payload,
                        codexMessage("user", "Summary of the plan").payload,
                        { type: "compaction", encrypted_content: "OPAQUE" },
                    ],
                },
            },
            codexMessage("assistant", "Latest answer"),
        ]),
        "/codex/session.jsonl",
    )!;

    assert.deepEqual(parsed.messages, [
        { role: "user", text: "Retained request" },
        { role: "summary", text: "Summary of the plan" },
        { role: "assistant", text: "Latest answer" },
    ]);
    assert.doesNotMatch(parsed.session.allMessagesText, /Ancient|OPAQUE/);
});

test("Codex turn rollback removes a compaction made by the discarded turn", () => {
    const event = (type: string, extra = {}) => ({
        type: "event_msg",
        payload: { type, ...extra },
    });
    const parsed = parseCodexSession(
        jsonl([
            codexMeta(ID),
            event("task_started"),
            codexMessage("user", "First"),
            codexMessage("assistant", "Keep"),
            event("task_complete"),
            event("task_started"),
            codexMessage("user", "Discard"),
            {
                type: "compacted",
                payload: {
                    message: "Discarded summary",
                    replacement_history: [codexMessage("user", "Discarded summary").payload],
                },
            },
            codexMessage("assistant", "Discarded answer"),
            event("task_complete"),
            event("thread_rolled_back", { num_turns: 1 }),
            event("task_started"),
            codexMessage("user", "Replacement"),
            codexMessage("assistant", "New answer"),
        ]),
        "/codex/session.jsonl",
    )!;

    assert.deepEqual(
        parsed.messages.map((message) => message.text),
        ["First", "Keep", "Replacement", "New answer"],
    );
});

test("Codex empty tasks do not consume user turns during rollback", () => {
    const event = (type: string, extra = {}) => ({
        type: "event_msg",
        payload: { type, ...extra },
    });
    const parsed = parseCodexSession(
        jsonl([
            codexMeta(ID),
            event("task_started"),
            codexMessage("user", "Keep"),
            event("task_complete"),
            event("task_started"),
            codexMessage("user", "Discard"),
            event("task_complete"),
            event("task_started"),
            event("turn_aborted"),
            event("thread_rolled_back", { num_turns: 1 }),
        ]),
        "/codex/session.jsonl",
    )!;

    assert.deepEqual(parsed.messages, [{ role: "user", text: "Keep" }]);
});

test("Codex retains a readable compaction summary when replacement items contain no summary text", () => {
    const parsed = parseCodexSession(
        jsonl([
            codexMeta(ID),
            {
                type: "compacted",
                payload: { message: "Readable summary", replacement_history: [] },
            },
            codexMessage("user", "Continue"),
        ]),
        "/codex/session.jsonl",
    )!;

    assert.deepEqual(parsed.messages, [
        { role: "summary", text: "Readable summary" },
        { role: "user", text: "Continue" },
    ]);
});

test("Codex rejects unsupported rollouts and malformed JSONL with the file and line", () => {
    assert.throws(
        () => parseCodexSession(jsonl([{ id: ID }]), "/old.jsonl"),
        /supported Codex rollout/,
    );
    assert.throws(
        () => parseCodexSession(jsonl([codexMeta(ID)]) + "broken\n", "/broken.jsonl"),
        /Invalid JSONL at \/broken.jsonl:2/,
    );
    assert.throws(
        () => parseCodexSession(jsonl([codexMeta("../../escape")]), "/unsafe.jsonl"),
        /Invalid session id/,
    );
});

test("Codex subagent metadata excludes both current source markers", () => {
    assert.equal(
        parseCodexSession(jsonl([codexMeta(ID, { thread_source: "subagent" })]), "/agent.jsonl"),
        undefined,
    );
    assert.equal(
        parseCodexSession(
            jsonl([codexMeta(ID, { source: { subagent: { thread_spawn: {} } } })]),
            "/agent.jsonl",
        ),
        undefined,
    );
});

test("Claude Code follows the active parent chain and keeps text while omitting sidechain and tool content", () => {
    const parsed = parseClaudeSession(
        jsonl([
            { type: "last-prompt", leafUuid: "u", sessionId: ID },
            claudeMessage(ID, "u", null, "user", "Question"),
            claudeMessage(ID, "old", "u", "assistant", "Abandoned"),
            claudeMessage(ID, "a", "u", "assistant", [
                { type: "thinking", thinking: "PRIVATE" },
                { type: "text", text: "Answer" },
                { type: "tool_use", input: "COMMAND" },
            ]),
            claudeMessage(ID, "tool", "a", "user", [{ type: "tool_result", content: "TOOL" }]),
            claudeMessage(ID, "agent", "tool", "assistant", "SIDECHAIN", { isSidechain: true }),
            { type: "custom-title", sessionId: ID, customTitle: "Custom" },
            { type: "ai-title", sessionId: ID, aiTitle: "Generated" },
        ]),
        "/claude/session.jsonl",
    )!;

    assert.deepEqual(parsed.messages, [
        { role: "user", text: "Question" },
        { role: "assistant", text: "Answer" },
    ]);
    assert.equal(parsed.leafId, "tool");
    assert.equal(parsed.session.name, "Custom");
    assert.equal(parsed.session.cwd, "/work/claude-project");
    assert.equal(parsed.session.source, "claude");
});

test("Claude Code reconnects the preserved segment after its summary without reviving old history", () => {
    const parsed = parseClaudeSession(
        jsonl([
            claudeMessage(ID, "old", null, "user", "Ancient"),
            claudeMessage(ID, "head", "old", "user", "Retained request"),
            claudeMessage(ID, "tail", "head", "assistant", "Retained answer"),
            {
                ...claudeMessage(ID, "boundary", null, "user", "unused"),
                type: "system",
                subtype: "compact_boundary",
                compactMetadata: {
                    preservedSegment: { headUuid: "head", tailUuid: "tail", anchorUuid: "summary" },
                },
            },
            claudeMessage(ID, "summary", "boundary", "user", "Plan summary", {
                isCompactSummary: true,
            }),
            claudeMessage(ID, "new", "summary", "user", "Continue"),
        ]),
        "/claude/session.jsonl",
    )!;

    assert.deepEqual(parsed.messages, [
        { role: "summary", text: "Plan summary" },
        { role: "user", text: "Retained request" },
        { role: "assistant", text: "Retained answer" },
        { role: "user", text: "Continue" },
    ]);
});

test("Claude Code reports broken parent chains and cycles rather than returning a partial conversation", () => {
    assert.throws(
        () =>
            parseClaudeSession(
                jsonl([claudeMessage(ID, "a", "missing", "user", "Q")]),
                "/broken.jsonl",
            ),
        /missing parent missing/,
    );
    assert.throws(
        () =>
            parseClaudeSession(jsonl([claudeMessage(ID, "a", "a", "user", "Q")]), "/broken.jsonl"),
        /parent cycle/,
    );
    assert.equal(
        parseClaudeSession(
            jsonl([claudeMessage(ID, "a", null, "user", "Q", { isSidechain: true })]),
            "/agent.jsonl",
        ),
        undefined,
    );
    assert.throws(
        () => parseClaudeSession(jsonl([{ unsupported: true }]), "/invalid.jsonl"),
        /supported Claude Code session/,
    );
});

test("the combined catalog discovers only main unarchived sessions, merges activity order and reloads titles", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mention-external-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { codexHome, claudeHome } = isolateExternalSessions(t, root);
    const piDir = path.join(root, "pi-sessions");
    const codexDir = path.join(codexHome, "sessions", "2026", "02", "02");
    const claudeDir = path.join(claudeHome, "projects", "--work-project--");
    const archive = path.join(codexHome, "archived_sessions");
    const subagents = path.join(claudeDir, ID, "subagents");
    for (const directory of [piDir, codexDir, claudeDir, archive, subagents])
        await mkdir(directory, { recursive: true });
    const pi = new SessionFile("pi-session-0001");
    pi.user("Pi question");
    await writeFile(path.join(piDir, "pi.jsonl"), pi.jsonl());
    await writeFile(
        path.join(codexDir, "rollout-main.jsonl"),
        jsonl([codexMeta(ID), codexMessage("user", "Codex question")]),
    );
    await writeFile(
        path.join(archive, "rollout-archive.jsonl"),
        jsonl([codexMeta("archived"), codexMessage("user", "Hidden archive")]),
    );
    await writeFile(
        path.join(codexDir, "rollout-agent.jsonl"),
        jsonl([
            codexMeta("subagent", { thread_source: "subagent" }),
            codexMessage("user", "Hidden agent"),
        ]),
    );
    await writeFile(
        path.join(claudeDir, `${ID}.jsonl`),
        jsonl([claudeMessage(ID, "u", null, "user", "Claude question")]),
    );
    await writeFile(
        path.join(subagents, "agent-a.jsonl"),
        jsonl([claudeMessage("nested", "u", null, "user", "Hidden nested")]),
    );
    await writeFile(
        path.join(codexHome, "session_index.jsonl"),
        jsonl([
            { id: ID, thread_name: "Old name" },
            { id: ID, thread_name: "New name" },
        ]),
    );
    const errors: unknown[] = [];
    const catalog = new SessionCatalog(piDir, (error) => errors.push(error));
    t.after(() => catalog.dispose());

    const sessions = await catalog.reload();

    assert.deepEqual(
        sessions.map((session) => session.source),
        ["claude", "codex", "pi"],
    );
    assert.equal(sessions[1]!.name, "New name");
    assert.deepEqual(errors, []);
    const unchanged = await catalog.reload();
    assert.strictEqual(unchanged[0], sessions[0]);
    assert.strictEqual(unchanged[1], sessions[1]);
    await writeFile(
        path.join(codexHome, "session_index.jsonl"),
        jsonl([{ id: ID, thread_name: "Renamed" }]),
    );
    assert.equal((await catalog.reload())[1]!.name, "Renamed");
    await rm(path.join(codexDir, "rollout-main.jsonl"));
    assert.deepEqual(
        (await catalog.reload()).map((session) => session.source),
        ["claude", "pi"],
    );
});

test("invalid Codex and Claude files are silently excluded and reparsed after changing", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mention-external-error-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { codexHome, claudeHome } = isolateExternalSessions(t, root);
    const piDir = path.join(root, "pi-sessions");
    const codexDir = path.join(codexHome, "sessions");
    await mkdir(piDir);
    await mkdir(codexDir, { recursive: true });
    const claudeDir = path.join(claudeHome, "projects", "--project--");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, "broken.jsonl"), "broken\n");
    const broken = path.join(codexDir, "rollout-broken.jsonl");
    await writeFile(broken, "broken\n");
    await writeFile(
        path.join(codexDir, "rollout-valid.jsonl"),
        jsonl([codexMeta(ID), codexMessage("user", "Valid")]),
    );
    const errors: Error[] = [];
    const catalog = new SessionCatalog(piDir, (error) => errors.push(error as Error));
    t.after(() => catalog.dispose());

    assert.equal((await catalog.reload()).length, 1);
    assert.deepEqual(errors, []);
    assert.equal((await catalog.reload()).length, 1);
    assert.deepEqual(errors, []);
    await writeFile(broken, jsonl([codexMeta("repaired"), codexMessage("user", "Repaired")]));
    assert.equal((await catalog.reload()).length, 2);
    assert.deepEqual(errors, []);
});

test("an invalid Codex title index is silent and does not hide valid session messages", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mention-title-error-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { codexHome } = isolateExternalSessions(t, root);
    const piDir = path.join(root, "pi-sessions");
    const codexDir = path.join(codexHome, "sessions");
    await mkdir(piDir);
    await mkdir(codexDir, { recursive: true });
    await writeFile(
        path.join(codexDir, "rollout-valid.jsonl"),
        jsonl([codexMeta(ID), codexMessage("user", "Valid question")]),
    );
    const index = path.join(codexHome, "session_index.jsonl");
    await writeFile(index, jsonl([{ id: ID, thread_name: "Partial title" }]) + "broken\n");
    const errors: unknown[] = [];
    const catalog = new SessionCatalog(piDir, (error) => errors.push(error));
    t.after(() => catalog.dispose());

    const sessions = await catalog.reload();

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.name, undefined);
    assert.equal(sessions[0]!.firstMessage, "Valid question");
    assert.deepEqual(errors, []);
    await writeFile(index, jsonl([{ id: ID, thread_name: "Repaired title" }]));
    assert.equal((await catalog.reload())[0]!.name, "Repaired title");
});

test("external filesystem errors still reach the catalog error reporter", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mention-io-error-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { codexHome } = isolateExternalSessions(t, root);
    const piDir = path.join(root, "pi-sessions");
    await mkdir(piDir);
    await mkdir(codexHome);
    await writeFile(path.join(codexHome, "sessions"), "not a directory");
    const errors: Error[] = [];
    const catalog = new SessionCatalog(piDir, (error) => errors.push(error as Error));
    t.after(() => catalog.dispose());

    assert.deepEqual(await catalog.reload(), []);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /ENOTDIR/);
});
