import type { SessionInfo } from "@earendil-works/pi-coding-agent";

type Raw = Record<string, unknown>;

/**
 * Builds a session file as JSONL text in pi's own layout, linking each entry to the previous one
 * unless told otherwise.
 */
export class SessionFile {
    readonly id: string;
    readonly cwd: string;
    private readonly lines: Raw[];
    private counter = 0;
    private last: string | null = null;

    constructor(id = "01a14931-31bb-7000-8000-000000000001", cwd = "/work/project") {
        this.id = id;
        this.cwd = cwd;
        this.lines = [
            { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
        ];
    }

    /** Appends an entry; `parentId` overrides the default (previous entry) to create a branch. */
    add(entry: Raw, parentId: string | null | undefined = undefined): string {
        const id = `e${++this.counter}`;
        const parent = parentId === undefined ? this.last : parentId;
        // Pi writes `type`, `id`, `parentId` and `timestamp` first, then the payload.
        const { type, timestamp: own, ...payload } = entry;
        const timestamp = typeof own === "string" ? own : "2026-01-01T00:00:01.000Z";
        this.lines.push({ type, id, parentId: parent, timestamp, ...payload });
        this.last = id;
        return id;
    }

    /** A message gets a numeric timestamp unless it has one; `role` stays first, as in pi. */
    message(message: Raw, parentId: string | null | undefined = undefined): string {
        const body = "timestamp" in message ? message : { ...message, timestamp: 1 };
        return this.add({ type: "message", message: body }, parentId);
    }

    user(text: string | Raw[], parentId: string | null | undefined = undefined): string {
        return this.message({ role: "user", content: text }, parentId);
    }

    assistant(content: string | Raw[], parentId: string | null | undefined = undefined): string {
        const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
        return this.message({ role: "assistant", content: blocks, stopReason: "stop" }, parentId);
    }

    toolResult(
        toolName: string,
        text: string,
        extra: Raw = {},
        parentId: string | null | undefined = undefined,
    ): string {
        return this.message(
            {
                role: "toolResult",
                toolCallId: `call-${this.counter}`,
                toolName,
                content: [{ type: "text", text }],
                isError: false,
                ...extra,
            },
            parentId,
        );
    }

    jsonl(): string {
        return this.lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    }

    info(overrides: Partial<SessionInfo> = {}): SessionInfo {
        return sessionInfo({ id: this.id, cwd: this.cwd, ...overrides });
    }
}

export const toolCall = (name: string, args: Raw = {}): Raw => ({
    type: "toolCall",
    id: `tc-${name}`,
    name,
    arguments: args,
});

export function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
        path: "/sessions/s.jsonl",
        id: "01a14931-31bb-7000-8000-000000000001",
        cwd: "/work/project",
        created: new Date("2026-01-01T00:00:00Z"),
        modified: new Date("2026-01-01T01:00:00Z"),
        messageCount: 2,
        firstMessage: "first message",
        allMessagesText: "first message",
        ...overrides,
    };
}
