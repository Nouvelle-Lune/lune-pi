import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import type { SessionCatalog } from "./catalog.ts";
import { mentionToken } from "./mention.ts";
import { SOURCE_NAMES, type LocalSession } from "./session.ts";
import { formatAge, projectName, SEPARATOR, sessionTitle, TOKEN_BOUNDARY } from "./text.ts";

/** `@@query` lists sessions only and searches their messages too. */
export const SESSION_TRIGGER = "@@";
/** Source tags are padded to the widest one so the age and project columns line up. */
const SOURCE_TAG_WIDTH = Math.max(...Object.keys(SOURCE_NAMES).map((source) => source.length + 2));
/** Session rows in the list for a plain `@query`. */
const SESSION_ROWS = 3;
/** Rows for `@@query`; the search itself covers every local session. */
const SESSION_LIST_ROWS = 50;
/** An `@` at a word start, up to the cursor. A quote after it is pi's quoted path syntax. */
const AT_WORD = new RegExp(`${TOKEN_BOUNDARY}(@(?:(?!${SEPARATOR})[^"])*)$`, "u");

export interface MentionAutocompleteOptions {
    catalog: SessionCatalog;
    /** The running session's file, left out of the list. */
    currentSessionFile: string | undefined;
}

/**
 * `@query` lists matching sessions with pi's own file matches, and `@@query` lists sessions only.
 * Everything that is not an `@` token goes to the provider underneath.
 *
 * Nothing here waits for the session list: the rows come from what the catalog has read. The
 * editor runs one request at a time, so a slow request would delay every later keystroke.
 */
export function createMentionAutocomplete(
    current: AutocompleteProvider,
    options: MentionAutocompleteOptions,
): AutocompleteProvider {
    // The editor passes back the item objects it received, so membership marks session rows.
    const sessionRows = new WeakSet<AutocompleteItem>();
    const sessionItems = (query: string, limit: number, searchText: boolean) => {
        const sessions = options.catalog.snapshot();
        const now = Date.now();
        return matchSessions(sessions, query, options.currentSessionFile, searchText)
            .slice(0, limit)
            .map((session) => {
                const item = sessionItem(session, sessions, now);
                sessionRows.add(item);
                return item;
            });
    };

    return {
        triggerCharacters: current.triggerCharacters,
        shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
            ? (lines, cursorLine, cursorCol) =>
                  current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol)
            : undefined,

        async getSuggestions(lines, cursorLine, cursorCol, request) {
            const prefix = AT_WORD.exec((lines[cursorLine] ?? "").slice(0, cursorCol))?.[1];
            if (!prefix) return current.getSuggestions(lines, cursorLine, cursorCol, request);
            if (prefix.startsWith(SESSION_TRIGGER)) {
                const query = prefix.slice(SESSION_TRIGGER.length);
                const items = sessionItems(query, SESSION_LIST_ROWS, true);
                return items.length > 0 ? { items, prefix } : null;
            }
            const query = prefix.slice(1);
            // A folder in the query names a path.
            const sessions = query.includes("/") ? [] : sessionItems(query, SESSION_ROWS, false);
            const files = await current.getSuggestions(lines, cursorLine, cursorCol, request);
            if (request.signal.aborted) return null;
            // No rows to add, or the provider underneath read a different token.
            if (sessions.length === 0 || (files && files.prefix !== prefix)) return files;
            const items = withSessions(files?.items ?? [], sessions, query);
            return items.length > 0 ? { items, prefix } : null;
        },

        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            if (!sessionRows.has(item)) {
                return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
            }
            const line = lines[cursorLine] ?? "";
            const start = cursorCol - prefix.length;
            const inserted = `${item.value} `;
            const next = [...lines];
            next[cursorLine] = line.slice(0, start) + inserted + line.slice(cursorCol);
            return { lines: next, cursorLine, cursorCol: start + inserted.length };
        },
    };
}

/**
 * Sessions come first, except after files whose name contains the query. The editor selects the
 * first row, so Tab after a typed file name still picks that file and not a session.
 */
function withSessions(
    files: readonly AutocompleteItem[],
    sessions: readonly AutocompleteItem[],
    query: string,
): AutocompleteItem[] {
    const needle = query.toLowerCase();
    const named = needle
        ? files.filter((item) => item.label.replace(/\/$/, "").toLowerCase().includes(needle))
        : [];
    const others = files.filter((item) => !named.includes(item));
    return [...named, ...sessions, ...others];
}

interface SessionSearch {
    id: string;
    title: string;
    project: string;
    source: string;
    text?: string;
}

// The catalog keeps one list until its next reload, so the lower-case copies are made once per
// session and list, not once per keystroke.
const searches = new WeakMap<LocalSession, SessionSearch>();

function searchOf(session: LocalSession): SessionSearch {
    let search = searches.get(session);
    if (!search) {
        search = {
            id: session.id.toLowerCase(),
            title: sessionTitle(session).toLowerCase(),
            project: projectName(session).toLowerCase(),
            source: SOURCE_NAMES[session.source].toLowerCase(),
        };
        searches.set(session, search);
    }
    return search;
}

/**
 * Id and title matches rank above project matches, which rank above matches in the session's
 * messages. Equal ranks keep the catalog's newest-first order because the sort is stable.
 */
export function matchSessions(
    sessions: readonly LocalSession[],
    query: string,
    excludePath: string | undefined,
    searchText: boolean,
): LocalSession[] {
    const needle = query.toLowerCase();
    return sessions
        .filter((session) => session.path !== excludePath && session.messageCount > 0)
        .map((session) => ({ session, rank: needle ? matchRank(session, needle, searchText) : 1 }))
        .filter(({ rank }) => rank > 0)
        .sort((a, b) => b.rank - a.rank)
        .map(({ session }) => session);
}

function matchRank(session: LocalSession, needle: string, searchText: boolean): number {
    const search = searchOf(session);
    if (search.id.startsWith(needle) || search.title.includes(needle)) return 3;
    if (search.project.includes(needle) || search.source.includes(needle)) return 2;
    if (!searchText) return 0;
    search.text ??= session.allMessagesText.toLowerCase();
    return search.text.includes(needle) ? 1 : 0;
}

/** Source, age and project fill pi's label column, which leaves the wide one for the title. */
function sessionItem(
    session: LocalSession,
    sessions: readonly LocalSession[],
    now: number,
): AutocompleteItem {
    const source = `[${session.source}]`.padEnd(SOURCE_TAG_WIDTH);
    const age = formatAge(now - session.modified.getTime()).padStart(3);
    return {
        value: mentionToken(session, sessions),
        label: `${source} ${age}  ${projectName(session)}`,
        description: sessionTitle(session),
    };
}
