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

/** Event id to hash, for the events that a pass analyzed. */
export type EventPins = ReadonlyMap<string, string>;

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

// Words that the backend checks in the user's own statements (§3). The model reads meaning; these
// checks only stop a change that the user's words do not carry. They do not prove that a
// statement is about the same preference.
const GENERAL_WORDS = [
    /\b(?:always|never|by default|from now on|in general|everywhere|globally)\b/iu,
    /\b(?:every|all|any|each)\s+(?:projects?|repos?|repositor(?:y|ies)|codebases?|sessions?)\b/iu,
    /(?:总是|始终|永远|一律|默认|以后都|今后|全局|所有项目|每个项目|任何项目|所有仓库|每个仓库)/u,
];
const PROJECT_WORDS = [
    /\b(?:this|the current|current|our)\s+(?:project|repo|repository|codebase|package|workspace|app)\b/iu,
    /(?:这个项目|本项目|此项目|该项目|当前项目|这个仓库|本仓库|当前仓库|这个代码库)/u,
];
const RETRACTION_WORDS = [
    /\b(?:no longer|not any ?more|stop|don['’]t|do not|never mind|forget|instead|retract|cancel)\b/iu,
    /(?:不要|不再|别再|取消|忘掉|忘记|算了|不用再|改为|改成)/u,
];

function hasWords(patterns: readonly RegExp[], text: string): boolean {
    return patterns.some((pattern) => pattern.test(text));
}

/**
 * A user statement that sets a rule for every project in the user's own words, for example
 * "always" or "in every project". A statement that names one project is not general.
 */
export function statesGeneral(event: EventRow): boolean {
    return (
        isUserStatement(event) &&
        hasWords(GENERAL_WORDS, event.text) &&
        !hasWords(PROJECT_WORDS, event.text)
    );
}

/**
 * A user statement that withdraws or reverses a rule, for example "stop" or "no longer". A
 * statement that names one project makes an exception there, not a retraction.
 */
export function statesRetraction(event: EventRow): boolean {
    return (
        isUserStatement(event) &&
        hasWords(RETRACTION_WORDS, event.text) &&
        !hasWords(PROJECT_WORDS, event.text)
    );
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
