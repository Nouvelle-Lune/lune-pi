import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { TOKEN_BOUNDARY } from "./text.ts";

export const TOKEN_PREFIX = "@session:";

/** UUIDv7 ids carry the creation time in their first 12 hex digits (`01a14931-31bb`). */
const MIN_ID_LENGTH = 13;

// Session ids follow pi's assertValidSessionId(): alphanumeric at both ends, `._-` inside.
const mentionPattern = new RegExp(
    `(?<=${TOKEN_BOUNDARY})${TOKEN_PREFIX}([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)`,
    "gu",
);

export interface Mention {
    /** Offset of `@session:` in the text. */
    index: number;
    token: string;
    idPrefix: string;
}

/** The shortest id prefix, from MIN_ID_LENGTH up, that names only this session. */
export function shortSessionId(id: string, sessions: readonly SessionInfo[]): string {
    for (let length = Math.min(MIN_ID_LENGTH, id.length); length < id.length; length++) {
        const prefix = id.slice(0, length);
        if (!/[A-Za-z0-9]$/.test(prefix)) continue;
        if (sessions.every((other) => other.id === id || !other.id.startsWith(prefix))) {
            return prefix;
        }
    }
    return id;
}

export function mentionToken(session: SessionInfo, sessions: readonly SessionInfo[]): string {
    return `${TOKEN_PREFIX}${shortSessionId(session.id, sessions)}`;
}

export function findMentions(text: string): Mention[] {
    return [...text.matchAll(mentionPattern)].map((match) => ({
        index: match.index,
        token: match[0],
        idPrefix: match[1]!,
    }));
}

/** Throws when the prefix names no session or more than one. */
export function resolveMention(idPrefix: string, sessions: readonly SessionInfo[]): SessionInfo {
    const matches = sessions.filter((session) => session.id.startsWith(idPrefix));
    if (matches.length === 1) return matches[0]!;
    throw new Error(
        matches.length === 0
            ? `No local session matches ${TOKEN_PREFIX}${idPrefix}`
            : `${TOKEN_PREFIX}${idPrefix} matches ${matches.length} sessions; type more of the id`,
    );
}

/** Replace each mention with the editor text for its file, keeping all other text. */
export function replaceMentions(
    text: string,
    mentions: readonly Mention[],
    replacement: (mention: Mention) => string,
): string {
    let result = "";
    let offset = 0;
    for (const mention of mentions) {
        result += text.slice(offset, mention.index) + replacement(mention);
        offset = mention.index + mention.token.length;
    }
    return result + text.slice(offset);
}

/** Pi's `@` file reference, quoted like its own completion when the path has whitespace. */
export function fileReference(path: string): string {
    return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}
