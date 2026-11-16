import type { DreamingConfig } from "../core/config.ts";
import type { EventRow, Item, SessionRow } from "../core/types.ts";
import type { Store } from "../store/db.ts";
import { getItem, listEvents, listItems, liveProjectId, sessionFromRow } from "../store/rows.ts";
import { liveEvents, sessionSources, uniqueEvents } from "./evidence.ts";

/** Earlier events that the Analyzer sees before the first new event, for continuity. */
const LEAD_IN_EVENTS = 3;
const LEAD_IN_CHARS = 1500;
/** Characters of one memory-derived context event. It is not evidence, so a short view is enough. */
const MEMORY_CONTEXT_CHARS = 600;
/** Earlier Dreaming items of one session that the Analyzer sees at most. */
const EARLIER_ITEMS = 40;
/** Remaining source events of items under review that the Analyzer sees at most, and their size. */
const REVIEW_EVENTS = 6;
const REVIEW_CHARS = 800;

/** Analyzed part of one new event. */
export interface Coverage {
    /** Hash of the text that the Analyzer saw. */
    hash: string;
    /**
     * Cursor after the pass, in UTF-16 code units of the text. Null when the Analyzer saw the
     * event to its end.
     */
    end: number | null;
}

/** Role of one event in an Analyzer input. */
export type SnapshotEventRole = "new" | "context" | "memory";

export interface SnapshotEvent {
    event: EventRow;
    role: SnapshotEventRole;
    /** Event text for the model. It can be shorter than the stored text. */
    text: string;
    truncated: boolean;
}

/**
 * One session revision, fixed at pass start. The pass works on this view, so a change of the
 * source during the pass does not mix two revisions in one batch.
 */
export interface SessionSnapshot {
    session: SessionRow;
    /** Live project of the session. Null outside a project. */
    projectId: string | null;
    revision: number;
    /** Events for the Analyzer, in session order. */
    events: SnapshotEvent[];
    /** New events that the Analyzer sees, by key. Commit marks them processed or moves their cursor. */
    covered: Map<string, Coverage>;
    /** True when the Analyzer sees all unprocessed text of the revision. */
    complete: boolean;
    /** Provisional notes that this session reviews. */
    notes: Item[];
    /** Earlier Dreaming items that cite this session. */
    earlier: Item[];
    /**
     * Ids of earlier project items that lost evidence in this session: a cited event is gone or
     * left the active path. The Analyzer reviews them, and commit retires the unsupported ones.
     */
    review: Set<string>;
}

export interface EligibilityOptions {
    now?: number;
    /** Manual trigger: ignore the idle threshold and the attempt limit. */
    force?: boolean;
    /** Only sessions of this project. */
    projectId?: string | null;
    /** Only these sessions, as `harness:id`. */
    sessions?: string[];
}

export interface EligibilityResult {
    /** Sessions to analyze, at most `maxSessionsPerPass`. */
    eligible: SessionSnapshot[];
    /** Sessions whose changes hold no evidence. They need no model call. */
    trivial: SessionRow[];
    /** Eligible sessions over the pass budget. They wait for the next pass. */
    deferred: number;
    /** Sessions with unprocessed events that are not idle yet. */
    waiting: number;
    /** Sessions that reached the attempt limit for their revision. */
    stopped: number;
}

/**
 * True when an event is evidence that Dreaming has not processed in its current form. An event
 * off the active conversation path is pending too: Dreaming decides what an abandoned branch
 * leaves (§4). Its hash covers the active flag, so an event that leaves the path is new again.
 */
export function isPending(event: EventRow): boolean {
    return !event.memoryDerived && event.processedHash !== event.hash;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
    if (text.length <= limit) return { text, truncated: false };
    return {
        text: `${text.slice(0, limit)}\n[truncated: ${text.length - limit} more characters]`,
        truncated: true,
    };
}

/** End of a text part that does not split a surrogate pair. */
function safeEnd(text: string, end: number): number {
    if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length));
    const code = text.charCodeAt(end - 1);
    return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/**
 * Next part of a pending event, at most `limit` characters from its cursor. A long event is
 * analyzed in parts over several passes, so its end is not lost (§5).
 */
function eventWindow(
    event: EventRow,
    limit: number,
): { text: string; truncated: boolean; end: number } {
    const length = event.text.length;
    const start = Math.min(Math.max(event.processedChars ?? 0, 0), length);
    const end = safeEnd(event.text, start + limit);
    let text = event.text.slice(start, end);
    if (start > 0) {
        text = `[continued: the first ${start} characters were analyzed in an earlier pass]\n${text}`;
    }
    const rest = length - end;
    if (rest > 0) text += `\n[truncated: ${rest} more characters follow in a later pass]`;
    return { text, truncated: start > 0 || rest > 0, end };
}

function candidates(store: Store): SessionRow[] {
    return store
        .all(
            `SELECT * FROM sessions WHERE status = 'ok' AND (
                processed_revision IS NULL OR processed_revision < revision
                OR EXISTS (
                    SELECT 1 FROM events e
                    WHERE e.harness = sessions.harness AND e.session_id = sessions.id
                    AND e.memory_derived = 0
                    AND (e.processed_hash IS NULL OR e.processed_hash != e.hash)
                )
            ) ORDER BY changed_at, harness, id`,
        )
        .map(sessionFromRow);
}

/**
 * Select the Analyzer events of one session. The first new event is always in, cut to the
 * budget when it alone is too long. The other new events go in while the budget lasts. Each new
 * event shows the part after its cursor, so a later pass continues where this one stops.
 */
function selectEvents(
    events: EventRow[],
    maxChars: number,
): { events: SnapshotEvent[]; covered: Map<string, Coverage>; complete: boolean } {
    const active = events.filter((event) => event.active);
    const pending = events.filter(isPending);
    const perEvent = Math.max(2000, Math.floor(maxChars / 4));
    const chosen: SnapshotEvent[] = [];
    const covered = new Map<string, Coverage>();
    let used = 0;
    let last = -1;
    let complete = true;
    for (const event of pending) {
        const limit = chosen.length === 0 ? Math.min(perEvent, maxChars) : perEvent;
        const { end, ...view } = eventWindow(event, limit);
        if (chosen.length > 0 && used + view.text.length > maxChars) {
            complete = false;
            break;
        }
        chosen.push({ event, role: "new", ...view });
        const done = end >= event.text.length;
        covered.set(event.key, { hash: event.hash, end: done ? null : end });
        if (!done) complete = false;
        used += view.text.length;
        last = event.seq;
    }
    const first = chosen[0]?.event.seq ?? -1;
    const result: SnapshotEvent[] = [...chosen];
    if (first >= 0) {
        const before = active
            .filter((event) => event.seq < first && !event.memoryDerived)
            .slice(-LEAD_IN_EVENTS);
        for (const event of before) {
            result.push({ event, role: "context", ...truncate(event.text, LEAD_IN_CHARS) });
        }
        for (const event of events) {
            if (event.memoryDerived && event.seq > first && event.seq < last) {
                result.push({
                    event,
                    role: "memory",
                    ...truncate(event.text, MEMORY_CONTEXT_CHARS),
                });
            }
        }
    }
    result.sort((a, b) => a.event.seq - b.event.seq);
    return { events: result, covered, complete };
}

/**
 * Earlier Dreaming items that cite one session. A project item of `projectId` that cites an
 * event of the session that can no longer support it goes to review and comes first: the event
 * is gone, came from lune-memory itself, or left the active path while the item kind needs the
 * current state (§4). Its conclusion may rest on text that no longer exists in that form (§5).
 * The remaining source events of reviewed items in the session come back as context.
 */
function earlierItems(
    store: Store,
    session: SessionRow,
    projectId: string | null,
): { items: Item[]; review: Set<string>; context: EventRow[] } {
    const ids = store
        .all(
            `SELECT DISTINCT item_id FROM item_sources
            WHERE ref_kind = 'event' AND harness = ? AND session_id = ?`,
            session.harness,
            session.id,
        )
        .map((row) => String(row.item_id));
    const items: Item[] = [];
    const live = new Map<string, EventRow[]>();
    for (const id of ids) {
        const item = getItem(store, id);
        if (!item || item.origin !== "dreaming") continue;
        if (item.status !== "active" && item.status !== "provisional") continue;
        items.push(item);
        if (item.status !== "active" || item.projectId === null) continue;
        if (item.scope !== "project" || item.projectId !== projectId) continue;
        const cited = sessionSources(item.sources, session);
        const events = liveEvents(store, cited, undefined, item.kind);
        if (events.length < cited.length) live.set(item.id, events);
    }
    items.sort(
        (a, b) =>
            Number(live.has(b.id)) - Number(live.has(a.id)) ||
            b.updatedAt.localeCompare(a.updatedAt),
    );
    const shown = items.slice(0, EARLIER_ITEMS);
    const review = new Set(shown.filter((item) => live.has(item.id)).map((item) => item.id));
    const context = uniqueEvents([...review].flatMap((id) => live.get(id) ?? []));
    return { items: shown, review, context: context.slice(0, REVIEW_EVENTS) };
}

/**
 * Provisional notes that a session reviews: the notes it wrote, and notes without a writer
 * session whose title appears in its new events.
 */
function reviewNotes(
    store: Store,
    session: SessionRow,
    projectId: string | null,
    events: SnapshotEvent[],
): Item[] {
    const notes = listItems(store, {
        origin: "agent_note",
        status: ["provisional"],
        ...(projectId ? { projectId } : { scope: "global" as const }),
    });
    const texts = events.filter((entry) => entry.role === "new").map((entry) => entry.event.text);
    return notes.filter((note) => {
        if (note.writerSession) {
            return note.writerSession === session.id && note.writerHarness === session.harness;
        }
        return texts.some((value) => value.includes(note.title));
    });
}

/** Build the fixed view of one session revision. */
export function snapshotSession(
    store: Store,
    session: SessionRow,
    config: Pick<DreamingConfig, "maxCharsPerSession">,
): SessionSnapshot {
    const projectId = session.projectId ? liveProjectId(store, session.projectId) : null;
    const events = listEvents(store, session.harness, session.id);
    const selected = selectEvents(events, config.maxCharsPerSession);
    const earlier = earlierItems(store, session, projectId);
    const shown = new Set(selected.events.map((entry) => entry.event.key));
    for (const event of earlier.context) {
        if (shown.has(event.key)) continue;
        selected.events.push({ event, role: "context", ...truncate(event.text, REVIEW_CHARS) });
    }
    selected.events.sort((a, b) => a.event.seq - b.event.seq);
    return {
        session,
        projectId,
        revision: session.revision,
        events: selected.events,
        covered: selected.covered,
        complete: selected.complete,
        notes: reviewNotes(store, session, projectId, selected.events),
        earlier: earlier.items,
        review: earlier.review,
    };
}

/**
 * Find the session revisions that Dreaming processes now. A session is eligible when it has
 * been idle for `idleHours`, its revision has unprocessed evidence, and it is imported. A
 * revision that failed `maxAttempts` times waits for a new revision. It needs no model.
 */
export function findEligible(
    store: Store,
    config: DreamingConfig,
    options: EligibilityOptions = {},
): EligibilityResult {
    const now = options.now ?? Date.now();
    const idleMs = config.idleHours * 3_600_000;
    const wanted = options.sessions ? new Set(options.sessions) : null;
    const result: EligibilityResult = {
        eligible: [],
        trivial: [],
        deferred: 0,
        waiting: 0,
        stopped: 0,
    };
    for (const session of candidates(store)) {
        if (wanted && !wanted.has(`${session.harness}:${session.id}`)) continue;
        if (options.projectId !== undefined) {
            const projectId = session.projectId ? liveProjectId(store, session.projectId) : null;
            if (projectId !== options.projectId) continue;
        }
        const events = listEvents(store, session.harness, session.id);
        if (!events.some(isPending)) {
            result.trivial.push(session);
            continue;
        }
        const changed = Date.parse(session.changedAt);
        if (!options.force && Number.isFinite(changed) && changed > now - idleMs) {
            result.waiting++;
            continue;
        }
        if (
            !options.force &&
            session.attempts >= config.maxAttempts &&
            session.attemptRevision === session.revision
        ) {
            result.stopped++;
            continue;
        }
        if (result.eligible.length >= config.maxSessionsPerPass) {
            result.deferred++;
            continue;
        }
        result.eligible.push(snapshotSession(store, session, config));
    }
    return result;
}

/**
 * Mark sessions whose changes hold no evidence as processed. The revision must be unchanged.
 * It returns the number of sessions marked.
 */
export function markTrivial(store: Store, sessions: SessionRow[]): number {
    if (!sessions.length) return 0;
    return store.tx(() => {
        let marked = 0;
        for (const session of sessions) {
            const pending = store.get(
                `SELECT 1 AS n FROM events WHERE harness = ? AND session_id = ?
                AND memory_derived = 0 AND (processed_hash IS NULL OR processed_hash != hash)`,
                session.harness,
                session.id,
            );
            if (pending) continue;
            marked += store.run(
                `UPDATE sessions SET processed_revision = revision
                WHERE harness = ? AND id = ? AND revision = ?`,
                session.harness,
                session.id,
                session.revision,
            ).changes;
        }
        return marked;
    });
}
