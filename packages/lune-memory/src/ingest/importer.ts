import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { memoryPathTest } from "../adapters/common.ts";
import { ADAPTERS, AdapterFormatError, readSessionFile } from "../adapters/index.ts";
import type { ParseContext, SessionEvidence, SessionFileRef } from "../adapters/types.ts";
import type { MemoryConfig } from "../core/config.ts";
import type { MemoryPaths } from "../core/paths.ts";
import { HARNESSES, type EventRole, type Harness, type SessionRow } from "../core/types.ts";
import { errorMessage, nowIso, sha256 } from "../core/util.ts";
import type { ProjectResolver } from "../projects/resolver.ts";
import { bit, text, textOrNull, type Store } from "../store/db.ts";
import { getSession, liveProjectId, putSession } from "../store/rows.ts";
import { redact, safeErrorText } from "./redact.ts";
import { removeTranscript, writeSessionTranscript } from "./transcripts.ts";

export type FileOutcome = "imported" | "unchanged" | "skipped" | "error";

export interface ImportedSession {
    harness: Harness;
    id: string;
    projectId: string | null;
    revision: number;
    /** True when the content changed and the revision went up. */
    changed: boolean;
}

export interface ImportSummary {
    scanned: number;
    imported: number;
    unchanged: number;
    skipped: number;
    errors: number;
    purged: number;
    sessions: ImportedSession[];
    problems: Array<{ path: string; error: string }>;
}

export interface ImporterOptions {
    now?: () => number;
}

interface PreparedEvent {
    key: string;
    seq: number;
    role: EventRole;
    toolName: string | null;
    text: string;
    time: string | null;
    sourceLine: number;
    memoryDerived: boolean;
    untrusted: boolean;
    active: boolean;
    hash: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Events that Dreaming must read again after a revision deleted or moved events (§5). Such a
 * revision changes the context of the events around it, but no remaining event changed its text,
 * so the pass would not see it. A seam is a remaining event whose predecessor changed, or the new
 * last event when the earlier last event left. A new event needs no seam: it is unprocessed
 * already. The nearest event that is not memory-derived stands in for the seam, forward first,
 * because a pass never reads memory-derived events. `previous` holds the earlier event keys in
 * their earlier order.
 */
export function revisionSeams(
    previous: readonly string[],
    events: readonly Pick<PreparedEvent, "key" | "memoryDerived">[],
): string[] {
    const known = new Set(previous);
    const predecessor = new Map(previous.map((key, index) => [key, previous[index - 1] ?? null]));
    const anchors = new Set<number>();
    let prior: string | null = null;
    events.forEach((event, index) => {
        const moved = known.has(event.key) && predecessor.get(event.key) !== prior;
        if (moved && (prior === null || known.has(prior))) anchors.add(index);
        prior = event.key;
    });
    const last = events.at(-1);
    if (last && known.has(last.key) && previous.at(-1) !== last.key) anchors.add(events.length - 1);
    const seams = new Set<string>();
    for (const anchor of anchors) {
        const seam =
            events.slice(anchor).find((event) => !event.memoryDerived) ??
            events
                .slice(0, anchor)
                .reverse()
                .find((event) => !event.memoryDerived);
        if (seam) seams.add(seam.key);
    }
    return [...seams];
}

/** Hash of the parts of an event that matter for Dreaming. A changed hash means unprocessed. */
export function eventHash(event: {
    role: string;
    toolName: string | null;
    text: string;
    memoryDerived: boolean;
    untrusted: boolean;
    active: boolean;
}): string {
    return sha256(
        JSON.stringify([
            event.role,
            event.toolName ?? "",
            event.text,
            event.memoryDerived,
            event.untrusted,
            event.active,
        ]),
    );
}

function realpathOr(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** True when `path` is `dir` or below it. */
function isInside(dir: string, path: string): boolean {
    const rel = relative(dir, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function timeMs(value: string | null | undefined): number | null {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Continuous import. It reads native session files through the adapters, writes Session
 * Evidence to SQLite and writes L4 transcripts. Import makes no model call.
 */
export class Importer {
    private readonly store: Store;
    private readonly paths: MemoryPaths;
    private readonly config: MemoryConfig;
    private readonly resolver: ProjectResolver;
    private readonly now: () => number;
    private readonly parseContext: ParseContext;

    constructor(
        store: Store,
        paths: MemoryPaths,
        config: MemoryConfig,
        resolver: ProjectResolver,
        options: ImporterOptions = {},
    ) {
        this.store = store;
        this.paths = paths;
        this.config = config;
        this.resolver = resolver;
        this.now = options.now ?? Date.now;
        this.parseContext = {
            memoryPath: memoryPathTest([
                paths.views,
                paths.generations,
                paths.transcripts,
                paths.db,
            ]),
        };
    }

    /** Scan every enabled harness, import changed files and apply retention. */
    importAll(harnesses: readonly Harness[] = HARNESSES): ImportSummary {
        const summary: ImportSummary = {
            scanned: 0,
            imported: 0,
            unchanged: 0,
            skipped: 0,
            errors: 0,
            purged: 0,
            sessions: [],
            problems: [],
        };
        this.resolver.clearCache();
        for (const harness of harnesses) {
            const settings = this.config.harnesses[harness];
            if (!settings.enabled) continue;
            for (const ref of ADAPTERS[harness].discover(settings.root)) {
                summary.scanned++;
                const result = this.importFile(ref);
                summary[result.outcome === "error" ? "errors" : result.outcome]++;
                if (result.session) summary.sessions.push(result.session);
                if (result.error) summary.problems.push({ path: ref.path, error: result.error });
            }
        }
        summary.purged = this.purgeExpired();
        return summary;
    }

    /** Import one session file. A file with the same size and mtime as before is not read. */
    importFile(ref: SessionFileRef): {
        outcome: FileOutcome;
        session?: ImportedSession;
        error?: string;
    } {
        const known = this.store.get("SELECT * FROM source_files WHERE path = ?", ref.path);
        // A forgotten file stays forgotten, also when it changes later.
        if (known && text(known, "status") === "forgotten") return { outcome: "skipped" };
        if (
            known &&
            Number(known.size) === ref.size &&
            Number(known.mtime) === ref.mtimeMs &&
            text(known, "status") !== "pending"
        ) {
            return { outcome: "unchanged" };
        }
        let raw: string;
        try {
            raw = readSessionFile(ref.path);
        } catch (error) {
            const message = safeErrorText(error);
            this.recordFile(ref, null, textOrNull(known ?? {}, "session_id"), "error", message);
            return { outcome: "error", error: message };
        }
        const fileHash = sha256(raw);
        if (known && textOrNull(known, "fingerprint") === fileHash) {
            this.recordFile(
                ref,
                fileHash,
                textOrNull(known, "session_id"),
                text(known, "status"),
                textOrNull(known, "error"),
            );
            return { outcome: "unchanged" };
        }
        let evidence: SessionEvidence | null;
        try {
            evidence = ADAPTERS[ref.harness].parse(ref.path, raw, this.parseContext);
        } catch (error) {
            const message =
                error instanceof AdapterFormatError
                    ? `Unknown format: ${safeErrorText(error)}`
                    : safeErrorText(error);
            const sessionId = textOrNull(known ?? {}, "session_id");
            this.recordFile(ref, fileHash, sessionId, "error", message);
            if (sessionId) this.markSessionError(ref.harness, sessionId, message);
            return { outcome: "error", error: message };
        }
        if (!evidence) {
            this.recordFile(ref, fileHash, null, "skipped", null);
            return { outcome: "skipped" };
        }
        this.markMemoryHomeTools(evidence);
        if (this.isForgotten(evidence.harness, evidence.sessionId)) {
            this.recordFile(ref, fileHash, evidence.sessionId, "forgotten", null);
            return { outcome: "skipped" };
        }
        const owner = getSession(this.store, evidence.harness, evidence.sessionId);
        if (
            owner &&
            owner.sourcePath !== ref.path &&
            owner.sourceMtime > ref.mtimeMs &&
            existsSync(owner.sourcePath)
        ) {
            // Two files claim one session id. The newer file wins, so an old copy does not
            // roll the session back.
            this.recordFile(
                ref,
                fileHash,
                evidence.sessionId,
                "skipped",
                `Session ${evidence.sessionId} is also in ${owner.sourcePath}, which is newer`,
            );
            return { outcome: "skipped" };
        }
        try {
            const session = this.applyEvidence(evidence, ref, fileHash);
            return { outcome: "imported", session };
        } catch (error) {
            const message = safeErrorText(error);
            this.recordFile(ref, fileHash, evidence.sessionId, "error", message);
            return { outcome: "error", error: message };
        }
    }

    /**
     * A session that runs inside the memory home reads memory files by relative paths, such as
     * `views/projects/x/wiki/a.md`, that no path test can see. All its tool events are
     * memory-derived, so they never become evidence.
     */
    private markMemoryHomeTools(evidence: SessionEvidence): void {
        if (!evidence.cwd) return;
        const home = realpathOr(resolve(this.paths.home));
        const cwd = realpathOr(resolve(evidence.cwd));
        if (!isInside(home, cwd) && !isInside(resolve(this.paths.home), resolve(evidence.cwd))) {
            return;
        }
        for (const event of evidence.events) {
            if (event.role === "tool_call" || event.role === "tool_result") {
                event.memoryDerived = true;
            }
        }
    }

    /** True when the user forgot this session. Another copy of its file is not imported. */
    private isForgotten(harness: Harness, sessionId: string): boolean {
        return (
            this.store.get(
                `SELECT 1 AS n FROM source_files
                WHERE harness = ? AND session_id = ? AND status = 'forgotten' LIMIT 1`,
                harness,
                sessionId,
            ) !== undefined
        );
    }

    private recordFile(
        ref: SessionFileRef,
        fingerprint: string | null,
        sessionId: string | null,
        status: string,
        error: string | null,
    ): void {
        this.store.run(
            `INSERT INTO source_files(path, harness, size, mtime, fingerprint, session_id, status, error, checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET harness = excluded.harness, size = excluded.size,
                mtime = excluded.mtime, fingerprint = excluded.fingerprint,
                session_id = excluded.session_id, status = excluded.status,
                error = excluded.error, checked_at = excluded.checked_at`,
            ref.path,
            ref.harness,
            ref.size,
            ref.mtimeMs,
            fingerprint,
            sessionId,
            status,
            error,
            nowIso(this.now()),
        );
    }

    /** An unknown format on a known session: the session keeps its events and shows the error. */
    private markSessionError(harness: Harness, sessionId: string, message: string): void {
        this.store.run(
            "UPDATE sessions SET status = 'error', last_error = ? WHERE harness = ? AND id = ?",
            message,
            harness,
            sessionId,
        );
    }

    private prepareEvents(evidence: SessionEvidence): {
        events: PreparedEvent[];
        redactions: number;
    } {
        let redactions = 0;
        const seen = new Set<string>();
        const events: PreparedEvent[] = [];
        for (const event of evidence.events) {
            if (seen.has(event.key)) {
                evidence.warnings.push(`duplicate event key ${event.key}`);
                continue;
            }
            seen.add(event.key);
            const clean = redact(event.text);
            redactions += clean.count;
            const prepared = {
                key: event.key,
                seq: events.length,
                role: event.role,
                toolName: event.toolName ?? null,
                text: clean.text,
                time: event.time ?? null,
                sourceLine: event.sourceLine,
                memoryDerived: event.memoryDerived,
                untrusted: event.untrusted,
                active: event.active,
                hash: "",
            };
            prepared.hash = eventHash(prepared);
            events.push(prepared);
        }
        return { events, redactions };
    }

    private applyEvidence(
        evidence: SessionEvidence,
        ref: SessionFileRef,
        fileHash: string,
    ): ImportedSession {
        const now = this.now();
        const nowText = nowIso(now);
        const existing = getSession(this.store, evidence.harness, evidence.sessionId);
        const { events, redactions } = this.prepareEvents(evidence);
        const fingerprint = sha256(events.map((event) => `${event.key}=${event.hash}`).join("\n"));
        const changed = !existing || existing.fingerprint !== fingerprint;
        const revision = changed ? (existing?.revision ?? 0) + 1 : (existing?.revision ?? 1);

        const resolution = evidence.cwd ? this.resolver.resolve(evidence.cwd) : null;
        const previousProject = existing?.projectId
            ? liveProjectId(this.store, existing.projectId)
            : null;
        const projectId = resolution?.projectId ?? previousProject;
        // The harness record is best. A session that changed since the last import is active
        // now, so the branch of the work tree now is its branch: the user can have switched
        // branches before resuming it. For an unchanged session, a branch seen at an earlier
        // import is closer to its time than the branch now.
        const branch =
            evidence.branch ??
            (changed && existing ? resolution?.branch : null) ??
            existing?.branch ??
            resolution?.branch ??
            null;
        const title = evidence.title ? redact(evidence.title).text : null;

        let processedRevision = existing?.processedRevision ?? null;
        let markProcessed = false;
        if (!existing && this.config.dreaming.historyDays > 0) {
            const last = timeMs(evidence.updatedAt) ?? timeMs(evidence.startedAt) ?? ref.mtimeMs;
            if (now - last > this.config.dreaming.historyDays * DAY_MS) {
                // First-run history limit: an old session goes to L4 only.
                processedRevision = revision;
                markProcessed = true;
            }
        }

        const session: SessionRow = {
            harness: evidence.harness,
            id: evidence.sessionId,
            sourcePath: ref.path,
            sourceSize: ref.size,
            sourceMtime: ref.mtimeMs,
            fingerprint,
            revision,
            cwd: evidence.cwd ?? existing?.cwd ?? null,
            branch,
            projectId,
            title: title ?? existing?.title ?? null,
            startedAt: evidence.startedAt ?? existing?.startedAt ?? null,
            updatedAt: evidence.updatedAt ?? existing?.updatedAt ?? null,
            changedAt: changed ? nowText : (existing?.changedAt ?? nowText),
            importedAt: nowText,
            transcriptPath: existing?.transcriptPath ?? null,
            status: "ok",
            lastError: null,
            attempts: existing?.attempts ?? 0,
            attemptRevision: existing?.attemptRevision ?? null,
            processedRevision,
            warnings: evidence.warnings.slice(0, 100),
            filtered: evidence.filtered,
            redactions,
        };

        this.store.tx(() => {
            const previous = changed && existing ? this.eventKeys(session) : [];
            putSession(this.store, session);
            for (const event of events) {
                this.store.run(
                    `INSERT INTO events(harness, session_id, key, seq, role, tool_name, text, time,
                        source_line, transcript_line, memory_derived, untrusted, active, hash,
                        processed_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
                    ON CONFLICT(harness, session_id, key) DO UPDATE SET
                        seq = excluded.seq, role = excluded.role, tool_name = excluded.tool_name,
                        text = excluded.text, time = excluded.time,
                        source_line = excluded.source_line,
                        memory_derived = excluded.memory_derived,
                        untrusted = excluded.untrusted, active = excluded.active,
                        hash = excluded.hash,
                        processed_chars = CASE WHEN events.hash = excluded.hash
                            THEN events.processed_chars ELSE NULL END
                    WHERE events.hash != excluded.hash OR events.seq != excluded.seq
                        OR events.source_line IS NOT excluded.source_line
                        OR events.time IS NOT excluded.time`,
                    session.harness,
                    session.id,
                    event.key,
                    event.seq,
                    event.role,
                    event.toolName,
                    event.text,
                    event.time,
                    event.sourceLine,
                    bit(event.memoryDerived),
                    bit(event.untrusted),
                    bit(event.active),
                    event.hash,
                    markProcessed ? event.hash : null,
                );
            }
            this.removeVanishedEvents(session, events, nowText);
            if (!markProcessed) this.markSeams(session, revisionSeams(previous, events));
            if (projectId && branch) {
                this.store.run(
                    "INSERT OR IGNORE INTO branches(project_id, name, status, first_seen) VALUES (?, ?, 'open', ?)",
                    projectId,
                    branch,
                    nowText,
                );
            }
            this.recordFile(ref, fileHash, session.id, "ok", null);
        });

        try {
            writeSessionTranscript(this.store, this.paths, session);
        } catch (error) {
            this.store.run(
                "UPDATE sessions SET warnings = json_insert(warnings, '$[#]', ?) WHERE harness = ? AND id = ?",
                `transcript not written: ${errorMessage(error)}`,
                session.harness,
                session.id,
            );
        }
        return { harness: session.harness, id: session.id, projectId, revision, changed };
    }

    /** Event keys of a session in their stored order. */
    private eventKeys(session: SessionRow): string[] {
        return this.store
            .all(
                "SELECT key FROM events WHERE harness = ? AND session_id = ? ORDER BY seq",
                session.harness,
                session.id,
            )
            .map((row) => text(row, "key"));
    }

    /** Mark the seam events of a revision unprocessed, so the next pass reads them again. */
    private markSeams(session: SessionRow, keys: readonly string[]): void {
        if (!keys.length) return;
        this.store.run(
            `UPDATE events SET processed_hash = NULL, processed_chars = NULL
            WHERE harness = ? AND session_id = ? AND key IN (SELECT value FROM json_each(?))`,
            session.harness,
            session.id,
            JSON.stringify(keys),
        );
    }

    /**
     * Delete events that are no longer in the session file. An item whose event sources are all
     * gone becomes source-missing. An item that keeps at least one source stays as it is.
     */
    private removeVanishedEvents(session: SessionRow, events: PreparedEvent[], at: string): void {
        const keys = JSON.stringify(events.map((event) => event.key));
        const vanished = this.store.all(
            "SELECT key FROM events WHERE harness = ? AND session_id = ? AND key NOT IN (SELECT value FROM json_each(?))",
            session.harness,
            session.id,
            keys,
        );
        if (vanished.length === 0) return;
        this.store.run(
            "DELETE FROM events WHERE harness = ? AND session_id = ? AND key NOT IN (SELECT value FROM json_each(?))",
            session.harness,
            session.id,
            keys,
        );
        this.store.run(
            `UPDATE items SET status = 'source-missing', updated_at = ?
            WHERE status IN ('active', 'provisional')
                AND id IN (
                    SELECT item_id FROM item_sources
                    WHERE ref_kind = 'event' AND harness = ? AND session_id = ?
                        AND event_key IN (SELECT value FROM json_each(?))
                )
                AND NOT EXISTS (
                    SELECT 1 FROM item_sources s JOIN events e
                        ON e.harness = s.harness AND e.session_id = s.session_id
                            AND e.key = s.event_key
                    WHERE s.item_id = items.id AND s.ref_kind = 'event'
                )`,
            at,
            session.harness,
            session.id,
            JSON.stringify(vanished.map((row) => text(row, "key"))),
        );
    }

    /**
     * Retention: delete sessions, events and transcripts older than `retentionDays`. The source
     * file record stays, so an unchanged file is not imported again. Items stay: they were
     * checked against the evidence when they were committed.
     */
    purgeExpired(): number {
        const days = this.config.retentionDays;
        if (!(days > 0)) return 0;
        const cutoff = nowIso(this.now() - days * DAY_MS);
        const rows = this.store.all(
            "SELECT harness, id, transcript_path FROM sessions WHERE COALESCE(updated_at, changed_at) < ?",
            cutoff,
        );
        for (const row of rows) {
            this.store.run(
                "DELETE FROM sessions WHERE harness = ? AND id = ?",
                text(row, "harness"),
                text(row, "id"),
            );
            const transcript = textOrNull(row, "transcript_path");
            if (transcript) removeTranscript(transcript);
        }
        return rows.length;
    }
}
