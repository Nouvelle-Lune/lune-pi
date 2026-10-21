import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export type SessionSource = "pi" | "codex" | "claude";

export interface LocalSession extends SessionInfo {
    source: SessionSource;
}

export const SOURCE_NAMES: Record<SessionSource, string> = {
    pi: "pi",
    codex: "Codex",
    claude: "Claude Code",
};

export interface ConversationMessage {
    role: "user" | "assistant" | "summary";
    text: string;
}

export interface ExternalSession {
    session: LocalSession;
    messages: ConversationMessage[];
    leafId: string | null;
}
