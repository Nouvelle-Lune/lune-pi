import { basename } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

// pi-tui's completion separators (whitespace or CJK punctuation) and token boundary; neither is
// exported.
const CJK_PUNCTUATION =
    "(?:(?=\\p{Punctuation})[\\p{Script_Extensions=Han}\\p{Script_Extensions=Hiragana}\\p{Script_Extensions=Katakana}\\p{Script_Extensions=Hangul}\\p{Script_Extensions=Bopomofo}]|[，．：；！？（）［］｛｝“”‘’…—])";
export const SEPARATOR = `(?:\\s|${CJK_PUNCTUATION})`;
export const TOKEN_BOUNDARY = `(?:^|${SEPARATOR})[([{<\`"']*`;

/** Session text is untrusted: drop terminal sequences and control characters. */
export function cleanBody(text: string): string {
    return stripTerminalSequences(text)
        .replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
            character === "\n" || character === "\t" ? character : " ",
        )
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function cleanLine(text: string): string {
    return cleanBody(text).replace(/\s+/gu, " ");
}

/** Truncate by code point so CJK text and emoji are never split. */
export function clip(text: string, limit: number): string {
    const characters = Array.from(text);
    if (characters.length <= limit) return text;
    return `${characters.slice(0, limit).join("")} … [${characters.length - limit} more characters]`;
}

export function sessionTitle(session: SessionInfo): string {
    return cleanLine(session.name || session.firstMessage) || session.id;
}

export function projectName(session: SessionInfo): string {
    return basename(session.cwd) || session.cwd || "unknown project";
}

/** Compact age for a fixed-width column: `now`, `12m`, `5h`, `3d`, `6w`, `2y`. */
export function formatAge(milliseconds: number): string {
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 14) return `${days}d`;
    if (days < 365) return `${Math.floor(days / 7)}w`;
    return `${Math.floor(days / 365)}y`;
}
