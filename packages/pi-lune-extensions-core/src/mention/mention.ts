import type { LocalSession, SessionSource } from "./session.ts";
import { TOKEN_BOUNDARY } from "./text.ts";

export const TOKEN_PREFIX = "@session:";
const TOKEN_PREFIXES: Record<SessionSource, string> = {
    pi: TOKEN_PREFIX,
    codex: "@codex:",
    claude: "@claude:",
};

/** UUIDv7 ids carry the creation time in their first 12 hex digits (`01a14931-31bb`). */
const MIN_ID_LENGTH = 13;

// Session ids follow pi's assertValidSessionId(): alphanumeric at both ends, `._-` inside.
const mentionPattern = new RegExp(
    `(?<=${TOKEN_BOUNDARY})@(session|codex|claude):([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)`,
    "gu",
);

export interface Mention {
    /** Offset of the source-specific token in the text. */
    index: number;
    token: string;
    source: SessionSource;
    idPrefix: string;
}

/** The shortest id prefix, from MIN_ID_LENGTH up, that names only this session. */
export function shortSessionId(id: string, sessions: readonly LocalSession[]): string {
    for (let length = Math.min(MIN_ID_LENGTH, id.length); length < id.length; length++) {
        const prefix = id.slice(0, length);
        if (!/[A-Za-z0-9]$/.test(prefix)) continue;
        if (sessions.every((other) => other.id === id || !other.id.startsWith(prefix))) {
            return prefix;
        }
    }
    return id;
}

export function mentionToken(session: LocalSession, sessions: readonly LocalSession[]): string {
    const sameSource = sessions.filter((other) => other.source === session.source);
    return `${TOKEN_PREFIXES[session.source]}${shortSessionId(session.id, sameSource)}`;
}

export function findMentions(text: string): Mention[] {
    return [...text.matchAll(mentionPattern)].map((match) => ({
        index: match.index,
        token: match[0],
        source: match[1] === "session" ? "pi" : (match[1] as SessionSource),
        idPrefix: match[2]!,
    }));
}

/** Throws when the prefix names no session or more than one. */
export function resolveMention(
    mention: Pick<Mention, "source" | "idPrefix">,
    sessions: readonly LocalSession[],
): LocalSession {
    const { source, idPrefix } = mention;
    const token = `${TOKEN_PREFIXES[source]}${idPrefix}`;
    const matches = sessions.filter(
        (session) => session.source === source && session.id.startsWith(idPrefix),
    );
    if (matches.length === 1) return matches[0]!;
    throw new Error(
        matches.length === 0
            ? `No local session matches ${token}`
            : `${token} matches ${matches.length} sessions; type more of the id`,
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
