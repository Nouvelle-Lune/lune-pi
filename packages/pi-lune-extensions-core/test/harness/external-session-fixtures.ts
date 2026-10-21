type Raw = Record<string, unknown>;

export const jsonl = (records: Raw[]) =>
    records.map((record) => JSON.stringify(record)).join("\n") + "\n";

export function codexMeta(id: string, extra: Raw = {}): Raw {
    return {
        type: "session_meta",
        timestamp: "2026-02-02T00:00:00.000Z",
        payload: {
            id,
            cwd: "/work/codex-project",
            timestamp: "2026-02-02T00:00:00.000Z",
            source: "cli",
            thread_source: "user",
            ...extra,
        },
    };
}

export function codexMessage(role: string, text: string, extra: Raw = {}): Raw {
    return {
        type: "response_item",
        timestamp: "2026-02-02T01:00:00.000Z",
        payload: {
            type: "message",
            role,
            content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
            ...extra,
        },
    };
}

export function claudeMessage(
    sessionId: string,
    uuid: string,
    parentUuid: string | null,
    role: "user" | "assistant",
    content: string | Raw[],
    extra: Raw = {},
): Raw {
    return {
        type: role,
        sessionId,
        cwd: "/work/claude-project",
        uuid,
        parentUuid,
        isSidechain: false,
        timestamp: "2026-02-03T00:00:00.000Z",
        message: { role, content },
        ...extra,
    };
}
