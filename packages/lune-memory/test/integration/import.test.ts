import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { MEMORY_CONTEXT_TAG } from "../../src/core/types.ts";
import { getSession, listEvents } from "../../src/store/rows.ts";
import {
    claudeRecord,
    codexMessage,
    codexMeta,
    createIngestEnv,
    fileRef,
    jsonl,
    piHeader,
    piMessage,
    writeText,
    type IngestEnv,
} from "../harness/ingest.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

/** Pi session file with one user message per text, chained in order. */
function piFile(
    env: IngestEnv,
    file: string,
    id: string,
    texts: string[],
    options: { mtime?: number; timestamp?: string } = {},
): string {
    const timestamp = options.timestamp ?? "2026-05-31T00:00:00.000Z";
    const records: unknown[] = [piHeader(id, env.cwd, timestamp)];
    texts.forEach((text, i) => {
        records.push(piMessage(`m${i}`, i === 0 ? null : `m${i - 1}`, "user", text, timestamp));
    });
    const path = join(env.roots.pi, "cwd-a", file);
    writeText(path, jsonl(records), options.mtime);
    return path;
}

describe("import", () => {
    let env: IngestEnv;
    afterEach(() => env.cleanup());

    it("imports a session, keeps event text as written and writes the transcript with it", () => {
        env = createIngestEnv({ now: NOW });
        const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
        piFile(env, "s1.jsonl", "s1", ["hello", `my token ${secret}`]);
        const summary = env.importer.importAll();
        assert.equal(summary.imported, 1);
        assert.deepEqual(summary.problems, []);
        const session = getSession(env.store, "pi", "s1");
        assert.ok(session);
        assert.equal(session.revision, 1);
        assert.equal(session.redactions, 0);
        const events = listEvents(env.store, "pi", "s1");
        assert.deepEqual(
            events.map((e) => e.text),
            ["hello", `my token ${secret}`],
        );
        assert.ok(session.transcriptPath && existsSync(session.transcriptPath));
        assert.ok(readFileSync(session.transcriptPath, "utf8").includes(secret));
    });

    it("is idempotent: a second import changes nothing", () => {
        env = createIngestEnv({ now: NOW });
        piFile(env, "s1.jsonl", "s1", ["a", "b"]);
        env.importer.importAll();
        const before = listEvents(env.store, "pi", "s1");
        const second = env.importer.importAll();
        assert.equal(second.imported, 0);
        assert.equal(second.unchanged, 1);
        assert.deepEqual(listEvents(env.store, "pi", "s1"), before);
        assert.equal(getSession(env.store, "pi", "s1")?.revision, 1);
    });

    it("re-importing identical content with a new mtime keeps the revision", () => {
        env = createIngestEnv({ now: NOW });
        piFile(env, "s1.jsonl", "s1", ["a"], { mtime: 1_000_000 });
        env.importer.importAll();
        piFile(env, "s1.jsonl", "s1", ["a"], { mtime: 2_000_000 });
        const summary = env.importer.importAll();
        assert.equal(summary.unchanged, 1);
        assert.equal(getSession(env.store, "pi", "s1")?.revision, 1);
    });

    it("adds only new events when the file grows and keeps existing event rows", () => {
        env = createIngestEnv({ now: NOW });
        piFile(env, "s1.jsonl", "s1", ["a", "b"]);
        env.importer.importAll();
        const ids = env.store.all("SELECT id, key FROM events ORDER BY seq");
        piFile(env, "s1.jsonl", "s1", ["a", "b", "c"]);
        const summary = env.importer.importAll();
        assert.equal(summary.imported, 1);
        assert.equal(summary.sessions[0]?.changed, true);
        const after = env.store.all("SELECT id, key FROM events ORDER BY seq");
        assert.deepEqual(after.slice(0, 2), ids);
        assert.equal(after.length, 3);
        assert.equal(getSession(env.store, "pi", "s1")?.revision, 2);
        const hashes = listEvents(env.store, "pi", "s1").map((e) => e.hash);
        assert.equal(new Set(hashes).size, 3);
    });

    it("the newer file wins when two files hold the same session", () => {
        env = createIngestEnv({ now: NOW });
        const older = piFile(env, "old.jsonl", "dup", ["old copy"], { mtime: 1_000_000 });
        const newer = piFile(env, "new.jsonl", "dup", ["new copy", "more"], { mtime: 2_000_000 });

        // The newer file is imported first: the older copy must not roll it back.
        assert.equal(env.importer.importFile(fileRef("pi", newer)).outcome, "imported");
        assert.equal(env.importer.importFile(fileRef("pi", older)).outcome, "skipped");
        assert.equal(getSession(env.store, "pi", "dup")?.sourcePath, newer);
        assert.deepEqual(
            listEvents(env.store, "pi", "dup").map((e) => e.text),
            ["new copy", "more"],
        );
    });

    it("a newer file replaces the session of an older file imported earlier", () => {
        env = createIngestEnv({ now: NOW });
        const older = piFile(env, "old.jsonl", "dup", ["old copy"], { mtime: 1_000_000 });
        const newer = piFile(env, "new.jsonl", "dup", ["new copy"], { mtime: 2_000_000 });
        env.importer.importFile(fileRef("pi", older));
        assert.equal(env.importer.importFile(fileRef("pi", newer)).outcome, "imported");
        assert.equal(getSession(env.store, "pi", "dup")?.sourcePath, newer);
    });

    it("keeps a session and its events after the source file is deleted", () => {
        env = createIngestEnv({ now: NOW });
        const path = piFile(env, "s1.jsonl", "s1", ["keep me"]);
        env.importer.importAll();
        rmSync(path);
        const summary = env.importer.importAll();
        assert.equal(summary.scanned, 0);
        assert.deepEqual(
            listEvents(env.store, "pi", "s1").map((e) => e.text),
            ["keep me"],
        );
    });

    it("marks an item source-missing when all its event sources vanish from the file", () => {
        env = createIngestEnv({ now: NOW });
        piFile(env, "s1.jsonl", "s1", ["a", "b"]);
        env.importer.importAll();
        const events = listEvents(env.store, "pi", "s1");
        const keyB = events[1]?.key ?? "";
        env.store.run(
            `INSERT INTO items(id, scope, kind, title, body, trust, status, origin, content_hash,
                created_at, updated_at)
            VALUES ('i1','global','fact','t','b','user','active','dreaming','h','t','t')`,
        );
        env.store.run(
            `INSERT INTO item_sources(item_id, seq, ref_kind, harness, session_id, event_key)
            VALUES ('i1', 0, 'event', 'pi', 's1', ?)`,
            keyB,
        );
        // The rewritten file no longer holds the second event.
        piFile(env, "s1.jsonl", "s1", ["a"]);
        env.importer.importAll();
        assert.equal(
            env.store.get("SELECT status FROM items WHERE id = 'i1'")?.status,
            "source-missing",
        );
        assert.equal(listEvents(env.store, "pi", "s1").length, 1);
    });

    it("historyDays limits first-run history: old sessions are processed, recent ones are not", () => {
        env = createIngestEnv({ now: NOW, historyDays: 30 });
        const old = new Date(NOW - 100 * DAY).toISOString();
        piFile(env, "old.jsonl", "old", ["ancient"], { timestamp: old });
        piFile(env, "recent.jsonl", "recent", ["fresh"], {
            timestamp: new Date(NOW - DAY).toISOString(),
        });
        env.importer.importAll();
        const oldSession = getSession(env.store, "pi", "old");
        assert.equal(oldSession?.processedRevision, oldSession?.revision);
        assert.equal(getSession(env.store, "pi", "recent")?.processedRevision, null);
        assert.equal(listEvents(env.store, "pi", "old").length, 1);
    });

    it("historyDays 0 means no limit", () => {
        env = createIngestEnv({ now: NOW, historyDays: 0 });
        const old = new Date(NOW - 1000 * DAY).toISOString();
        piFile(env, "old.jsonl", "old", ["ancient"], { timestamp: old });
        env.importer.importAll();
        assert.equal(getSession(env.store, "pi", "old")?.processedRevision, null);
    });

    it("flags memory-derived events", () => {
        env = createIngestEnv({ now: NOW });
        piFile(env, "s1.jsonl", "s1", [
            `<${MEMORY_CONTEXT_TAG}>injected</${MEMORY_CONTEXT_TAG}>`,
            "normal",
        ]);
        env.importer.importAll();
        assert.deepEqual(
            listEvents(env.store, "pi", "s1").map((e) => e.memoryDerived),
            [true, false],
        );
    });

    it("skips disabled harnesses", () => {
        env = createIngestEnv({ now: NOW });
        piFile(env, "s1.jsonl", "s1", ["a"]);
        env.config.harnesses.pi.enabled = false;
        const summary = env.importer.importAll();
        assert.equal(summary.scanned, 0);
    });

    it("records a file with an unknown format as an error and does not stop the scan", () => {
        env = createIngestEnv({ now: NOW });
        writeText(join(env.roots.pi, "cwd-a", "bad.jsonl"), jsonl([{ type: "message", id: "x" }]));
        piFile(env, "good.jsonl", "good", ["ok"]);
        const summary = env.importer.importAll();
        assert.equal(summary.errors, 1);
        assert.equal(summary.imported, 1);
        assert.match(summary.problems[0]?.error ?? "", /Unknown format/u);
    });

    describe("a text block with an unknown shape in a changed file", () => {
        const badBlock = { type: "text", text: { value: "Keep this evidence" } };

        function expectFailedImportKeepsEvents(
            harness: "pi" | "claude" | "codex",
            id: string,
            write: (records: unknown[]) => void,
            good: unknown[],
            bad: unknown[],
        ): void {
            write(good);
            env.importer.importAll();
            const before = listEvents(env.store, harness, id).map((e) => [e.key, e.text]);
            assert.ok(before.length > 0);

            write([...good, ...bad]);
            const summary = env.importer.importAll();

            assert.equal(summary.errors, 1);
            assert.match(summary.problems[0]?.error ?? "", /line \d+: .*unknown format/u);
            const after = listEvents(env.store, harness, id).map((e) => [e.key, e.text]);
            assert.deepEqual(after, before);
        }

        it("Pi: records an error that names the record and keeps the previous events", () => {
            env = createIngestEnv({ now: NOW });
            const path = join(env.roots.pi, "cwd-a", "s1.jsonl");
            expectFailedImportKeepsEvents(
                "pi",
                "s1",
                (records) => writeText(path, jsonl(records)),
                [piHeader("s1", env.cwd), piMessage("m0", null, "user", "kept")],
                [piMessage("m1", "m0", "assistant", [badBlock])],
            );
        });

        it("Claude: records an error that names the record and keeps the previous events", () => {
            env = createIngestEnv({ now: NOW });
            const path = join(env.roots.claude, "proj", "s1.jsonl");
            expectFailedImportKeepsEvents(
                "claude",
                "s1",
                (records) => writeText(path, jsonl(records)),
                [claudeRecord("s1", "u1", null, "user", "kept", { cwd: env.cwd })],
                [claudeRecord("s1", "a2", "u1", "assistant", [badBlock], { cwd: env.cwd })],
            );
        });

        it("Codex: records an error that names the record and keeps the previous events", () => {
            env = createIngestEnv({ now: NOW });
            const path = join(env.roots.codex, "2026", "05", "31", "rollout-x-c1.jsonl");
            expectFailedImportKeepsEvents(
                "codex",
                "c1",
                (records) => writeText(path, jsonl(records)),
                [codexMeta("c1", env.cwd), codexMessage("user", "kept")],
                [
                    {
                        type: "response_item",
                        payload: { type: "message", role: "assistant", content: [badBlock] },
                    },
                ],
            );
        });
    });

    it("skips subagent rollouts and imports other Codex sessions", () => {
        env = createIngestEnv({ now: NOW });
        const dayDir = join(env.roots.codex, "2026", "05", "31");
        writeText(
            join(dayDir, "rollout-2026-05-31T00-00-00-sub.jsonl"),
            jsonl([
                codexMeta("sub", env.cwd, { source: { subagent: {} } }),
                codexMessage("user", "x"),
            ]),
        );
        writeText(
            join(dayDir, "rollout-2026-05-31T00-00-01-main.jsonl"),
            jsonl([codexMeta("main", env.cwd), codexMessage("user", "hello codex")]),
        );
        const summary = env.importer.importAll();
        assert.equal(summary.skipped, 1);
        assert.equal(summary.imported, 1);
        assert.equal(getSession(env.store, "codex", "sub"), null);
        assert.equal(listEvents(env.store, "codex", "main")[0]?.text, "hello codex");
    });

    it("purges sessions older than retentionDays and does not import them again", () => {
        env = createIngestEnv({ now: NOW, retentionDays: 10 });
        piFile(env, "old.jsonl", "old", ["ancient"], {
            timestamp: new Date(NOW - 50 * DAY).toISOString(),
        });
        const first = env.importer.importAll();
        assert.equal(first.purged, 1);
        assert.equal(getSession(env.store, "pi", "old"), null);
        const second = env.importer.importAll();
        assert.equal(second.unchanged, 1);
        assert.equal(getSession(env.store, "pi", "old"), null);
    });
});
