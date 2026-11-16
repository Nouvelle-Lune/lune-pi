import { MemoryOperationError } from "../core/errors.ts";
import type { MemoryPaths } from "../core/paths.ts";
import { isHarness, type Harness, type Item, type SourceRef } from "../core/types.ts";
import { errorMessage, nowIso } from "../core/util.ts";
import { removeTranscript } from "../ingest/transcripts.ts";
import { num, text, textOrNull, type Store } from "../store/db.ts";
import {
    deleteItem,
    finishRun,
    getItem,
    getRun,
    getSession,
    putItem,
    recordHistory,
    startRun,
    type RunRow,
} from "../store/rows.ts";
import { regenerateProjection } from "./projection.ts";

/** Run kinds that change items and that a revert can undo. */
const REVERTIBLE_KINDS = new Set(["project", "global", "branches", "note"]);

export interface RevertOptions {
    /**
     * Mark the sessions of the run unprocessed, so the next pass reads them again. The default
     * is false: a reverted pass usually was wrong, and the same input can give the same result.
     */
    reprocess?: boolean;
    /** Generations of the projection to keep. */
    generations: number;
    now?: () => number;
}

export interface RevertResult {
    /** The reverted run. */
    runId: number;
    /** The run that records the revert. */
    revertRun: number;
    /** Items that were restored or deleted. */
    items: number;
    /** Sessions that were marked unprocessed. */
    reprocessed: number;
    /** Set when the Markdown views could not show the revert. The revert itself is done. */
    projectionError?: string;
}

/**
 * Undo the item changes of one run (the way back of §10). The items return to their state
 * before the run: a created item is deleted, and a changed or retired item gets its earlier
 * state back. A revert is refused when a later run that is not reverted changed one of the same
 * items, because the restore would silently drop that later change. Revert the later run first.
 */
export function revertRun(
    store: Store,
    paths: MemoryPaths,
    runId: number,
    options: RevertOptions,
): RevertResult {
    const now = options.now ?? Date.now;
    const result = store.tx(() => {
        const run = getRun(store, runId);
        if (!run) throw new MemoryOperationError(`Run ${runId} not found`);
        if (!REVERTIBLE_KINDS.has(run.kind)) {
            throw new MemoryOperationError(`A ${run.kind} run cannot be reverted`);
        }
        if (run.status !== "ok") {
            throw new MemoryOperationError(`Run ${runId} is ${run.status}, not ok`);
        }
        const later = store.all(
            `SELECT DISTINCT h.item_id, h.run_id FROM item_history h JOIN runs r ON r.id = h.run_id
            WHERE h.run_id > ? AND r.kind != 'revert' AND r.status != 'reverted'
                AND h.item_id IN (SELECT item_id FROM item_history WHERE run_id = ?)
            ORDER BY h.run_id`,
            runId,
            runId,
        );
        if (later.length > 0) {
            const runs = [...new Set(later.map((row) => num(row, "run_id")))];
            throw new MemoryOperationError(
                `Later runs changed the same items: ${runs.join(", ")}. Revert them first.`,
            );
        }
        const history = store.all(
            "SELECT item_id, before FROM item_history WHERE run_id = ? ORDER BY id DESC",
            runId,
        );
        const revertId = startRun(store, {
            kind: "revert",
            projectId: run.projectId,
            trigger: "manual",
            sessions: run.sessions,
        });
        const touched = new Set<string>();
        for (const row of history) {
            const itemId = text(row, "item_id");
            const beforeText = textOrNull(row, "before");
            const current = getItem(store, itemId);
            const restored = beforeText ? (JSON.parse(beforeText) as Item) : null;
            if (restored) putItem(store, restored);
            else if (current) deleteItem(store, itemId);
            // Several history rows for one item: the oldest row runs last and wins.
            touched.add(itemId);
            recordHistory(store, revertId, itemId, current, restored);
        }
        store.run("DELETE FROM item_keys WHERE run_id = ?", runId);
        store.run("UPDATE branches SET handled_run = NULL WHERE handled_run = ?", runId);
        let reprocessed = 0;
        if (options.reprocess) reprocessed = markUnprocessed(store, run);
        store.run("UPDATE runs SET status = 'reverted' WHERE id = ?", runId);
        finishRun(store, revertId, {
            status: "ok",
            warnings: [`reverted run ${runId} (${run.kind})`],
        });
        return { runId, revertRun: revertId, items: touched.size, reprocessed };
    });
    return withViews(result, store, paths, options.generations, now);
}

/**
 * Write the views after a committed change. A failure does not undo the change, so the caller
 * does not try it again: the result gets the error, and the memory service repairs the views.
 */
function withViews<T extends object>(
    result: T,
    store: Store,
    paths: MemoryPaths,
    generations: number,
    now: () => number,
): T & { projectionError?: string } {
    try {
        regenerateProjection(store, paths, { generations }, { now });
        return result;
    } catch (error) {
        return { ...result, projectionError: errorMessage(error) || "unknown error" };
    }
}

/** Clear the processed marks of the sessions of a run. Returns the number of sessions. */
function markUnprocessed(store: Store, run: RunRow): number {
    let count = 0;
    for (const label of run.sessions) {
        const parsed = parseSessionLabel(label);
        if (!parsed) continue;
        const changes = store.run(
            `UPDATE sessions SET processed_revision = NULL, attempts = 0, attempt_revision = NULL,
                last_error = NULL
            WHERE harness = ? AND id = ?`,
            parsed.harness,
            parsed.id,
        ).changes;
        store.run(
            "UPDATE events SET processed_hash = NULL, processed_chars = NULL WHERE harness = ? AND session_id = ?",
            parsed.harness,
            parsed.id,
        );
        count += changes;
    }
    return count;
}

/** Parse a `harness:id` session label. */
export function parseSessionLabel(label: string): { harness: Harness; id: string } | null {
    const at = label.indexOf(":");
    if (at <= 0) return null;
    const harness = label.slice(0, at);
    const id = label.slice(at + 1);
    if (!isHarness(harness) || !id) return null;
    return { harness, id };
}

export interface ForgetOptions {
    generations: number;
    now?: () => number;
}

export interface ForgetResult {
    harness: Harness;
    sessionId: string;
    runId: number;
    /** Items that lost sources but kept others. */
    updated: number;
    /** Items that had no source left and were retired. */
    retired: number;
    /**
     * Set when the Markdown views could not drop the session. The session is gone from SQLite,
     * and the memory service writes the views again later.
     */
    projectionError?: string;
}

/**
 * Forget one session: delete its events and transcript, and stop importing its file again.
 * Items keep their other sources. An item that rests only on the forgotten session is retired,
 * so its conclusion no longer reaches L1, L2 or L3. Item history stays, so the audit trail stays.
 */
export function forgetSession(
    store: Store,
    paths: MemoryPaths,
    harness: Harness,
    sessionId: string,
    options: ForgetOptions,
): ForgetResult {
    const now = options.now ?? Date.now;
    const { result, transcript } = store.tx(() => {
        const session = getSession(store, harness, sessionId);
        if (!session) throw new MemoryOperationError(`Session ${harness}:${sessionId} not found`);
        const label = `${harness}:${sessionId}`;
        const runId = startRun(store, {
            kind: "forget",
            projectId: session.projectId,
            trigger: "manual",
            sessions: [label],
        });
        const at = nowIso(now());
        const cited = store.all(
            `SELECT DISTINCT item_id FROM item_sources
            WHERE ref_kind = 'event' AND harness = ? AND session_id = ?`,
            harness,
            sessionId,
        );
        const written = store.all(
            "SELECT id AS item_id FROM items WHERE writer_harness = ? AND writer_session = ?",
            harness,
            sessionId,
        );
        const ids = new Set([...cited, ...written].map((row) => text(row, "item_id")));
        let updated = 0;
        let retired = 0;
        for (const id of ids) {
            const before = getItem(store, id);
            if (!before) continue;
            const sources = before.sources.filter((source) => !citesSession(source, label));
            const dropped = sources.length !== before.sources.length;
            const orphan = sources.length === 0 && before.status !== "retired";
            if (!dropped && !orphan) continue;
            const after: Item = {
                ...before,
                sources,
                status: orphan ? "retired" : before.status,
                updatedRun: runId,
                updatedAt: at,
            };
            putItem(store, after);
            recordHistory(store, runId, id, before, after);
            if (orphan) retired++;
            else updated++;
        }
        store.run(
            `INSERT INTO source_files(path, harness, size, mtime, fingerprint, session_id, status, error, checked_at)
            VALUES (?, ?, ?, ?, ?, ?, 'forgotten', NULL, ?)
            ON CONFLICT(path) DO UPDATE SET session_id = excluded.session_id,
                status = 'forgotten', error = NULL, checked_at = excluded.checked_at`,
            session.sourcePath,
            harness,
            session.sourceSize,
            session.sourceMtime,
            session.fingerprint,
            sessionId,
            at,
        );
        store.run(
            `UPDATE source_files SET status = 'forgotten', error = NULL, checked_at = ?
            WHERE harness = ? AND session_id = ?`,
            at,
            harness,
            sessionId,
        );
        store.run("DELETE FROM sessions WHERE harness = ? AND id = ?", harness, sessionId);
        finishRun(store, runId, { status: "ok", warnings: [`forgot ${label}`] });
        return {
            result: { harness, sessionId, runId, updated, retired },
            transcript: session.transcriptPath,
        };
    });
    if (transcript) removeTranscript(transcript);
    return withViews(result, store, paths, options.generations, now);
}

function citesSession(source: SourceRef, label: string): boolean {
    return source.kind === "event" && `${source.harness}:${source.sessionId}` === label;
}
