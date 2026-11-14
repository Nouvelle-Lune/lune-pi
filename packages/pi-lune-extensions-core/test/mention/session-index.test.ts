import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionCatalog } from "../../src/mention/catalog.ts";
import { SESSION_TEXT_LIMIT } from "../../src/mention/budget.ts";
import { PiSessions } from "../../src/mention/pi.ts";
import type { Stats } from "node:fs";
import type { LocalSession } from "../../src/mention/session.ts";
import {
    SessionIndex,
    sessionIndexFile,
    type SessionFile as IndexedFile,
} from "../../src/mention/session-index.ts";
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
    const open = (budget?: number) => {
        const catalog = new SessionCatalog(
            customDir,
            (error) => errors.push(error as Error),
            budget === undefined ? undefined : async () => budget,
        );
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
            textLimit: number;
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

test("an omitted Codex session is listed after its separate title shrinks", async (t) => {
    const env = await fixture(t);
    const budget = 1024 * 1024;
    const rollout = await env.writeCodex("codex text");
    const titles = path.join(env.codexHome, "session_index.jsonl");
    await writeFile(titles, jsonl([{ id: CODEX_ID, thread_name: "x".repeat(budget) }]));
    const before = await stat(rollout);

    assert.deepEqual(await env.open(budget).reload(), []);
    const marker = (await env.storedFiles()).files[rollout] as { omittedBytes?: number };
    assert.equal(typeof marker.omittedBytes, "number");
    await writeFile(titles, jsonl([{ id: CODEX_ID, thread_name: "Short title" }]));
    const after = await stat(rollout);
    assert.deepEqual(
        [after.ino, after.size, after.mtimeMs],
        [before.ino, before.size, before.mtimeMs],
    );

    const sessions = await env.open(budget).reload();

    assert.deepEqual(ids(sessions), [CODEX_ID]);
    assert.equal(sessions[0]!.name, "Short title");
    assert.deepEqual(env.errors, []);
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
    [
        "holds an entry without a version",
        JSON.stringify({ format: 3, textLimit: SESSION_TEXT_LIMIT, files: { "/a": {} } }),
    ],
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
        assert.equal((await env.storedFiles()).format, 3);
        assert.equal((await env.storedFiles()).textLimit, SESSION_TEXT_LIMIT);
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
    assert.equal((await env.storedFiles()).format, 3);
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
        async function (this: PiSessions, signal: AbortSignal) {
            const sessions = await original.call(this, signal);
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

/** A session file for SessionIndex alone; `reads` counts calls to read. */
function fakeFile(
    name: string,
    mtimeMs: number,
    options: { text?: string; fail?: Error } = {},
): Omit<IndexedFile, "stats"> & { stats: Stats; reads: number } {
    const text = options.text ?? "x".repeat(1_000);
    const file = {
        path: `/sessions/${name}.jsonl`,
        stats: { ino: 1, size: text.length, mtimeMs } as Stats,
        label: "Test",
        reads: 0,
        async read(): Promise<LocalSession | undefined> {
            file.reads++;
            if (options.fail) throw options.fail;
            return {
                source: "pi",
                path: file.path,
                id: name,
                cwd: "/work",
                created: new Date(mtimeMs),
                modified: new Date(mtimeMs),
                messageCount: 1,
                firstMessage: text,
                allMessagesText: text,
            };
        },
    };
    return file;
}

async function indexFixture(t: TestContext) {
    const root = await mkdtemp(path.join(os.tmpdir(), "session-index-budget-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, "index.json");
    const signal = new AbortController().signal;
    /** One index instance stands for one process start. */
    const open = async (budget?: number, textLimit?: number) => {
        const index = new SessionIndex(file, budget, textLimit);
        await index.load(signal);
        return index;
    };
    const stored = async () =>
        (
            JSON.parse(await readFile(file, "utf8")) as {
                files: Record<string, { version: string; omittedBytes?: number }>;
            }
        ).files;
    /** What one 1000-character session takes in the file, so budgets can be sized in sessions. */
    const sessionSize = async () => {
        const probe = path.join(root, "probe.json");
        const index = new SessionIndex(probe);
        await index.scan([fakeFile("probe", 1)], signal);
        await index.save();
        return (await stat(probe)).size;
    };
    return { file, signal, open, stored, sessionSize };
}

test("escaped session text keeps the saved index within a one MiB budget", async (t) => {
    const env = await indexFixture(t);
    const budget = 1024 * 1024;
    const files = Array.from({ length: 100 }, (_, i) =>
        fakeFile(`session-${i}`, 100 - i, { text: "\u0001".repeat(8_000) }),
    );
    const index = await env.open(budget);

    const { sessions, errors } = await index.scan(files, env.signal);
    await index.save();

    const size = (await stat(env.file)).size;
    assert.ok(size <= budget, `saved index uses ${size} bytes, budget is ${budget}`);
    assert.ok(sessions.length > 0 && sessions.length < files.length);
    assert.deepEqual(
        ids(sessions),
        files
            .slice(0, sessions.length)
            .map((file) => file.path.split("/").pop()!.replace(".jsonl", "")),
    );
    assert.deepEqual(errors, []);
});

test("a boundary marker that does not fit is skipped without evicting the newest session", async (t) => {
    const env = await indexFixture(t);
    const newest = fakeFile("newest", 2);
    const older = fakeFile("older", 1);
    const probe = await env.open();
    await probe.scan([newest], env.signal);
    await probe.save();
    const budget = (await stat(env.file)).size;
    const index = await env.open(budget);

    const { sessions } = await index.scan([newest, older], env.signal);
    await index.save();

    assert.deepEqual(ids(sessions), ["newest"]);
    assert.ok((await stat(env.file)).size <= budget);
    assert.deepEqual(Object.keys(await env.stored()), [newest.path]);
});

test("a scan lists the newest files that fit the budget and never reads or stores older ones", async (t) => {
    const env = await indexFixture(t);
    const budget = Math.floor((await env.sessionSize()) * 2.5);
    const files = [fakeFile("d", 1), fakeFile("c", 2), fakeFile("b", 3), fakeFile("a", 4)];
    const everything = await env.open();
    await everything.scan(files, env.signal);
    await everything.save();
    assert.equal(Object.keys(await env.stored()).length, 4);
    // d's stored entry is stale, so a walk that went past the boundary would have to read it.
    const oldest = files[0]!;
    oldest.stats = { ...oldest.stats, size: oldest.stats.size + 1 } as Stats;
    files.forEach((file) => (file.reads = 0));

    const limited = await env.open(budget);
    const { sessions, errors } = await limited.scan(files, env.signal);
    await limited.save();

    assert.deepEqual(ids(sessions).sort(), ["a", "b"]);
    assert.deepEqual(errors, []);
    assert.equal(oldest.reads, 0);
    // The boundary file c stays as a marker; d is gone.
    assert.deepEqual(Object.keys(await env.stored()).sort(), [
        files[3]!.path,
        files[2]!.path,
        files[1]!.path,
    ]);
});

test("the first file over the budget is stored as a marker and an unchanged rescan reads and writes nothing", async (t) => {
    const env = await indexFixture(t);
    const budget = Math.floor((await env.sessionSize()) * 2.5);
    const files = [fakeFile("a", 4), fakeFile("b", 3), fakeFile("c", 2), fakeFile("d", 1)];
    const first = await env.open(budget);
    await first.scan(files, env.signal);
    await first.save();
    const marker = (await env.stored())[files[2]!.path]!;
    assert.deepEqual(Object.keys(marker).sort(), ["omittedBytes", "version"]);
    assert.equal(typeof marker.omittedBytes, "number");
    files.forEach((file) => (file.reads = 0));
    const before = await stat(env.file);

    const second = await env.open(budget);
    const { sessions } = await second.scan(files, env.signal);
    await second.save();

    assert.deepEqual(ids(sessions), ["a", "b"]);
    assert.deepEqual(
        files.map((file) => file.reads),
        [0, 0, 0, 0],
    );
    const after = await stat(env.file);
    // A rewrite renames a new file into place.
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
});

test("a file omitted for lack of room is read and listed once a newer file is gone", async (t) => {
    const env = await indexFixture(t);
    const budget = Math.floor((await env.sessionSize()) * 2.5);
    const [a, b, c] = [fakeFile("a", 3), fakeFile("b", 2), fakeFile("c", 1)];
    const first = await env.open(budget);
    assert.deepEqual(ids((await first.scan([a, b, c], env.signal)).sessions), ["a", "b"]);
    await first.save();
    c.reads = 0;

    const second = await env.open(budget);
    const { sessions } = await second.scan([b, c], env.signal);
    await second.save();

    assert.deepEqual(ids(sessions), ["b", "c"]);
    assert.equal(c.reads, 1);
    assert.equal("omittedBytes" in (await env.stored())[c.path]!, false);
});

test("scan returns sessions in the order of the files it was given, not by modification time", async (t) => {
    const env = await indexFixture(t);
    const index = await env.open();

    const { sessions } = await index.scan(
        [fakeFile("old", 1), fakeFile("new", 3), fakeFile("mid", 2)],
        env.signal,
    );

    assert.deepEqual(ids(sessions), ["old", "new", "mid"]);
});

test("long message text is clipped without splitting a surrogate pair and restored sessions equal fresh reads", async (t) => {
    const env = await indexFixture(t);
    const emojiAtCut = "a".repeat(SESSION_TEXT_LIMIT - 1) + "\u{1F600}" + "tail";
    const plain = "b".repeat(SESSION_TEXT_LIMIT + 500);
    const files = [
        fakeFile("emoji", 2, { text: emojiAtCut }),
        fakeFile("plain", 1, { text: plain }),
    ];
    const first = await env.open();
    const fresh = (await first.scan(files, env.signal)).sessions;
    await first.save();
    files.forEach((file) => (file.reads = 0));

    const second = await env.open();
    const restored = (await second.scan(files, env.signal)).sessions;

    assert.equal(fresh[0]!.firstMessage, "a".repeat(SESSION_TEXT_LIMIT - 1));
    assert.equal(fresh[0]!.allMessagesText, "a".repeat(SESSION_TEXT_LIMIT - 1));
    assert.equal(fresh[1]!.firstMessage, plain.slice(0, SESSION_TEXT_LIMIT));
    assert.equal(fresh[1]!.allMessagesText.length, SESSION_TEXT_LIMIT);
    assert.deepEqual(
        files.map((file) => file.reads),
        [0, 0],
    );
    assert.deepEqual(restored, fresh);
});

test("changing the text limit on one index rereads and clips both message fields", async (t) => {
    const env = await indexFixture(t);
    const file = fakeFile("text", 1, { text: "abcdefghijklmnop" });
    const index = await env.open(undefined, 10);
    const first = (await index.scan([file], env.signal)).sessions[0]!;
    assert.deepEqual([first.firstMessage, first.allMessagesText], ["abcdefghij", "abcdefghij"]);

    index.textLimit = 4;
    const smaller = (await index.scan([file], env.signal)).sessions[0]!;
    assert.deepEqual([smaller.firstMessage, smaller.allMessagesText], ["abcd", "abcd"]);
    assert.equal(file.reads, 2);

    index.textLimit = 12;
    const larger = (await index.scan([file], env.signal)).sessions[0]!;
    assert.deepEqual(
        [larger.firstMessage, larger.allMessagesText],
        ["abcdefghijkl", "abcdefghijkl"],
    );
    assert.equal(file.reads, 3);
});

test("reopening a saved index with changed text limits rereads and persists both fields", async (t) => {
    const env = await indexFixture(t);
    const file = fakeFile("text", 1, { text: "abcdefghijklmnop" });
    const first = await env.open(undefined, 10);
    await first.scan([file], env.signal);
    await first.save();

    const smallerIndex = await env.open(undefined, 4);
    const smaller = (await smallerIndex.scan([file], env.signal)).sessions[0]!;
    await smallerIndex.save();
    assert.deepEqual([smaller.firstMessage, smaller.allMessagesText], ["abcd", "abcd"]);
    assert.equal(file.reads, 2);
    assert.equal(JSON.parse(await readFile(env.file, "utf8")).textLimit, 4);

    const largerIndex = await env.open(undefined, 12);
    const larger = (await largerIndex.scan([file], env.signal)).sessions[0]!;
    await largerIndex.save();
    assert.deepEqual(
        [larger.firstMessage, larger.allMessagesText],
        ["abcdefghijkl", "abcdefghijkl"],
    );
    assert.equal(file.reads, 3);
    assert.equal(JSON.parse(await readFile(env.file, "utf8")).textLimit, 12);

    const restoredIndex = await env.open(undefined, 12);
    const restored = (await restoredIndex.scan([file], env.signal)).sessions[0]!;
    assert.deepEqual(
        [restored.firstMessage, restored.allMessagesText],
        ["abcdefghijkl", "abcdefghijkl"],
    );
    assert.equal(file.reads, 3);
});

test("a read error is reported with its label and path, spends no budget and ends no walk", async (t) => {
    const env = await indexFixture(t);
    const budget = Math.floor((await env.sessionSize()) * 2.5);
    const cause = new Error("boom");
    const broken = fakeFile("broken", 9, { fail: cause });
    const index = await env.open(budget);

    const { sessions, errors } = await index.scan(
        [broken, fakeFile("a", 3), fakeFile("b", 2)],
        env.signal,
    );

    assert.deepEqual(ids(sessions), ["a", "b"]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message, `Test: ${broken.path}: boom`);
    assert.equal(errors[0]!.cause, cause);
});

test("a file removed since it was listed is skipped without an error", async (t) => {
    const env = await indexFixture(t);
    const gone = fakeFile("gone", 9, {
        fail: Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
    });
    const index = await env.open();

    const { sessions, errors } = await index.scan([gone, fakeFile("a", 1)], env.signal);

    assert.deepEqual(ids(sessions), ["a"]);
    assert.deepEqual(errors, []);
});

for (const omittedBytes of [-1, "12", null]) {
    test(`an index with omittedBytes ${JSON.stringify(omittedBytes)} is reported as unreadable`, async (t) => {
        const env = await indexFixture(t);
        await writeFile(
            env.file,
            JSON.stringify({
                format: 3,
                textLimit: SESSION_TEXT_LIMIT,
                files: { "/a": { version: "1:2:3", omittedBytes } },
            }),
        );

        await assert.rejects(
            new SessionIndex(env.file).load(env.signal),
            /unreadable session index/,
        );
    });
}

test("a smaller budget on the same index drops the oldest sessions from the next scan and from the saved file", async (t) => {
    const env = await indexFixture(t);
    const files = [fakeFile("d", 1), fakeFile("c", 2), fakeFile("b", 3), fakeFile("a", 4)];
    const index = await env.open();
    assert.deepEqual(ids((await index.scan(files, env.signal)).sessions).sort(), [
        "a",
        "b",
        "c",
        "d",
    ]);
    await index.save();
    assert.equal(Object.keys(await env.stored()).length, 4);

    index.budget = Math.floor((await env.sessionSize()) * 2.5);
    const { sessions } = await index.scan(files, env.signal);
    await index.save();

    assert.deepEqual(ids(sessions).sort(), ["a", "b"]);
    // The first file over the budget stays as a marker; the older one is gone.
    const expectedStored = [files[3]!.path, files[2]!.path, files[1]!.path].sort();
    const actualStored = Object.keys(await env.stored()).sort();
    assert.deepEqual(actualStored, expectedStored);
});

test("a larger budget on the same index reads and lists the files the last scan left out", async (t) => {
    const env = await indexFixture(t);
    const files = [fakeFile("d", 1), fakeFile("c", 2), fakeFile("b", 3), fakeFile("a", 4)];
    const index = await env.open(Math.floor((await env.sessionSize()) * 2.5));
    assert.deepEqual(ids((await index.scan(files, env.signal)).sessions).sort(), ["a", "b"]);
    await index.save();
    files.forEach((file) => (file.reads = 0));

    index.budget = 64 * 1024 * 1024;
    const { sessions } = await index.scan(files, env.signal);
    await index.save();

    assert.deepEqual(ids(sessions).sort(), ["a", "b", "c", "d"]);
    // Only the files the budget had excluded are read; a and b come from the index.
    assert.deepEqual(
        files.map((file) => file.reads),
        [1, 1, 0, 0],
    );
    assert.equal(Object.keys(await env.stored()).length, 4);
    assert.equal("omittedBytes" in (await env.stored())[files[1]!.path]!, false);
});
