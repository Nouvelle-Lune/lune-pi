import { MemoryOperationError } from "../core/errors.ts";
import type { EventRole, Harness } from "../core/types.ts";
import { num, text, textOrNull, type Param, type Row, type Store } from "../store/db.ts";
import { eventFromRow, liveProjectId } from "../store/rows.ts";

/** Default and largest number of hits of one search. */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

/** A text of this length or less is returned whole. A longer text gives a window. */
const WHOLE_TEXT_LIMIT = 800;
/** Characters before and after the first match in an excerpt window. */
const EXCERPT_RADIUS = 300;
/** Largest text of one context event. */
const CONTEXT_LIMIT = 300;
/** Largest number of context events on each side of a hit. */
const MAX_CONTEXT = 5;

export interface SearchOptions {
    query: string;
    projectId?: string | null;
    harness?: Harness | null;
    sessionId?: string | null;
    /** ISO time. Only events at or after this time. */
    since?: string | null;
    /** ISO time. Only events before this time. */
    until?: string | null;
    limit?: number | null;
    /** Memory-derived events are not evidence, so they are left out unless this is true. */
    includeMemoryDerived?: boolean | null;
    /** Events before and after each hit, by sequence. Default 1. */
    context?: number | null;
}

export interface SearchContextEvent {
    eventKey: string;
    seq: number;
    role: EventRole;
    toolName: string | null;
    time: string | null;
    text: string;
    truncated: boolean;
    untrusted: boolean;
    memoryDerived: boolean;
    active: boolean;
}

export interface SearchHit {
    harness: Harness;
    sessionId: string;
    eventKey: string;
    seq: number;
    role: EventRole;
    toolName: string | null;
    time: string | null;
    projectId: string | null;
    branch: string | null;
    title: string | null;
    /** A verbatim part of the event text. */
    excerpt: string;
    /** Start and end offset of the excerpt in the event text, in UTF-16 code units. */
    excerptStart: number;
    excerptEnd: number;
    textLength: number;
    before: SearchContextEvent[];
    after: SearchContextEvent[];
    transcriptPath: string | null;
    transcriptLine: number | null;
    sourcePath: string;
    sourceLine: number | null;
    untrusted: boolean;
    memoryDerived: boolean;
    active: boolean;
    /** BM25 rank. A lower value is a better match. Null for a substring-only search. */
    rank: number | null;
}

export interface SearchResult {
    query: string;
    terms: string[];
    hits: SearchHit[];
    /** True when the limit stopped the search, so more hits can exist. */
    limited: boolean;
}

/** Split a query into terms. Text in double quotes is one term. */
export function queryTerms(query: string): string[] {
    const terms: string[] = [];
    for (const match of query.matchAll(/"([^"]+)"|(\S+)/gu)) {
        const term = (match[1] ?? match[2] ?? "").trim();
        if (term && !terms.includes(term)) terms.push(term);
    }
    return terms;
}

function charLength(value: string): number {
    return [...value].length;
}

/** An FTS5 phrase for one term. The trigram tokenizer needs three or more characters. */
function ftsPhrase(term: string): string {
    return `"${term.replaceAll('"', '""')}"`;
}

function likePattern(term: string): string {
    return `%${term.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
}

function normalizeTime(value: string | null | undefined, name: string): string | null {
    if (!value) return null;
    const time = Date.parse(value);
    if (Number.isNaN(time)) throw new MemoryOperationError(`${name} is not a valid time: ${value}`);
    return new Date(time).toISOString();
}

function clampInt(value: number | null | undefined, fallback: number, min: number, max: number) {
    if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Offset of the first match of any term in `body`, case-insensitive. */
function firstMatch(body: string, terms: string[]): number {
    const lower = body.toLowerCase();
    let best = -1;
    for (const term of terms) {
        const index = lower.indexOf(term.toLowerCase());
        if (index >= 0 && (best < 0 || index < best)) best = index;
    }
    return best;
}

/** Move an offset off the second half of a surrogate pair. */
function safeOffset(body: string, offset: number): number {
    const code = body.charCodeAt(offset);
    return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}

/** A verbatim window of the event text around the first match. */
export function excerptOf(body: string, terms: string[]): { start: number; end: number } {
    if (body.length <= WHOLE_TEXT_LIMIT) return { start: 0, end: body.length };
    const match = Math.max(0, firstMatch(body, terms));
    const start = safeOffset(body, Math.max(0, match - EXCERPT_RADIUS));
    const end = safeOffset(body, Math.min(body.length, match + EXCERPT_RADIUS));
    return { start, end: Math.max(end, start) };
}

function contextEvent(row: Row): SearchContextEvent {
    const event = eventFromRow(row);
    const truncated = event.text.length > CONTEXT_LIMIT;
    return {
        eventKey: event.key,
        seq: event.seq,
        role: event.role,
        toolName: event.toolName,
        time: event.time,
        text: truncated ? event.text.slice(0, safeOffset(event.text, CONTEXT_LIMIT)) : event.text,
        truncated,
        untrusted: event.untrusted,
        memoryDerived: event.memoryDerived,
        active: event.active,
    };
}

/**
 * Full-text search over the L4 evidence of all sessions. Terms of three or more characters use
 * the FTS5 trigram index and BM25 rank. Shorter terms use a substring match. Each hit has a
 * verbatim excerpt, the events around it and the locations of the transcript and the source.
 */
export function transcriptSearch(store: Store, options: SearchOptions): SearchResult {
    const query = options.query.trim();
    const terms = queryTerms(query);
    if (terms.length === 0) throw new MemoryOperationError("The search query is empty");
    const limit = clampInt(options.limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
    const context = clampInt(options.context, 1, 0, MAX_CONTEXT);
    const since = normalizeTime(options.since, "since");
    const until = normalizeTime(options.until, "until");

    const ftsTerms = terms.filter((term) => charLength(term) >= 3);
    const likeTerms = terms.filter((term) => charLength(term) < 3);
    const where: string[] = [];
    const params: Param[] = [];
    if (ftsTerms.length > 0) {
        where.push("events_fts MATCH ?");
        params.push(ftsTerms.map(ftsPhrase).join(" "));
    }
    for (const term of likeTerms) {
        where.push("e.text LIKE ? ESCAPE '\\'");
        params.push(likePattern(term));
    }
    if (options.projectId) {
        where.push("s.project_id = ?");
        params.push(liveProjectId(store, options.projectId));
    }
    if (options.harness) {
        where.push("e.harness = ?");
        params.push(options.harness);
    }
    if (options.sessionId) {
        where.push("e.session_id = ?");
        params.push(options.sessionId);
    }
    if (since) {
        where.push("COALESCE(e.time, s.updated_at, s.changed_at) >= ?");
        params.push(since);
    }
    if (until) {
        where.push("COALESCE(e.time, s.updated_at, s.changed_at) < ?");
        params.push(until);
    }
    if (!options.includeMemoryDerived) where.push("e.memory_derived = 0");

    const select = `SELECT e.*, s.project_id AS s_project, s.branch AS s_branch, s.title AS s_title,
        s.source_path AS s_source, s.transcript_path AS s_transcript`;
    const sessionJoin = "JOIN sessions s ON s.harness = e.harness AND s.id = e.session_id";
    const sql =
        ftsTerms.length > 0
            ? `${select}, f.rank AS s_rank FROM events_fts f JOIN events e ON e.id = f.rowid
               ${sessionJoin} WHERE ${where.join(" AND ")} ORDER BY f.rank LIMIT ?`
            : `${select}, NULL AS s_rank FROM events e ${sessionJoin}
               WHERE ${where.join(" AND ")}
               ORDER BY COALESCE(e.time, s.updated_at, s.changed_at) DESC, e.seq DESC LIMIT ?`;
    const rows = store.all(sql, ...params, limit + 1);
    const limited = rows.length > limit;

    const hits = rows.slice(0, limit).map((row): SearchHit => {
        const event = eventFromRow(row);
        const window = excerptOf(event.text, terms);
        const neighbors =
            context > 0
                ? store.all(
                      `SELECT * FROM events WHERE harness = ? AND session_id = ?
                       AND seq BETWEEN ? AND ? AND seq != ? ORDER BY seq`,
                      event.harness,
                      event.sessionId,
                      event.seq - context,
                      event.seq + context,
                      event.seq,
                  )
                : [];
        const rank = row.s_rank;
        return {
            harness: event.harness,
            sessionId: event.sessionId,
            eventKey: event.key,
            seq: event.seq,
            role: event.role,
            toolName: event.toolName,
            time: event.time,
            projectId: textOrNull(row, "s_project"),
            branch: textOrNull(row, "s_branch"),
            title: textOrNull(row, "s_title"),
            excerpt: event.text.slice(window.start, window.end),
            excerptStart: window.start,
            excerptEnd: window.end,
            textLength: event.text.length,
            before: neighbors.filter((n) => num(n, "seq") < event.seq).map(contextEvent),
            after: neighbors.filter((n) => num(n, "seq") > event.seq).map(contextEvent),
            transcriptPath: textOrNull(row, "s_transcript"),
            transcriptLine: event.transcriptLine,
            sourcePath: text(row, "s_source"),
            sourceLine: event.sourceLine,
            untrusted: event.untrusted,
            memoryDerived: event.memoryDerived,
            active: event.active,
            rank: typeof rank === "number" ? rank : null,
        };
    });
    return { query, terms, hits, limited };
}
