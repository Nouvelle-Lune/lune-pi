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

/**
 * Pin each event source of `items` to the hash that it has now. The model saw these items, so
 * their evidence must not change before the commit. A vanished event gets no pin.
 */
export function pinItemSources(store: Store, items: readonly Item[]): Map<string, string> {
    const pins = new Map<string, string>();
    for (const item of items) {
        for (const source of item.sources) {
            if (source.kind !== "event") continue;
            const event = getEvent(store, source.harness, source.sessionId, source.eventKey);
            if (event) pins.set(eventId(event), event.hash);
        }
    }
    return pins;
}

/** Add the pins of `extra` to `pins`. A pin that `pins` has already stays as it is. */
export function addPins(pins: Map<string, string>, extra: EventPins | undefined): void {
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
        if (pinned !== undefined && event?.hash !== pinned) {
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

// Words that the backend checks in the user's own statements (§3). The model reads meaning; these
// checks only stop a change that the user's words do not carry. They do not prove that a
// statement is about the same preference.
const GENERAL_WORDS = [
    /\b(?:always|never|by default|from now on|in general|everywhere|globally)\b/iu,
    /\b(?:every|all|any|each)\s+(?:single\s+)?(?:(?:one\s+)?of\s+)?(?:(?:my|our|the|your)\s+)?(?:projects?|repos?|repositor(?:y|ies)|codebases?|sessions?|workspaces?)\b/iu,
    /\bacross\s+(?:(?:all\s+(?:of\s+)?)?(?:my|our|the)\s+)?(?:projects|repos|repositories|codebases|workspaces)\b/iu,
    /\b(?:regardless of|no matter)\s+(?:(?:the|which|what)\s+)?(?:project|repo|repository|codebase)\b/iu,
    /(?:总是|始终|永远|一律|默认|以后都|今后|全局|跨项目|(?:所有|每个|每一个|任何|全部|各个)的?(?:项目|仓库|代码库|工程)|(?:不管|无论)是?(?:哪个|什么)(?:项目|仓库))/u,
];
// A statement that names one unit of code, such as "this project" or "this service", sets a
// rule for that place only.
const PROJECT_WORDS = [
    /\b(?:this|the current|current|our)\s+(?:project|repo|repository|codebase|monorepo|package|workspace|app|application|service|module|crate|library|lib|component|plugin|extension|site|website|frontend|backend)\b/iu,
    /(?:这个|本|此|该|当前)(?:项目|仓库|代码库|工程|服务|模块|包|库|应用|插件)/u,
];
// "Don't forget" and "别忘了" repeat a rule. They do not withdraw one.
const REMINDER_WORDS =
    /\b(?:don['’]t|do not|never)\s+forget\b|(?:别忘了|别忘记|别忘|不要忘记|不要忘了|不要忘)/giu;
// These words withdraw a rule in any clause that does not also set one.
const STRONG_RETRACTION = [
    /\b(?:no longer|no more|not any ?more|anymore|stop|never mind|forget|retract|cancel)\b/iu,
    /(?:不再|别再|不要再|不用再|取消|忘掉|忘记|算了)/u,
];
// These words also state rules, for example "always use spaces instead of tabs". They withdraw
// a rule only in a statement that sets no rule.
const WEAK_RETRACTION = [/\b(?:don['’]t|do not|instead)\b/iu, /(?:不要|改为|改成|换成)/u];
const RULE_WORDS = [/\b(?:always|make sure|be sure|ensure)\b/iu, /(?:总是|始终|务必|一定要|一律)/u];
const CLAUSE_BREAK =
    /[.;:!?,\n。；：！？，、]+|\b(?:and|but|also|then|so|while)\b|(?:而且|并且|但是|然后|还有|另外|同时)/iu;
// Words that name no topic. Two statements that share only these are not about the same rule.
const STOP_WORDS = new Set(
    (
        "the and but for with without you your yours our ours they them their this that these " +
        "those then than there here what when where which who why how all any each every some " +
        "more most other into onto from about also just only very really please use using used " +
        "make made get got let can could should would will shall must may might not now are was " +
        "were been being have has had does did doing done its it's i'm one like want need thing " +
        "way instead longer stop forget never always default general from project repo session"
    ).split(" "),
);
const HAN = /\p{Script=Han}/u;
const HAN_BREAK = /[的了吧呢吗啊呀嘛请就都也还和与或]/u;
const TOKEN = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_'’-])+/gu;
// Longer phrases go first, so that "never mind" goes as a whole before "never".
const MARKERS = [
    ...STRONG_RETRACTION,
    ...WEAK_RETRACTION,
    ...RULE_WORDS,
    ...GENERAL_WORDS,
    ...PROJECT_WORDS,
].map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));

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
 *
 * The check works per clause, so "always answer in English, and don't use tabs" does not
 * withdraw a rule about English. With `about`, the text of the preference and its sources, the
 * clause that withdraws must also share a word with it. This only shows that the statement can
 * be about the preference; the model reads the meaning.
 */
export function statesRetraction(event: EventRow, about?: readonly string[]): boolean {
    if (!isUserStatement(event) || hasWords(PROJECT_WORDS, event.text)) return false;
    const found = retractionClauses(event.text);
    if (!found.length) return false;
    if (!about) return true;
    const topic = topicTerms(about.join("\n"));
    return found.some((clause) => {
        const own = topicTerms(clause);
        // A bare "never mind" refers to the rest of the statement.
        return sharesTerm(own.size ? own : topicTerms(event.text), topic);
    });
}

/** Clauses of a statement that withdraw a rule and do not set one. */
function retractionClauses(text: string): string[] {
    const plain = text.replace(REMINDER_WORDS, " ");
    const setsRule = hasWords(RULE_WORDS, plain);
    return plain.split(CLAUSE_BREAK).filter((clause) => {
        if (hasWords(RULE_WORDS, clause)) return false;
        if (hasWords(STRONG_RETRACTION, clause)) return true;
        return !setsRule && hasWords(WEAK_RETRACTION, clause);
    });
}

/**
 * Topic words of a text: word stems outside Chinese, and pairs of adjacent Han characters in
 * Chinese, which has no spaces. Scope, rule and retraction words are not topics.
 */
function topicTerms(text: string): Set<string> {
    let plain = text.replace(REMINDER_WORDS, " ");
    for (const marker of MARKERS) plain = plain.replace(marker, " ");
    const terms = new Set<string>();
    for (const token of plain.toLowerCase().match(TOKEN) ?? []) {
        if (HAN.test(token)) {
            for (const run of token.split(HAN_BREAK)) {
                const chars = [...run];
                for (let i = 0; i + 1 < chars.length; i++) terms.add(`${chars[i]}${chars[i + 1]}`);
            }
            continue;
        }
        const word = token.replace(/['’]s$/u, "").replace(/['’-]/gu, "");
        if (STOP_WORDS.has(word)) continue;
        const term = stem(word);
        if (term.length >= 3 && !STOP_WORDS.has(term)) terms.add(term);
    }
    return terms;
}

function stem(word: string): string {
    if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
    return word;
}

/** Two words match when they are equal, or one is a stem of four or more letters of the other. */
function sharesTerm(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    for (const a of left) {
        for (const b of right) {
            if (a === b) return true;
            const [short, long] = a.length <= b.length ? [a, b] : [b, a];
            if (short.length >= 4 && long.startsWith(short)) return true;
        }
    }
    return false;
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
