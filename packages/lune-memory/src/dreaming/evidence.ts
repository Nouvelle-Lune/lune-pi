import {
    TRUST_RANK,
    type EventRow,
    type Item,
    type ItemKind,
    type SessionRow,
    type SourceRef,
    type Trust,
} from "../core/types.ts";
import { sha256 } from "../core/util.ts";
import type { Store } from "../store/db.ts";
import { getEvent, sourceKey } from "../store/rows.ts";

/** Kinds whose items belong to one Git branch when they carry a branch name. */
export const BRANCH_KINDS: readonly ItemKind[] = ["working_state", "open_item"];

/**
 * Kinds that events off the active conversation path can support (§4). The user left that
 * branch, so it does not show the current state, a decision or a preference. A lesson, fact or
 * reference that the abandoned attempt found can still be true.
 */
export const ABANDONED_KINDS: readonly ItemKind[] = ["lesson", "fact", "reference"];

export function eventSource(event: EventRow): SourceRef {
    return {
        kind: "event",
        harness: event.harness,
        sessionId: event.sessionId,
        eventKey: event.key,
    };
}

export function eventId(event: Pick<EventRow, "harness" | "sessionId" | "key">): string {
    return `${event.harness}:${event.sessionId}:${event.key}`;
}

/** Sources without duplicates, in first-seen order. */
export function uniqueSources(sources: readonly SourceRef[]): SourceRef[] {
    const seen = new Set<string>();
    const result: SourceRef[] = [];
    for (const source of sources) {
        const key = sourceKey(source);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(source);
    }
    return result;
}

export function uniqueEvents(events: readonly EventRow[]): EventRow[] {
    const seen = new Set<string>();
    return events.filter((event) => {
        const key = eventId(event);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Event id to its fixed hash, or null when the source was absent. */
export type EventPins = ReadonlyMap<string, string | null>;

/** Pin each analyzed event to the hash that the model saw. */
export function pinEvents(events: readonly EventRow[]): Map<string, string> {
    return new Map(events.map((event) => [eventId(event), event.hash]));
}

/**
 * Events that can be evidence now: they exist and did not come from lune-memory itself, which
 * cannot prove itself (§6). An event off the active conversation path is evidence only for an
 * item of `ABANDONED_KINDS`; without `kind`, only active events count. A pinned event whose text
 * changed after the analysis is dropped too: the model judged other text, and the new revision
 * waits for its own pass (§5).
 */
export function liveEvents(
    store: Store,
    sources: readonly SourceRef[],
    pins?: EventPins,
    kind?: ItemKind,
): EventRow[] {
    const abandoned = kind !== undefined && ABANDONED_KINDS.includes(kind);
    const result: EventRow[] = [];
    for (const source of uniqueSources(sources)) {
        if (source.kind !== "event") continue;
        const event = getEvent(store, source.harness, source.sessionId, source.eventKey);
        if (!event || event.memoryDerived || (!event.active && !abandoned)) continue;
        const pinned = pins?.get(eventId(event));
        if (pinned !== undefined && pinned !== event.hash) continue;
        result.push(event);
    }
    return result;
}

/**
 * Pin each event source of `items` to the hash that it has now. The model saw these items, so
 * their evidence must not change before the commit. Absence is fixed too: restoring a source
 * cannot turn an unsupported existing conclusion into reviewed evidence.
 */
export function pinItemSources(store: Store, items: readonly Item[]): Map<string, string | null> {
    const pins = new Map<string, string | null>();
    for (const item of items) {
        for (const source of item.sources) {
            if (source.kind !== "event") continue;
            const event = getEvent(store, source.harness, source.sessionId, source.eventKey);
            pins.set(sourceKey(source), event?.hash ?? null);
        }
    }
    return pins;
}

/** Add the pins of `extra` to `pins`. A pin that `pins` has already stays as it is. */
export function addPins(pins: Map<string, string | null>, extra: EventPins | undefined): void {
    for (const [id, hash] of extra ?? []) {
        if (!pins.has(id)) pins.set(id, hash);
    }
}

/** Evidence of a change, and the pinned sources that changed after the model saw them. */
export interface CheckedEvidence {
    /** Events that can be evidence now, as `liveEvents` gives them. */
    events: EventRow[];
    /** Pinned sources whose event changed or vanished after the pin. */
    changed: string[];
}

/**
 * Check the evidence of a change. It gives the same events as `liveEvents`, and it also names
 * each pinned source that changed or vanished. A change that cites such a source is not what the
 * model judged, so the caller rejects it: dropping only that source can leave an unrelated event
 * as the whole support of the conclusion.
 */
export function checkEvidence(
    store: Store,
    sources: readonly SourceRef[],
    pins: EventPins,
    kind?: ItemKind,
): CheckedEvidence {
    const abandoned = kind !== undefined && ABANDONED_KINDS.includes(kind);
    const events: EventRow[] = [];
    const changed: string[] = [];
    for (const source of uniqueSources(sources)) {
        if (source.kind !== "event") continue;
        const id = sourceKey(source);
        const pinned = pins.get(id);
        const event = getEvent(store, source.harness, source.sessionId, source.eventKey);
        if (pins.has(id) && (pinned === null || event?.hash !== pinned)) {
            changed.push(id);
            continue;
        }
        if (!event || event.memoryDerived || (!event.active && !abandoned)) continue;
        events.push(event);
    }
    return { events, changed };
}

/** Event sources of one session, without duplicates. */
export function sessionSources(
    sources: readonly SourceRef[],
    session: Pick<SessionRow, "harness" | "id">,
): SourceRef[] {
    return uniqueSources(sources).filter(
        (source) =>
            source.kind === "event" &&
            source.harness === session.harness &&
            source.sessionId === session.id,
    );
}

/** Event sources of an item that are still evidence. */
export function itemEvents(store: Store, item: Item): EventRow[] {
    return liveEvents(store, item.sources, undefined, item.kind);
}

/**
 * Highest trust that the events support. A user statement needs a user event. Tool trust needs
 * a tool result, which can be untrusted outside text: it shows what the tool returned. An
 * assistant claim, such as "the tests pass", supports only an inference.
 */
export function supportedTrust(events: readonly EventRow[]): Trust {
    if (events.some((event) => event.role === "user" && !event.untrusted)) return "user";
    if (events.some((event) => event.role === "tool_result" || event.role === "user"))
        return "tool";
    return "inference";
}

/**
 * Lower a claimed trust to what the evidence supports. A preference is a rule for agents, so
 * tool output alone never makes one: it stays an inference.
 */
export function clampTrust(claimed: Trust, events: readonly EventRow[], kind: ItemKind): Trust {
    const supported = supportedTrust(events);
    let trust = TRUST_RANK[claimed] <= TRUST_RANK[supported] ? claimed : supported;
    if (kind === "preference" && trust === "tool") trust = "inference";
    return trust;
}

export function hasUserEvent(events: readonly EventRow[]): boolean {
    return events.some(isUserStatement);
}

function isUserStatement(event: EventRow): boolean {
    return event.role === "user" && !event.untrusted;
}

/**
 * Idempotency key of an extracted item: its owning scope, kind and, per cited session, the
 * range of source events. Items without events use `fallback` within the same scope.
 */
export function idemKey(
    kind: ItemKind,
    events: readonly EventRow[],
    scope: string,
    fallback: string,
): string {
    if (!events.length) return `${scope}|${sha256(`${kind}|${fallback}`)}`;
    const ranges = new Map<string, { first: EventRow; last: EventRow }>();
    for (const event of events) {
        const session = `${event.harness}:${event.sessionId}`;
        const range = ranges.get(session);
        if (!range) {
            ranges.set(session, { first: event, last: event });
            continue;
        }
        if (event.seq < range.first.seq) range.first = event;
        if (event.seq > range.last.seq) range.last = event;
    }
    const parts = [...ranges.entries()]
        .map(([session, range]) => `${session}:${range.first.key}-${range.last.key}`)
        .sort();
    return `${scope}|${sha256(`${kind}|${parts.join("|")}`)}`;
}

/** Plain text of a model field, with collapsed white space in titles. */
export function cleanTitle(value: unknown, max = 200): string {
    return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";
}

export function cleanBody(value: unknown, max = 8000): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function stringList(value: unknown): string[] {
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (!Array.isArray(value)) return [];
    return value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function parseTrust(value: unknown): Trust | null {
    return value === "user" || value === "tool" || value === "inference" ? value : null;
}

/** Short one-line view of a text for model input. */
export function excerpt(text: string, max: number): string {
    const flat = text.replace(/\s+/gu, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}
