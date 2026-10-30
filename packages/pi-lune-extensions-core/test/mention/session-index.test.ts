import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionCatalog } from "../../src/mention/catalog.ts";
import { PiSessions } from "../../src/mention/pi.ts";
import { sessionIndexFile } from "../../src/mention/session-index.ts";
import {
    claudeMessage,
    codexMeta,
    codexMessage,
    jsonl,
} from "../harness/external-session-fixtures.ts";
import { isolateExternalSessions, SessionFile } from "../harness/session-fixtures.ts";

const CODEX_ID = "01a14931-31bb-7000-8000-cccccccccccc";
const CLAUDE_ID = "01a14931-31bb-7000-8000-dddddddddddd";
/** A whole-millisecond time, so restoring it with utimes reproduces the stored version exactly. */
const PINNED = new Date("2026-02-10T00:00:00.000Z");

async function fixture(t: TestContext) {
    const root = await mkdtemp(path.join(os.tmpdir(), "session-index-"));
    const { agentDir, codexHome, claudeHome } = isolateExternalSessions(t, root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const customDir = path.join(root, "custom-sessions");
    await mkdir(customDir, { recursive: true });
    const catalogs: SessionCatalog[] = [];
    const errors: Error[] = [];
    /** Each catalog stands for one Pi session start; all of them share the on-disk index. */
    const open = () => {
        const catalog = new SessionCatalog(customDir, (error) => errors.push(error as Error));
        catalogs.push(catalog);
        return catalog;
    };
    t.after(() => catalogs.forEach((catalog) => catalog.dispose()));
    const piFile = (id: string) => path.join(customDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    const writePi = async (id: string, text: string) => {
        const file = new SessionFile(id, `/work/${id}`);
        file.message({ role: "user", content: text, timestamp: PINNED.getTime() });
        await writeFile(piFile(id), file.jsonl());
        await utimes(piFile(id), PINNED, PINNED);
        return piFile(id);
    };
    const codexFile = path.join(codexHome, "sessions", "2026", "02", "02", "rollout-main.jsonl");
    const writeCodex = async (text: string) => {
        await mkdir(path.dirname(codexFile), { recursive: true });
        await writeFile(codexFile, jsonl([codexMeta(CODEX_ID), codexMessage("user", text)]));
        await utimes(codexFile, PINNED, PINNED);
        return codexFile;
    };
    const claudeFile = path.join(claudeHome, "projects", "--work--", `${CLAUDE_ID}.jsonl`);
    const writeClaude = async (text: string) => {
        await mkdir(path.dirname(claudeFile), { recursive: true });
        await writeFile(claudeFile, jsonl([claudeMessage(CLAUDE_ID, "u", null, "user", text)]));
        await utimes(claudeFile, PINNED, PINNED);
        return claudeFile;
    };
    /** Replaces text with same-length text in place: same inode and size, then the old mtime. */
    const rewriteSameVersion = async (file: string, from: string, to: string) => {
        assert.equal(from.length, to.length);
        const content = await readFile(file, "utf8");
        assert.ok(content.includes(from));
        await writeFile(file, content.replace(from, to));
        await utimes(file, PINNED, PINNED);
    };
    const storedFiles = async () => {
        const stored = JSON.parse(await readFile(sessionIndexFile(agentDir), "utf8")) as {
            format: number;
            files: Record<string, unknown>;
        };
        return stored;
    };
    return {
        root,
        agentDir,
        codexHome,
        customDir,
        errors,
        open,
        writePi,
        writeCodex,
        writeClaude,
        rewriteSameVersion,
        storedFiles,
    };
}

const ids = (sessions: readonly { id: string }[]) => sessions.map((session) => session.id);
const firstMessages = (sessions: readonly { firstMessage: string }[]) =>
    sessions.map((session) => session.firstMessage).sort();

test("a later session start reuses unchanged Pi, Codex and Claude Code files from the index", async (t) => {
    const env = await fixture(t);
    const pi = await env.writePi("pi-session-0000001", "hello pi AAAA");
    const codex = await env.writeCodex("hello codex AAAA");
    const claude = await env.writeClaude("hello claude AAAA");
    await env.open().reload();
    await env.rewriteSameVersion(pi, "hello pi AAAA", "hello pi BBBB");
    await env.rewriteSameVersion(codex, "hello codex AAAA", "hello codex BBBB");
    await env.rewriteSameVersion(claude, "hello claude AAAA", "hello claude BBBB");

    const actual = firstMessages(await env.open().reload());

    // The files now read differently; the old texts can only come from the saved index.
    assert.deepEqual(actual, ["hello claude AAAA", "hello codex AAAA", "hello pi AAAA"]);
    assert.deepEqual(env.errors, []);
});

test("a file whose size or modification time changed is read again", async (t) => {
    const env = await fixture(t);
    const bySize = await env.writePi("pi-session-0000001", "hello size AAAA");
    const byTime = await env.writePi("pi-session-0000002", "hello time AAAA");
    const untouched = await env.writePi("pi-session-0000003", "hello same AAAA");
    await env.open().reload();
    await writeFile(
        bySize,
        (await readFile(bySize, "utf8")).replace("hello size AAAA", "hello size changed"),
    );
    await env.rewriteSameVersion(byTime, "hello time AAAA", "hello time BBBB");
    await utimes(byTime, PINNED, new Date(PINNED.getTime() + 5_000));
    await env.rewriteSameVersion(untouched, "hello same AAAA", "hello same BBBB");

    const actual = firstMessages(await env.open().reload());

    assert.deepEqual(actual, ["hello same AAAA", "hello size changed", "hello time BBBB"]);
});

test("a deleted file disappears from the list and from the index file", async (t) => {
    const env = await fixture(t);
    const kept = await env.writePi("pi-session-0000001", "hello kept");
    const removed = await env.writePi("pi-session-0000002", "hello removed");
    const codex = await env.writeCodex("hello codex");
    await env.open().reload();
    assert.deepEqual(Object.keys((await env.storedFiles()).files).sort(), [codex, kept, removed]);
    await rm(removed);
    await rm(codex);

    const actual = ids(await env.open().reload());

    assert.deepEqual(actual, ["pi-session-0000001"]);
    assert.deepEqual(Object.keys((await env.storedFiles()).files), [kept]);
});

/** A Pi session whose header carries `parentSession`, which SessionFile does not write. */
async function writeChildPi(env: Awaited<ReturnType<typeof fixture>>, id: string, extra = {}) {
    const file = new SessionFile(id, `/work/${id}`);
    file.message({ role: "user", content: `hello ${id}`, timestamp: PINNED.getTime() });
    const [header, ...rest] = file.jsonl().trimEnd().split("\n");
    const patched = JSON.stringify({ ...JSON.parse(header!), ...extra });
    const target = path.join(env.customDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    await writeFile(target, [patched, ...rest].join("\n") + "\n");
    return target;
}

test("sessions restored from the index equal fresh reads for every source", async (t) => {
    const env = await fixture(t);
    await env.writePi("pi-plain-00000001", "plain pi");
    await writeChildPi(env, "pi-child-0000002", { parentSession: "/sessions/parent.jsonl" });
    await writeChildPi(env, "pi-badtime-000003", { timestamp: "not a date" });
    await env.writeCodex("codex text");
    await env.writeClaude("claude text");
    await writeFile(
        path.join(env.codexHome, "session_index.jsonl"),
        jsonl([{ id: CODEX_ID, thread_name: "Codex title" }]),
    );
    const fresh = await env.open().reload();

    const restored = await env.open().reload();

    assert.equal(fresh.length, 5);
    assert.deepEqual(
        restored.map((session) => ({ ...session, created: session.created.getTime() })),
        fresh.map((session) => ({ ...session, created: session.created.getTime() })),
    );
    for (const [index, session] of fresh.entries()) {
        assert.ok(restored[index]!.created instanceof Date);
        assert.equal(restored[index]!.modified.getTime(), session.modified.getTime());
    }
    const byId = new Map(restored.map((session) => [session.id, session]));
    assert.equal(byId.get("pi-child-0000002")!.parentSessionPath, "/sessions/parent.jsonl");
    assert.equal(byId.get("pi-plain-00000001")!.name, undefined);
    assert.ok(Number.isNaN(byId.get("pi-badtime-000003")!.created.getTime()));
    assert.equal(byId.get(CODEX_ID)!.name, "Codex title");
    assert.equal(byId.get(CLAUDE_ID)!.name, undefined);
    assert.deepEqual(env.errors, []);
});

test("a Codex title renamed between session starts is picked up and saved", async (t) => {
    const env = await fixture(t);
    await env.writeCodex("codex text");
    const titles = path.join(env.codexHome, "session_index.jsonl");
    await writeFile(titles, jsonl([{ id: CODEX_ID, thread_name: "Old title" }]));
    await env.open().reload();
    await writeFile(titles, jsonl([{ id: CODEX_ID, thread_name: "New title" }]));

    const actual = (await env.open().reload())[0]!.name;

    assert.equal(actual, "New title");
    const stored = JSON.stringify((await env.storedFiles()).files);
    assert.match(stored, /New title/);
    assert.doesNotMatch(stored, /Old title/);
});

test("Pi sessions equal SessionManager.listAll for malformed, headerless, renamed and empty files", async (t) => {
    const env = await fixture(t);
    const session = (id: string, build: (file: SessionFile) => void) => {
        const file = new SessionFile(id, `/work/${id}`);
        build(file);
        return file.jsonl();
    };
    const write = (id: string, content: string) =>
        writeFile(path.join(env.customDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), content);
    const at = (day: number) => Date.parse(`2026-02-${String(day).padStart(2, "0")}T00:00:00.000Z`);
    // The last line was cut off while Pi appended to the file.
    await write(
        "truncated-0000001",
        session("truncated-0000001", (file) =>
            file.message({ role: "user", content: "kept", timestamp: at(2) }),
        ) + '{"type":"message","message":{"role":"assi',
    );
    // The first entry is a message, not the session header.
    await write(
        "headerless-000002",
        jsonl([{ type: "message", message: { role: "user", content: "x", timestamp: at(3) } }]) +
            session("headerless-000002", () => {}),
    );
    // A later empty name clears the earlier one; surrounding blanks are trimmed.
    await write(
        "cleared-000000003",
        session("cleared-000000003", (file) => {
            file.message({ role: "user", content: "cleared", timestamp: at(4) });
            file.add({ type: "session_info", name: "Was named" });
            file.add({ type: "session_info", name: "   " });
        }),
    );
    await write(
        "trimmed-000000004",
        session("trimmed-000000004", (file) => {
            file.message({ role: "user", content: "trimmed", timestamp: at(5) });
            file.add({ type: "session_info", name: "  Padded  " });
        }),
    );
    // Only a thinking block and a tool result: no text message.
    await write(
        "no-text-000000005",
        session("no-text-000000005", (file) => {
            file.assistant([{ type: "thinking", thinking: "x" }]);
            file.toolResult("read", "body");
        }),
    );
    // No message with activity: modified falls back to the header timestamp.
    await write(
        "header-only-000006",
        session("header-only-000006", () => {}),
    );
    const catalog = env.open();

    const expected = (await SessionManager.listAll(env.customDir)).map((info) => ({
        ...info,
        source: "pi",
    }));
    const actual = await catalog.reload();

    assert.ok(expected.length >= 5, "the fixtures must produce sessions");
    assert.deepEqual(actual, expected);
    const byId = new Map(actual.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("headerless-000002"), undefined);
    assert.equal(byId.get("cleared-000000003")!.name, undefined);
    assert.equal(byId.get("trimmed-000000004")!.name, "Padded");
    assert.equal(byId.get("no-text-000000005")!.firstMessage, "(no messages)");
    assert.equal(
        byId.get("header-only-000006")!.modified.toISOString(),
        "2026-01-01T00:00:00.000Z",
    );
    // A third start restores them all from the index and still matches.
    assert.deepEqual(await env.open().reload(), expected);
    assert.deepEqual(env.errors, []);
});

test("the index file is written owner-only", async (t) => {
    const env = await fixture(t);
    await env.writePi("pi-session-0000001", "hello");

    await env.open().reload();

    const file = sessionIndexFile(env.agentDir);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
});

for (const [description, content] of [
    ["is not JSON", "{ not json"],
    ["has no format", JSON.stringify({ files: {} })],
    ["holds an entry without a version", JSON.stringify({ format: 1, files: { "/a": {} } })],
] as const) {
    test(`an index that ${description} is reported once, the list stays correct and the file is rewritten`, async (t) => {
        const env = await fixture(t);
        await env.writePi("pi-session-0000001", "hello");
        const file = sessionIndexFile(env.agentDir);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);

        const actual = ids(await env.open().reload());

        assert.deepEqual(actual, ["pi-session-0000001"]);
        assert.equal(env.errors.length, 1);
        assert.match(env.errors[0]!.message, /unreadable session index/);
        assert.equal((await env.storedFiles()).format, 1);
        assert.equal(Object.keys((await env.storedFiles()).files).length, 1);
        // The rewritten index loads without further reports.
        await env.open().reload();
        assert.equal(env.errors.length, 1);
    });
}

test("an index with another format number is ignored silently and rewritten", async (t) => {
    const env = await fixture(t);
    const pi = await env.writePi("pi-session-0000001", "hello AAAA");
    const file = sessionIndexFile(env.agentDir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ format: 999, files: { [pi]: { not: "valid" } } }));

    const actual = ids(await env.open().reload());

    assert.deepEqual(actual, ["pi-session-0000001"]);
    assert.deepEqual(env.errors, []);
    assert.equal((await env.storedFiles()).format, 1);
});

test("a failed index write is reported and the list is still returned", async (t) => {
    const env = await fixture(t);
    await env.writePi("pi-session-0000001", "hello");
    const directory = path.dirname(sessionIndexFile(env.agentDir));
    await mkdir(directory, { recursive: true });
    // A read-only directory fails the write but not the read of the missing index.
    if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
    await chmod(directory, 0o500);

    let actual: string[];
    try {
        actual = ids(await env.open().reload());
    } finally {
        // Restored before the fixture removes the directory.
        await chmod(directory, 0o700);
    }

    assert.deepEqual(actual, ["pi-session-0000001"]);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0]!.message, /EACCES/);
});

test("a catalog disposed while its load is running does not write the index", async (t) => {
    const env = await fixture(t);
    await env.writePi("pi-session-0000001", "hello");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const original = PiSessions.prototype.list;
    t.mock.method(
        PiSessions.prototype,
        "list",
        async function (this: PiSessions, signal: AbortSignal, report: (error: unknown) => void) {
            const sessions = await original.call(this, signal, report);
            await gate;
            return sessions;
        },
    );
    const catalog = env.open();
    const pending = catalog.reload();
    // Let the scan read the file before the owner shuts down.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    catalog.dispose();
    release();

    await assert.rejects(pending);
    await assert.rejects(stat(sessionIndexFile(env.agentDir)), { code: "ENOENT" });
    assert.deepEqual(env.errors, []);
});
