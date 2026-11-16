import type {
    EventRole,
    EventRow,
    Harness,
    Item,
    ItemKind,
    ItemOrigin,
    ItemScope,
    ItemStatus,
    Project,
    SessionRow,
    SourceRef,
    Trust,
} from "../core/types.ts";
import { nowIso } from "../core/util.ts";
import {
    bit,
    flag,
    jsonOr,
    num,
    numOrNull,
    text,
    textOrNull,
    type Param,
    type Row,
    type Store,
} from "./db.ts";

// ---------------------------------------------------------------------------------------------
// Projects

export function projectFromRow(row: Row): Project {
    return {
        id: text(row, "id"),
        name: text(row, "name"),
        root: textOrNull(row, "root"),
        mergedInto: textOrNull(row, "merged_into"),
        createdAt: text(row, "created_at"),
    };
}

export function getProject(store: Store, id: string): Project | null {
    const row = store.get("SELECT * FROM projects WHERE id = ?", id);
    return row ? projectFromRow(row) : null;
}

/** Follow `merged_into` to the project that is in use now. */
export function liveProjectId(store: Store, id: string): string {
    let current = id;
    for (let i = 0; i < 32; i++) {
        const row = store.get("SELECT merged_into FROM projects WHERE id = ?", current);
        const next = row ? textOrNull(row, "merged_into") : null;
        if (!next) return current;
        current = next;
    }
    return current;
}

export function listProjects(store: Store, includeMerged = false): Project[] {
    const sql = includeMerged
        ? "SELECT * FROM projects ORDER BY name, id"
        : "SELECT * FROM projects WHERE merged_into IS NULL ORDER BY name, id";
    return store.all(sql).map(projectFromRow);
}

// ---------------------------------------------------------------------------------------------
// Sessions

export function sessionFromRow(row: Row): SessionRow {
    return {
        harness: text(row, "harness") as Harness,
        id: text(row, "id"),
        sourcePath: text(row, "source_path"),
        sourceSize: num(row, "source_size"),
        sourceMtime: num(row, "source_mtime"),
        fingerprint: text(row, "fingerprint"),
        revision: num(row, "revision"),
        cwd: textOrNull(row, "cwd"),
        branch: textOrNull(row, "branch"),
        projectId: textOrNull(row, "project_id"),
        title: textOrNull(row, "title"),
        startedAt: textOrNull(row, "started_at"),
        updatedAt: textOrNull(row, "updated_at"),
        changedAt: text(row, "changed_at"),
        importedAt: text(row, "imported_at"),
        transcriptPath: textOrNull(row, "transcript_path"),
        status: text(row, "status") === "error" ? "error" : "ok",
        lastError: textOrNull(row, "last_error"),
        attempts: num(row, "attempts"),
        attemptRevision: numOrNull(row, "attempt_revision"),
        processedRevision: numOrNull(row, "processed_revision"),
        warnings: jsonOr<string[]>(row, "warnings", []),
        filtered: jsonOr<Record<string, number>>(row, "filtered", {}),
        redactions: num(row, "redactions"),
    };
}

export function getSession(store: Store, harness: Harness, id: string): SessionRow | null {
    const row = store.get("SELECT * FROM sessions WHERE harness = ? AND id = ?", harness, id);
    return row ? sessionFromRow(row) : null;
}

export function putSession(store: Store, s: SessionRow): void {
    store.run(
        `INSERT INTO sessions (harness, id, source_path, source_size, source_mtime, fingerprint,
            revision, cwd, branch, project_id, title, started_at, updated_at, changed_at,
            imported_at, transcript_path, status, last_error, attempts, attempt_revision,
            processed_revision, warnings, filtered, redactions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(harness, id) DO UPDATE SET
            source_path = excluded.source_path, source_size = excluded.source_size,
            source_mtime = excluded.source_mtime, fingerprint = excluded.fingerprint,
            revision = excluded.revision, cwd = excluded.cwd, branch = excluded.branch,
            project_id = excluded.project_id, title = excluded.title,
            started_at = excluded.started_at, updated_at = excluded.updated_at,
            changed_at = excluded.changed_at, imported_at = excluded.imported_at,
            transcript_path = excluded.transcript_path, status = excluded.status,
            last_error = excluded.last_error, attempts = excluded.attempts,
            attempt_revision = excluded.attempt_revision,
            processed_revision = excluded.processed_revision, warnings = excluded.warnings,
            filtered = excluded.filtered, redactions = excluded.redactions`,
        s.harness,
        s.id,
        s.sourcePath,
        s.sourceSize,
        s.sourceMtime,
        s.fingerprint,
        s.revision,
        s.cwd,
        s.branch,
        s.projectId,
        s.title,
        s.startedAt,
        s.updatedAt,
        s.changedAt,
        s.importedAt,
        s.transcriptPath,
        s.status,
        s.lastError,
        s.attempts,
        s.attemptRevision,
        s.processedRevision,
        JSON.stringify(s.warnings),
        JSON.stringify(s.filtered),
        s.redactions,
    );
}

// ---------------------------------------------------------------------------------------------
// Events

export function eventFromRow(row: Row): EventRow {
    return {
        harness: text(row, "harness") as Harness,
        sessionId: text(row, "session_id"),
        key: text(row, "key"),
        seq: num(row, "seq"),
        role: text(row, "role") as EventRole,
        toolName: textOrNull(row, "tool_name"),
        text: text(row, "text"),
        time: textOrNull(row, "time"),
        sourceLine: numOrNull(row, "source_line"),
        transcriptLine: numOrNull(row, "transcript_line"),
        memoryDerived: flag(row, "memory_derived"),
        untrusted: flag(row, "untrusted"),
        active: flag(row, "active"),
        hash: text(row, "hash"),
        processedHash: textOrNull(row, "processed_hash"),
    };
}

export function listEvents(store: Store, harness: Harness, sessionId: string): EventRow[] {
    return store
        .all(
            "SELECT * FROM events WHERE harness = ? AND session_id = ? ORDER BY seq",
            harness,
            sessionId,
        )
        .map(eventFromRow);
}

export function getEvent(
    store: Store,
    harness: Harness,
    sessionId: string,
    key: string,
): EventRow | null {
    const row = store.get(
        "SELECT * FROM events WHERE harness = ? AND session_id = ? AND key = ?",
        harness,
        sessionId,
        key,
    );
    return row ? eventFromRow(row) : null;
}

// ---------------------------------------------------------------------------------------------
// Items

function itemFromRow(row: Row, sources: SourceRef[]): Item {
    return {
        id: text(row, "id"),
        scope: text(row, "scope") as ItemScope,
        projectId: textOrNull(row, "project_id"),
        kind: text(row, "kind") as ItemKind,
        title: text(row, "title"),
        body: text(row, "body"),
        branch: textOrNull(row, "branch"),
        trust: text(row, "trust") as Trust,
        status: text(row, "status") as ItemStatus,
        origin: text(row, "origin") as ItemOrigin,
        general: flag(row, "general"),
        writerHarness: textOrNull(row, "writer_harness") as Harness | null,
        writerSession: textOrNull(row, "writer_session"),
        idemKey: textOrNull(row, "idem_key"),
        contentHash: text(row, "content_hash"),
        createdRun: numOrNull(row, "created_run"),
        updatedRun: numOrNull(row, "updated_run"),
        createdAt: text(row, "created_at"),
        updatedAt: text(row, "updated_at"),
        sources,
    };
}

function sourceFromRow(row: Row): SourceRef {
    if (text(row, "ref_kind") === "item") return { kind: "item", itemId: text(row, "ref_item") };
    return {
        kind: "event",
        harness: text(row, "harness") as Harness,
        sessionId: text(row, "session_id"),
        eventKey: text(row, "event_key"),
    };
}

function loadSources(store: Store, ids: string[]): Map<string, SourceRef[]> {
    const out = new Map<string, SourceRef[]>();
    if (ids.length === 0) return out;
    const rows = store.all(
        `SELECT * FROM item_sources WHERE item_id IN (SELECT value FROM json_each(?))
         ORDER BY item_id, seq`,
        JSON.stringify(ids),
    );
    for (const row of rows) {
        const id = text(row, "item_id");
        const list = out.get(id) ?? [];
        list.push(sourceFromRow(row));
        out.set(id, list);
    }
    return out;
}

function withSources(store: Store, rows: Row[]): Item[] {
    const sources = loadSources(
        store,
        rows.map((row) => text(row, "id")),
    );
    return rows.map((row) => itemFromRow(row, sources.get(text(row, "id")) ?? []));
}

export function getItem(store: Store, id: string): Item | null {
    const row = store.get("SELECT * FROM items WHERE id = ?", id);
    return row ? (withSources(store, [row])[0] ?? null) : null;
}

export interface ItemFilter {
    scope?: ItemScope;
    projectId?: string;
    status?: readonly ItemStatus[];
    kind?: readonly ItemKind[];
    origin?: ItemOrigin;
    branch?: string;
}

export function listItems(store: Store, filter: ItemFilter = {}): Item[] {
    const where: string[] = [];
    const params: Param[] = [];
    if (filter.scope) {
        where.push("scope = ?");
        params.push(filter.scope);
    }
    if (filter.projectId !== undefined) {
        where.push("project_id = ?");
        params.push(filter.projectId);
    }
    if (filter.status?.length) {
        where.push("status IN (SELECT value FROM json_each(?))");
        params.push(JSON.stringify(filter.status));
    }
    if (filter.kind?.length) {
        where.push("kind IN (SELECT value FROM json_each(?))");
        params.push(JSON.stringify(filter.kind));
    }
    if (filter.origin) {
        where.push("origin = ?");
        params.push(filter.origin);
    }
    if (filter.branch !== undefined) {
        where.push("branch = ?");
        params.push(filter.branch);
    }
    const sql = `SELECT * FROM items${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at, id`;
    return withSources(store, store.all(sql, ...params));
}

/** Insert or replace an item and its sources. Call it inside a transaction. */
export function putItem(store: Store, item: Item): void {
    store.run(
        `INSERT INTO items (id, scope, project_id, kind, title, body, branch, trust, status, origin,
            general, writer_harness, writer_session, idem_key, content_hash, created_run,
            updated_run, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            scope = excluded.scope, project_id = excluded.project_id, kind = excluded.kind,
            title = excluded.title, body = excluded.body, branch = excluded.branch,
            trust = excluded.trust, status = excluded.status, origin = excluded.origin,
            general = excluded.general, writer_harness = excluded.writer_harness,
            writer_session = excluded.writer_session, idem_key = excluded.idem_key,
            content_hash = excluded.content_hash, created_run = excluded.created_run,
            updated_run = excluded.updated_run, created_at = excluded.created_at,
            updated_at = excluded.updated_at`,
        item.id,
        item.scope,
        item.projectId,
        item.kind,
        item.title,
        item.body,
        item.branch,
        item.trust,
        item.status,
        item.origin,
        bit(item.general),
        item.writerHarness,
        item.writerSession,
        item.idemKey,
        item.contentHash,
        item.createdRun,
        item.updatedRun,
        item.createdAt,
        item.updatedAt,
    );
    store.run("DELETE FROM item_sources WHERE item_id = ?", item.id);
    item.sources.forEach((source, seq) => {
        if (source.kind === "item") {
            store.run(
                "INSERT INTO item_sources (item_id, seq, ref_kind, ref_item) VALUES (?, ?, 'item', ?)",
                item.id,
                seq,
                source.itemId,
            );
        } else {
            store.run(
                `INSERT INTO item_sources (item_id, seq, ref_kind, harness, session_id, event_key)
                 VALUES (?, ?, 'event', ?, ?, ?)`,
                item.id,
                seq,
                source.harness,
                source.sessionId,
                source.eventKey,
            );
        }
    });
}

export function deleteItem(store: Store, id: string): void {
    store.run("DELETE FROM items WHERE id = ?", id);
    store.run("DELETE FROM item_keys WHERE item_id = ?", id);
}

/** Record an item change for history and revert. `before` null means a new item. */
export function recordHistory(
    store: Store,
    runId: number,
    itemId: string,
    before: Item | null,
    after: Item | null,
): void {
    store.run(
        "INSERT INTO item_history (item_id, run_id, before, after, at) VALUES (?, ?, ?, ?, ?)",
        itemId,
        runId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        nowIso(),
    );
}

// ---------------------------------------------------------------------------------------------
// Runs

export type RunKind = "project" | "global" | "branches" | "note" | "forget" | "revert";
export type RunStatus = "running" | "ok" | "failed" | "reverted" | "skipped";

export interface RunRow {
    id: number;
    pass: string | null;
    kind: RunKind;
    projectId: string | null;
    trigger: string;
    model: string | null;
    status: RunStatus;
    startedAt: string;
    finishedAt: string | null;
    sessions: string[];
    warnings: string[];
    error: string | null;
    usage: Record<string, number> | null;
}

export function runFromRow(row: Row): RunRow {
    return {
        id: num(row, "id"),
        pass: textOrNull(row, "pass"),
        kind: text(row, "kind") as RunKind,
        projectId: textOrNull(row, "project_id"),
        trigger: text(row, "trigger"),
        model: textOrNull(row, "model"),
        status: text(row, "status") as RunStatus,
        startedAt: text(row, "started_at"),
        finishedAt: textOrNull(row, "finished_at"),
        sessions: jsonOr<string[]>(row, "sessions", []),
        warnings: jsonOr<string[]>(row, "warnings", []),
        error: textOrNull(row, "error"),
        usage: jsonOr<Record<string, number> | null>(row, "usage", null),
    };
}

export function startRun(
    store: Store,
    input: {
        pass?: string | null;
        kind: RunKind;
        projectId?: string | null;
        trigger: string;
        model?: string | null;
        sessions?: string[];
    },
): number {
    return store.run(
        `INSERT INTO runs (pass, kind, project_id, trigger, model, status, started_at, sessions)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
        input.pass ?? null,
        input.kind,
        input.projectId ?? null,
        input.trigger,
        input.model ?? null,
        nowIso(),
        JSON.stringify(input.sessions ?? []),
    ).lastId;
}

export function finishRun(
    store: Store,
    id: number,
    result: {
        status: RunStatus;
        warnings?: string[];
        error?: string | null;
        usage?: Record<string, number> | null;
        sessions?: string[];
    },
): void {
    const current = getRun(store, id);
    store.run(
        `UPDATE runs SET status = ?, finished_at = ?, warnings = ?, error = ?, usage = ?, sessions = ?
         WHERE id = ?`,
        result.status,
        nowIso(),
        JSON.stringify(result.warnings ?? current?.warnings ?? []),
        result.error ?? null,
        result.usage ? JSON.stringify(result.usage) : null,
        JSON.stringify(result.sessions ?? current?.sessions ?? []),
        id,
    );
}

export function getRun(store: Store, id: number): RunRow | null {
    const row = store.get("SELECT * FROM runs WHERE id = ?", id);
    return row ? runFromRow(row) : null;
}

export function listRuns(store: Store, limit = 20): RunRow[] {
    return store.all("SELECT * FROM runs ORDER BY id DESC LIMIT ?", limit).map(runFromRow);
}

/** Text form of an event source: `harness:session:eventKey`. */
export function sourceKey(source: SourceRef): string {
    return source.kind === "item"
        ? `item:${source.itemId}`
        : `${source.harness}:${source.sessionId}:${source.eventKey}`;
}
