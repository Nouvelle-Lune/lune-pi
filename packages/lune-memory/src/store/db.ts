import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/** Schema version of `memory.db`. Increment it and add a step to `MIGRATIONS` for a change. */
export const SCHEMA_VERSION = 2;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root TEXT,
    merged_into TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE project_locators (
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (kind, value)
);
CREATE INDEX project_locators_project ON project_locators(project_id);

CREATE TABLE sessions (
    harness TEXT NOT NULL,
    id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_size INTEGER NOT NULL,
    source_mtime REAL NOT NULL,
    fingerprint TEXT NOT NULL,
    revision INTEGER NOT NULL,
    cwd TEXT,
    branch TEXT,
    project_id TEXT,
    title TEXT,
    started_at TEXT,
    updated_at TEXT,
    changed_at TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    transcript_path TEXT,
    status TEXT NOT NULL,
    last_error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    attempt_revision INTEGER,
    processed_revision INTEGER,
    warnings TEXT NOT NULL DEFAULT '[]',
    filtered TEXT NOT NULL DEFAULT '{}',
    redactions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (harness, id)
);
CREATE INDEX sessions_project ON sessions(project_id, changed_at);
CREATE INDEX sessions_changed ON sessions(changed_at);

CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    tool_name TEXT,
    text TEXT NOT NULL,
    time TEXT,
    source_line INTEGER,
    transcript_line INTEGER,
    memory_derived INTEGER NOT NULL,
    untrusted INTEGER NOT NULL,
    active INTEGER NOT NULL,
    hash TEXT NOT NULL,
    processed_hash TEXT,
    UNIQUE (harness, session_id, key),
    FOREIGN KEY (harness, session_id) REFERENCES sessions(harness, id) ON DELETE CASCADE
);
CREATE INDEX events_session_seq ON events(harness, session_id, seq);

CREATE VIRTUAL TABLE events_fts USING fts5(
    text,
    content = 'events',
    content_rowid = 'id',
    tokenize = 'trigram'
);
CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER events_fts_delete AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER events_fts_update AFTER UPDATE OF text ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pass TEXT,
    kind TEXT NOT NULL,
    project_id TEXT,
    trigger TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    sessions TEXT NOT NULL DEFAULT '[]',
    warnings TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    usage TEXT
);

CREATE TABLE items (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    project_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    branch TEXT,
    trust TEXT NOT NULL,
    status TEXT NOT NULL,
    origin TEXT NOT NULL,
    general INTEGER NOT NULL DEFAULT 0,
    writer_harness TEXT,
    writer_session TEXT,
    idem_key TEXT,
    content_hash TEXT NOT NULL,
    created_run INTEGER,
    updated_run INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX items_project ON items(project_id, status);
CREATE INDEX items_writer ON items(writer_harness, writer_session);

CREATE TABLE item_sources (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ref_kind TEXT NOT NULL,
    harness TEXT,
    session_id TEXT,
    event_key TEXT,
    ref_item TEXT,
    PRIMARY KEY (item_id, seq)
);
CREATE INDEX item_sources_event ON item_sources(harness, session_id, event_key);
CREATE INDEX item_sources_item ON item_sources(ref_item);

CREATE TABLE item_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    before TEXT,
    after TEXT,
    at TEXT NOT NULL
);
CREATE INDEX item_history_run ON item_history(run_id);
CREATE INDEX item_history_item ON item_history(item_id, id);

CREATE TABLE item_keys (
    idem_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    item_id TEXT NOT NULL,
    run_id INTEGER,
    PRIMARY KEY (idem_key, content_hash)
);
CREATE INDEX item_keys_item ON item_keys(item_id);

CREATE TABLE branches (
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    checked_at TEXT,
    closed_at TEXT,
    handled_run INTEGER,
    PRIMARY KEY (project_id, name)
);

CREATE TABLE source_files (
    path TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    fingerprint TEXT,
    session_id TEXT,
    status TEXT NOT NULL,
    error TEXT,
    checked_at TEXT NOT NULL
);
`;

/**
 * Version 2: `processed_chars` is the analysis cursor of a pending event. The first characters
 * of a long event were analyzed, and the next pass continues after them.
 */
const SCHEMA_V2 = "ALTER TABLE events ADD COLUMN processed_chars INTEGER;";

const MIGRATIONS: Record<number, string> = { 1: SCHEMA_V1, 2: SCHEMA_V2 };

export type Row = Record<string, unknown>;
export type Param = SQLInputValue;

/**
 * SQLite store of lune-memory. It is the only store: views on disk are projections of it.
 * All writes go through `tx`, so a reader never sees half of a commit.
 */
export class Store {
    readonly db: DatabaseSync;
    readonly path: string;
    private readonly statements = new Map<string, StatementSync>();
    private savepoint = 0;

    private constructor(db: DatabaseSync, path: string) {
        this.db = db;
        this.path = path;
    }

    static open(path: string): Store {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const fresh = path === ":memory:" || !existsSync(path);
        const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
        if (fresh && path !== ":memory:") chmodSync(path, 0o600);
        db.exec("PRAGMA busy_timeout = 10000");
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
        db.exec("PRAGMA foreign_keys = ON");
        const store = new Store(db, path);
        store.migrate();
        return store;
    }

    close(): void {
        this.statements.clear();
        if (this.db.isOpen) this.db.close();
    }

    private migrate(): void {
        this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        const current = Number(this.getMeta("schema_version") ?? "0");
        if (current > SCHEMA_VERSION) {
            throw new Error(
                `memory.db has schema version ${current}. This lune-memory supports ${SCHEMA_VERSION}. Update lune-memory.`,
            );
        }
        for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
            const sql = MIGRATIONS[version];
            if (!sql) throw new Error(`Missing migration to schema version ${version}`);
            this.tx(() => {
                this.db.exec(sql);
                this.setMeta("schema_version", String(version));
            });
        }
    }

    /** Cached prepared statement. */
    stmt(sql: string): StatementSync {
        let statement = this.statements.get(sql);
        if (!statement) {
            statement = this.db.prepare(sql);
            this.statements.set(sql, statement);
        }
        return statement;
    }

    all(sql: string, ...params: Param[]): Row[] {
        return this.stmt(sql).all(...params) as Row[];
    }

    get(sql: string, ...params: Param[]): Row | undefined {
        return this.stmt(sql).get(...params) as Row | undefined;
    }

    run(sql: string, ...params: Param[]): { changes: number; lastId: number } {
        const result = this.stmt(sql).run(...params);
        return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
    }

    /**
     * Run `fn` in one transaction. A nested call uses a savepoint. `fn` must be synchronous:
     * model calls and other async work stay outside a transaction.
     */
    tx<T>(fn: () => T): T {
        if (this.db.isTransaction) {
            const name = `sp${++this.savepoint}`;
            this.db.exec(`SAVEPOINT ${name}`);
            try {
                const result = fn();
                this.db.exec(`RELEASE ${name}`);
                return result;
            } catch (error) {
                this.db.exec(`ROLLBACK TO ${name}`);
                this.db.exec(`RELEASE ${name}`);
                throw error;
            }
        }
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            if (this.db.isTransaction) this.db.exec("ROLLBACK");
            throw error;
        }
    }

    getMeta(key: string): string | null {
        const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
            | Row
            | undefined;
        return row ? String(row.value) : null;
    }

    setMeta(key: string, value: string): void {
        this.db
            .prepare(
                "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .run(key, value);
    }
}

/** Column readers for rows from node:sqlite. */
export function text(row: Row, column: string): string {
    const value = row[column];
    return value === null || value === undefined ? "" : String(value);
}

export function textOrNull(row: Row, column: string): string | null {
    const value = row[column];
    return value === null || value === undefined ? null : String(value);
}

export function num(row: Row, column: string): number {
    const value = row[column];
    return typeof value === "number" ? value : Number(value ?? 0);
}

export function numOrNull(row: Row, column: string): number | null {
    const value = row[column];
    return value === null || value === undefined ? null : Number(value);
}

export function flag(row: Row, column: string): boolean {
    return Number(row[column] ?? 0) !== 0;
}

export function jsonOr<T>(row: Row, column: string, fallback: T): T {
    const value = row[column];
    if (typeof value !== "string" || !value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

export function bit(value: boolean): number {
    return value ? 1 : 0;
}
