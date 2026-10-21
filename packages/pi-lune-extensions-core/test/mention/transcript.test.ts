import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { buildTranscript } from "../../src/mention/transcript.ts";
import { SessionFile, toolCall } from "../harness/session-fixtures.ts";

/** Writes a reference copy to disk, as buildTranscript reads it by its path. */
function write(t: TestContext, file: SessionFile, overrides: Partial<SessionInfo> = {}) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "session-transcript-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const target = path.join(directory, "session.jsonl");
    writeFileSync(target, file.jsonl());
    return file.info({ path: target, ...overrides });
}

function build(t: TestContext, file: SessionFile, overrides: Partial<SessionInfo> = {}) {
    return buildTranscript(write(t, file, overrides));
}

/** The `[Label]` that opens each block, in order. */
const labels = (markdown: string) =>
    markdown
        .split("\n\n")
        .flatMap((block) => /^\[(User|Assistant|Summary[^\]]*)\]/.exec(block)?.[1] ?? []);

test("the transcript keeps user and assistant text of the active branch only", (t) => {
    const file = new SessionFile();
    const root = file.user("Plan the migration");
    file.assistant("Abandoned idea", root);
    file.user("Abandoned follow-up");
    const kept = file.assistant("Use the staged plan", root);
    file.user("Sounds good", kept);

    const { markdown } = build(t, file);

    assert.match(markdown, /\[User\]: Plan the migration/);
    assert.match(markdown, /\[Assistant\]: Use the staged plan/);
    assert.match(markdown, /\[User\]: Sounds good/);
    assert.doesNotMatch(markdown, /Abandoned/);
});

test("the leaf id names the last entry of the active branch", (t) => {
    const file = new SessionFile();
    file.user("hi");
    const last = file.assistant("hello");

    assert.equal(build(t, file).leafId, last);
});

test("a compaction summary replaces the history it summarised", (t) => {
    const file = new SessionFile();
    file.user("Ancient request");
    file.assistant("Ancient answer");
    const keptUser = file.user("Recent request");
    file.assistant("Recent answer");
    file.add({
        type: "compaction",
        summary: "Earlier we agreed on plan X",
        firstKeptEntryId: keptUser,
        tokensBefore: 1000,
    });
    file.user("After compaction");

    const { markdown } = build(t, file);

    assert.match(markdown, /\[Summary of the earlier conversation\]: Earlier we agreed on plan X/);
    assert.match(markdown, /\[User\]: Recent request/);
    assert.match(markdown, /\[User\]: After compaction/);
    assert.doesNotMatch(markdown, /Ancient/);
});

test("thinking, tool calls and tool results make no blocks", (t) => {
    const file = new SessionFile();
    file.user("Look at the config");
    file.assistant([
        { type: "thinking", thinking: "SECRET-REASONING" },
        { type: "text", text: "Reading it now" },
        toolCall("read", { path: "config.json" }),
    ]);
    file.toolResult("read", "TOOL-OUTPUT-BODY");
    file.assistant([toolCall("edit", { path: "/work/project/src/a.ts" })]);

    const { markdown } = build(t, file);

    assert.deepEqual(labels(markdown), ["User", "Assistant"]);
    assert.match(markdown, /\[Assistant\]: Reading it now/);
    assert.doesNotMatch(markdown, /SECRET-REASONING|TOOL-OUTPUT-BODY|config\.json|a\.ts|\[Tools\]/);
});

test("shell commands, custom messages and branch summaries make no blocks", (t) => {
    const file = new SessionFile();
    const start = file.user("Start");
    file.message({
        role: "bashExecution",
        command: "SHELL-COMMAND",
        output: "SHELL-OUTPUT",
        exitCode: 0,
        cancelled: false,
        truncated: false,
    });
    file.add({
        type: "custom_message",
        customType: "state",
        content: "HIDDEN-STATE",
        display: false,
    });
    file.add({
        type: "custom_message",
        customType: "reminder",
        content: "VISIBLE-NOTE",
        display: true,
    });
    file.add({ type: "branch_summary", fromId: start, summary: "BRANCH-SUMMARY-TEXT" });
    file.user("Continue");

    const { markdown } = build(t, file);

    assert.deepEqual(labels(markdown), ["User", "User"]);
    assert.doesNotMatch(
        markdown,
        /SHELL-|HIDDEN-STATE|VISIBLE-NOTE|BRANCH-SUMMARY-TEXT|Files changed/,
    );
});

test("system messages are not copied", (t) => {
    const file = new SessionFile();
    file.message({ role: "system", content: "SYSTEM-PROMPT-TEXT" });
    file.user("Question");

    assert.doesNotMatch(build(t, file).markdown, /SYSTEM-PROMPT-TEXT/);
});

test("context edits are applied to the rebuilt transcript", (t) => {
    const file = new SessionFile();
    const edited = file.user("Original wording with a password");
    file.assistant("Reply");
    file.add({
        type: "context_edit",
        targetId: edited,
        replacement: { content: "Redacted wording" },
    });

    const { markdown } = build(t, file);

    assert.match(markdown, /\[User\]: Redacted wording/);
    assert.doesNotMatch(markdown, /password/);
});

test("terminal escape sequences and control characters in session text are removed", (t) => {
    const file = new SessionFile();
    file.user("Hello \x1b[31mred\x1b[0m \x1b]0;evil-title\x07world\x00!");
    file.assistant("Answer\x1b[2J cleared");

    const { markdown } = build(t, file);

    assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(markdown), false);
    assert.doesNotMatch(markdown, /evil-title|\[31m/);
    assert.match(markdown, /\[User\]: Hello red/);
    assert.match(markdown, /world/);
});

test("the header lists the title, project, id, full copy and what was kept and removed", (t) => {
    const file = new SessionFile("sess-id-123", "/work/project");
    file.user("Hi");
    file.assistant("Hello");
    const info = write(t, file, { name: "Named session" });

    const { markdown } = buildTranscript(info);

    assert.match(markdown, /- Title: Named session/);
    assert.match(markdown, /- Project: \/work\/project/);
    assert.match(markdown, /- Session: sess-id-123,/);
    assert.ok(markdown.includes(`- Full session copy (JSONL): ${info.path} (`));
    assert.match(markdown, /\nKept: .*user prompts and assistant text\./);
    assert.match(markdown, /\nRemoved: .*tool calls and output, shell commands/);
    assert.doesNotMatch(markdown, /Files changed/);
});

test("a user message without text makes no block and the next one with text is the pinned first request", (t) => {
    const file = new SessionFile();
    file.user("   ");
    for (let index = 0; index < 20; index++) file.assistant(`early-${index} ` + "x".repeat(1900));
    file.user("REAL-FIRST-REQUEST");
    for (let index = 0; index < 20; index++) file.assistant(`late-${index} ` + "y".repeat(1900));
    file.user("NEWEST-REQUEST");

    const { markdown } = build(t, file);

    assert.match(markdown, /\[User\]: REAL-FIRST-REQUEST/);
    assert.match(markdown, /\[User\]: NEWEST-REQUEST/);
    assert.doesNotMatch(markdown, /early-0 /);
    assert.equal(labels(markdown).filter((label) => label === "User").length, 2);
});

test("long messages are clipped, and the last assistant text keeps more than earlier ones", (t) => {
    const file = new SessionFile();
    file.user("u".repeat(4_000));
    file.assistant("a".repeat(5_000));
    file.assistant("b".repeat(7_000));
    file.assistant([toolCall("read", {})]);

    const { markdown } = build(t, file);

    assert.ok(markdown.includes("u".repeat(3_000) + " … [1000 more characters]"));
    assert.ok(markdown.includes("a".repeat(2_000) + " … [3000 more characters]"));
    assert.ok(markdown.includes("b".repeat(6_000) + " … [1000 more characters]"));
});

test("past 40 KB the oldest blocks are dropped while the first request and newest text stay", (t) => {
    const file = new SessionFile();
    file.user("FIRST-REQUEST");
    file.user("SECOND-REQUEST");
    for (let index = 0; index < 40; index++) {
        file.assistant(`middle-${index} ` + "x".repeat(1900));
    }
    file.user("NEWEST-REQUEST");

    const { markdown } = build(t, file);

    assert.ok(Buffer.byteLength(markdown, "utf8") <= 40 * 1024 + 1);
    assert.match(markdown, /\[User\]: FIRST-REQUEST/);
    assert.match(markdown, /\[User\]: NEWEST-REQUEST/);
    assert.match(markdown, /\[… \d+ earlier blocks left out to fit the size limit …\]/);
    assert.doesNotMatch(markdown, /SECOND-REQUEST/);
    assert.doesNotMatch(markdown, /middle-0 /);
    assert.match(markdown, /middle-39 /);
});

test("the compaction summary survives the size limit", (t) => {
    const file = new SessionFile();
    const kept = file.user("Kept request");
    file.add({
        type: "compaction",
        summary: "PINNED-SUMMARY",
        firstKeptEntryId: kept,
        tokensBefore: 1,
    });
    for (let index = 0; index < 40; index++) file.assistant(`later-${index} ` + "y".repeat(1900));

    const { markdown } = build(t, file);

    assert.match(markdown, /PINNED-SUMMARY/);
    assert.match(markdown, /earlier blocks left out/);
});

for (const version of [3, 2]) {
    test(`building a transcript leaves a version ${version} session copy unchanged`, async (t) => {
        const file = new SessionFile();
        file.user("Hi");
        file.assistant("Hello");
        const info = write(t, file);
        writeFileSync(info.path, file.jsonl().replace('"version":3', `"version":${version}`));
        const before = await readFile(info.path);
        const mtimeBefore = statSync(info.path).mtimeMs;

        const { markdown } = buildTranscript(info);

        assert.match(markdown, /\[User\]: Hi/);
        const after = await readFile(info.path);
        assert.ok(after.equals(before));
        assert.equal(statSync(info.path).mtimeMs, mtimeBefore);
    });
}

test("an invalid session copy is rejected instead of producing an empty transcript", (t) => {
    const info = write(t, new SessionFile());
    writeFileSync(info.path, "not a session");

    assert.throws(() => buildTranscript(info), /Session file is not a valid pi session/);
});
