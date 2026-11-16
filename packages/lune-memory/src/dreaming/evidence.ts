import {
    TRUST_RANK,
    type EventRow,
    type Item,
    type ItemKind,
    type SourceRef,
    type Trust,
} from "../core/types.ts";
import { sha256 } from "../core/util.ts";
import type { Store } from "../store/db.ts";
import { getEvent, sourceKey } from "../store/rows.ts";

/** Kinds that can exist without cited events. Their item sources are navigation links, not proof. */
export const EVIDENCE_FREE_KINDS: readonly ItemKind[] = ["wiki", "index"];

/** Kinds whose items belong to one Git branch when they carry a branch name. */
export const BRANCH_KINDS: readonly ItemKind[] = ["working_state", "open_item"];

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

/**
 * Events that can be evidence now: they exist, are on the active conversation path and did not
 * come from lune-memory itself. Others are dropped, because memory cannot prove itself (§6).
 */
export function liveEvents(store: Store, sources: readonly SourceRef[]): EventRow[] {
    const result: EventRow[] = [];
    for (const source of uniqueSources(sources)) {
        if (source.kind !== "event") continue;
        const event = getEvent(store, source.harness, source.sessionId, source.eventKey);
        if (event && event.active && !event.memoryDerived) result.push(event);
    }
    return result;
}

/** Event sources of an item that are still evidence. */
export function itemEvents(store: Store, item: Item): EventRow[] {
    return liveEvents(store, item.sources);
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
    return events.some((event) => event.role === "user" && !event.untrusted);
}

/**
 * Idempotency key of an extracted item: its kind and, per cited session, the range of source
 * events. Items without events use `fallback`, for example the scope and title of a wiki page.
 */
export function idemKey(kind: ItemKind, events: readonly EventRow[], fallback: string): string {
    if (!events.length) return sha256(`${kind}|${fallback}`);
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
    return sha256(`${kind}|${parts.join("|")}`);
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
