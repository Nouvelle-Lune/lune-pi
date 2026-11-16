import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SCHEMA_VERSION, Store } from "../../src/store/db.ts";
import { memoryPaths } from "../../src/core/paths.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { Importer } from "../../src/ingest/importer.ts";
import { ProjectResolver } from "../../src/projects/resolver.ts";
import { codexMessage, codexMeta, jsonl, makeTempDir, removeDir } from "../harness/ingest.ts";

describe("Store", () => {
    let dir: string;
    let store: Store;

    beforeEach(() => {
        dir = makeTempDir();
        store = Store.open(join(dir, "data", "memory.db"));
    });
    afterEach(() => {
        store.close();
        removeDir(dir);
    });

    function countMeta(key: string): number {
        return Number(store.get("SELECT COUNT(*) AS n FROM meta WHERE key = ?", key)?.n);
    }

    it("creates the schema and records the schema version", () => {
        const tables = store
            .all("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
            .map((row) => String(row.name));
        for (const name of [
            "sessions",
            "events",
            "items",
            "item_sources",
            "runs",
            "source_files",
        ]) {
            assert.ok(tables.includes(name), `missing table ${name}`);
        }
        assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
    });

    it("uses WAL mode, foreign keys and a 0600 database file", () => {
        assert.equal(store.get("PRAGMA journal_mode")?.journal_mode, "wal");
        assert.equal(store.get("PRAGMA foreign_keys")?.foreign_keys, 1);
        assert.equal(statSync(store.path).mode & 0o777, 0o600);
    });

    it("reopens an existing database without losing data or migrating again", () => {
        store.setMeta("probe", "kept");
        store.close();
        store = Store.open(join(dir, "data", "memory.db"));
        assert.equal(store.getMeta("probe"), "kept");
        assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
    });

    it("refuses a database from a newer schema version", () => {
        store.setMeta("schema_version", String(SCHEMA_VERSION + 1));
        store.close();
        assert.throws(() => Store.open(join(dir, "data", "memory.db")), /schema version/u);
        store = Store.open(":memory:");
    });

    it("commits a transaction and returns the callback result", () => {
        const result = store.tx(() => {
            store.setMeta("a", "1");
            return 42;
        });
        assert.equal(result, 42);
        assert.equal(store.getMeta("a"), "1");
    });

    it("rolls back every write of a failed transaction and rethrows", () => {
        assert.throws(
            () =>
                store.tx(() => {
                    store.setMeta("a", "1");
                    throw new Error("boom");
                }),
            /boom/u,
        );
        assert.equal(countMeta("a"), 0);
        assert.equal(store.db.isTransaction, false);
    });

    it("rolls back only the inner part when a nested failure is caught", () => {
        store.tx(() => {
            store.setMeta("outer", "1");
            try {
                store.tx(() => {
                    store.setMeta("inner", "1");
                    throw new Error("inner failed");
                });
            } catch {
                // The outer transaction continues.
            }
            store.setMeta("after", "1");
        });
        assert.equal(countMeta("outer"), 1);
        assert.equal(countMeta("after"), 1);
        assert.equal(countMeta("inner"), 0);
    });

    it("rolls back a committed inner part when the outer transaction fails", () => {
        assert.throws(() =>
            store.tx(() => {
                store.tx(() => store.setMeta("inner", "1"));
                throw new Error("outer failed");
            }),
        );
        assert.equal(countMeta("inner"), 0);
    });

    it("cascades event deletion from sessions", () => {
        store.run(
            `INSERT INTO sessions(harness, id, source_path, source_size, source_mtime, fingerprint,
                revision, changed_at, imported_at, status) VALUES ('pi','s','/x',1,1,'f',1,'t','t','ok')`,
        );
        store.run(
            `INSERT INTO events(harness, session_id, key, seq, role, text, memory_derived,
                untrusted, active, hash) VALUES ('pi','s','k',0,'user','hello',0,0,1,'h')`,
        );
        store.run("DELETE FROM sessions WHERE id = 's'");
        assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM events")?.n), 0);
    });
});

describe("schema v2 migration", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir();
    });
    afterEach(() => removeDir(dir));

    /** Make a database in the shape of version 1: no columns that versions 2 and 3 add. */
    function makeV1(path: string): void {
        const first = Store.open(path);
        first.run(
            `INSERT INTO sessions(harness, id, source_path, source_size, source_mtime, fingerprint,
                revision, changed_at, imported_at, status) VALUES ('pi','s','/x',1,1,'f',1,'t','t','ok')`,
        );
        first.run(
            `INSERT INTO events(harness, session_id, key, seq, role, text, memory_derived,
                untrusted, active, hash, processed_hash)
            VALUES ('pi','s','k',0,'user','kept text',0,0,1,'h','h')`,
        );
        first.close();
        const raw = new DatabaseSync(path);
        raw.exec("ALTER TABLE events DROP COLUMN processed_chars");
        raw.exec("ALTER TABLE events DROP COLUMN reset_revision");
        raw.exec("ALTER TABLE sessions DROP COLUMN review_revision");
        raw.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
        raw.close();
    }

    function columns(store: Store): string[] {
        return store.all("PRAGMA table_info(events)").map((row) => String(row.name));
    }

    it("opens a version 1 database, adds processed_chars and keeps its rows", () => {
        const path = join(dir, "memory.db");
        makeV1(path);

        const store = Store.open(path);

        try {
            assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
            assert.ok(columns(store).includes("processed_chars"));
            const row = store.get("SELECT text, processed_hash, processed_chars FROM events");
            assert.equal(row?.text, "kept text");
            assert.equal(row?.processed_hash, "h");
            assert.equal(row?.processed_chars, null);
            assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM sessions")?.n), 1);
        } finally {
            store.close();
        }
    });

    it("lets the migrated column hold a cursor", () => {
        const path = join(dir, "memory.db");
        makeV1(path);
        const store = Store.open(path);

        try {
            store.run("UPDATE events SET processed_chars = 120");
            assert.equal(store.get("SELECT processed_chars AS n FROM events")?.n, 120);
        } finally {
            store.close();
        }
    });

    it("does not migrate again when the migrated database is reopened", () => {
        const path = join(dir, "memory.db");
        makeV1(path);
        Store.open(path).close();

        const store = Store.open(path);

        try {
            assert.equal(columns(store).filter((name) => name === "processed_chars").length, 1);
            assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
        } finally {
            store.close();
        }
    });
});

describe("schema v3 migration", () => {
    let dir: string;
    beforeEach(() => {
        dir = makeTempDir();
    });
    afterEach(() => removeDir(dir));

    const SESSION_SQL = `INSERT INTO sessions(harness, id, source_path, source_size, source_mtime,
        fingerprint, revision, changed_at, imported_at, status, processed_revision)
        VALUES (?, ?, ?, 1, 1, 'f', 1, 't', 't', 'ok', ?)`;
    const EVENT_SQL = `INSERT INTO events(harness, session_id, key, seq, role, text, memory_derived,
        untrusted, active, hash, processed_hash, processed_chars)
        VALUES (?, ?, ?, 0, 'user', ?, 0, 0, 1, 'h', 'h', ?)`;

    /** Make a version 1 database: seed it at the current schema, then drop the newer columns. */
    function makeV1(path: string, seed: (store: Store) => void): void {
        const first = Store.open(path);
        seed(first);
        first.close();
        const raw = new DatabaseSync(path);
        raw.exec("ALTER TABLE events DROP COLUMN processed_chars");
        raw.exec("ALTER TABLE events DROP COLUMN reset_revision");
        raw.exec("ALTER TABLE sessions DROP COLUMN review_revision");
        raw.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
        raw.close();
    }

    function addRun(store: Store, sessions: string[]): void {
        store.run(
            `INSERT INTO runs(kind, trigger, status, started_at, sessions)
            VALUES ('project', 'manual', 'ok', 't', ?)`,
            JSON.stringify(sessions),
        );
    }

    function addItem(store: Store, id: string, sources: Array<[string, string, string]>): void {
        store.run(
            `INSERT INTO items(id, scope, kind, title, body, trust, status, origin, content_hash,
                created_at, updated_at)
            VALUES (?, 'global', 'fact', 't', 'b', 'user', 'active', 'dreaming', 'h', 't', 't')`,
            id,
        );
        sources.forEach(([harness, session, key], seq) => {
            store.run(
                `INSERT INTO item_sources(item_id, seq, ref_kind, harness, session_id, event_key)
                VALUES (?, ?, 'event', ?, ?, ?)`,
                id,
                seq,
                harness,
                session,
                key,
            );
        });
    }

    it("adds the review columns and sets the schema version", () => {
        const path = join(dir, "memory.db");
        makeV1(path, () => {});

        const store = Store.open(path);

        try {
            assert.equal(store.getMeta("schema_version"), String(SCHEMA_VERSION));
            const sessionColumns = store.all("PRAGMA table_info(sessions)").map((r) => r.name);
            const eventColumns = store.all("PRAGMA table_info(events)").map((r) => r.name);
            assert.ok(sessionColumns.includes("review_revision"));
            assert.ok(eventColumns.includes("reset_revision"));
        } finally {
            store.close();
        }
    });

    it("sends long events of analyzed sessions back to unprocessed and keeps short ones", () => {
        const path = join(dir, "memory.db");
        makeV1(path, (store) => {
            store.run(SESSION_SQL, "pi", "analyzed", "/x", 1);
            store.run(EVENT_SQL, "pi", "analyzed", "long", "x".repeat(1001), 1000);
            store.run(EVENT_SQL, "pi", "analyzed", "edge", "y".repeat(1000), 1000);
            store.run(SESSION_SQL, "pi", "never-run", "/y", 1);
            store.run(EVENT_SQL, "pi", "never-run", "long", "z".repeat(1001), 1000);
            addRun(store, ["pi:analyzed"]);
        });

        const store = Store.open(path);

        try {
            const state = (session: string, key: string) =>
                store.get(
                    `SELECT processed_hash AS hash, processed_chars AS chars FROM events
                    WHERE session_id = ? AND key = ?`,
                    session,
                    key,
                );
            assert.deepEqual({ ...state("analyzed", "long") }, { hash: null, chars: null });
            assert.deepEqual({ ...state("analyzed", "edge") }, { hash: "h", chars: null });
            assert.deepEqual({ ...state("never-run", "long") }, { hash: "h", chars: null });
            const revision = (id: string) =>
                store.get("SELECT processed_revision AS r FROM sessions WHERE id = ?", id)?.r;
            assert.equal(revision("analyzed"), null);
            assert.equal(revision("never-run"), 1);
        } finally {
            store.close();
        }
    });

    describe("Codex rekey", () => {
        function rollout(id: string): string {
            const path = join(dir, "rollouts", `rollout-${id}.jsonl`);
            mkdirSync(join(dir, "rollouts"), { recursive: true });
            writeFileSync(
                path,
                jsonl([codexMeta(id, dir), codexMessage("user", `hello from ${id}`)]),
            );
            return path;
        }

        function seedCodex(store: Store, id: string, path: string): void {
            store.run(SESSION_SQL, "codex", id, path, null);
            store.run(EVENT_SQL, "codex", id, "abcd1234#0", "old key", null);
            store.run(
                `INSERT INTO source_files(path, harness, size, mtime, session_id, status, checked_at)
                VALUES (?, 'codex', 1, 1, ?, 'imported', 't')`,
                path,
                id,
            );
        }

        it("deletes sessions whose rollout exists and imports them again with full-digest keys", () => {
            const path = join(dir, "memory.db");
            const file = rollout("live");
            makeV1(path, (store) => seedCodex(store, "live", file));

            const store = Store.open(path);

            try {
                assert.equal(
                    Number(store.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 'live'")?.n),
                    0,
                );
                assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM events")?.n), 0);
                assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM source_files")?.n), 0);

                const home = join(dir, "home");
                const config = defaultConfig(home, {});
                for (const harness of ["pi", "claude"] as const) {
                    config.harnesses[harness] = { enabled: false, root: join(dir, harness) };
                }
                config.harnesses.codex = { enabled: true, root: join(dir, "rollouts") };
                const importer = new Importer(
                    store,
                    memoryPaths(join(home, "memory")),
                    config,
                    new ProjectResolver(store),
                );
                importer.importAll();

                const keys = store
                    .all("SELECT key FROM events WHERE session_id = 'live'")
                    .map((row) => String(row.key));
                assert.equal(keys.length, 1);
                assert.match(keys[0] ?? "", /^[0-9a-f]{64}(#\d+)?$/u);
            } finally {
                store.close();
            }
        });

        it("keeps the old keys of a session whose rollout is gone", () => {
            const path = join(dir, "memory.db");
            makeV1(path, (store) => seedCodex(store, "gone", join(dir, "missing.jsonl")));

            const store = Store.open(path);

            try {
                assert.equal(
                    store.get("SELECT key FROM events WHERE session_id = 'gone'")?.key,
                    "abcd1234#0",
                );
                assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM sessions")?.n), 1);
            } finally {
                store.close();
            }
        });

        it("keeps a forgotten rollout forgotten", () => {
            const path = join(dir, "memory.db");
            const file = rollout("forgot");
            makeV1(path, (store) => {
                seedCodex(store, "forgot", file);
                store.run("UPDATE source_files SET status = 'forgotten'");
            });

            const store = Store.open(path);

            try {
                assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM sessions")?.n), 0);
                assert.equal(store.get("SELECT status FROM source_files")?.status, "forgotten");
                assert.ok(existsSync(file));

                const home = join(dir, "home");
                const config = defaultConfig(home, {});
                for (const harness of ["pi", "claude"] as const) {
                    config.harnesses[harness] = { enabled: false, root: join(dir, harness) };
                }
                config.harnesses.codex = { enabled: true, root: join(dir, "rollouts") };
                new Importer(
                    store,
                    memoryPaths(join(home, "memory")),
                    config,
                    new ProjectResolver(store),
                ).importAll();
                assert.equal(Number(store.get("SELECT COUNT(*) AS n FROM sessions")?.n), 0);
            } finally {
                store.close();
            }
        });

        it("marks an item source-missing when it has no live event source left", () => {
            const path = join(dir, "memory.db");
            const file = rollout("cited");
            makeV1(path, (store) => {
                seedCodex(store, "cited", file);
                store.run(SESSION_SQL, "pi", "alive", "/p", null);
                store.run(EVENT_SQL, "pi", "alive", "k", "live event", null);
                addItem(store, "only-deleted", [["codex", "cited", "abcd1234#0"]]);
                addItem(store, "mixed", [
                    ["codex", "cited", "abcd1234#0"],
                    ["pi", "alive", "k"],
                ]);
            });

            const store = Store.open(path);

            try {
                const status = (id: string) =>
                    store.get("SELECT status FROM items WHERE id = ?", id)?.status;
                assert.equal(status("only-deleted"), "source-missing");
                assert.equal(status("mixed"), "active");
                assert.equal(
                    Number(
                        store.get(
                            "SELECT COUNT(*) AS n FROM item_sources WHERE item_id = 'only-deleted'",
                        )?.n,
                    ),
                    1,
                );
            } finally {
                store.close();
            }
        });

        it("does not change an item whose sources retention deleted earlier", () => {
            const path = join(dir, "memory.db");
            const file = rollout("kept");
            makeV1(path, (store) => {
                seedCodex(store, "kept", file);
                // The cited session was purged by retention long ago: no event row exists.
                addItem(store, "retained", [["codex", "purged", "deadbeef#0"]]);
            });

            const store = Store.open(path);

            try {
                assert.equal(
                    store.get("SELECT status FROM items WHERE id = 'retained'")?.status,
                    "active",
                );
            } finally {
                store.close();
            }
        });
    });
});
