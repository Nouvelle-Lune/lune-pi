import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { SCHEMA_VERSION, Store } from "../../src/store/db.ts";
import { makeTempDir, removeDir } from "../harness/ingest.ts";

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
