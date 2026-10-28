import { date, jsonl, object, sessionId, string, textContent, type JsonObject } from "./jsonl.ts";
import type { ConversationMessage, ExternalSession } from "./session.ts";
import { cleanBody, cleanLine } from "./text.ts";

interface HistoryNode {
    message: ConversationMessage;
    previous: HistoryNode | null;
}

/** Codex persists both response items and UI events; only response items carry conversation text. */
export function parseCodexSession(content: string, path: string): ExternalSession | undefined {
    const records = jsonl(content, path);
    const first = records.next().value;
    if (first?.type !== "session_meta") throw new Error("Not a supported Codex rollout");
    const meta = object(first.payload);
    const source = meta.source;
    if (
        meta.thread_source === "subagent" ||
        (typeof source === "object" && source !== null && "subagent" in source)
    ) {
        return undefined;
    }
    const id = sessionId(meta.id, "session_meta.id");
    const cwd = string(meta.cwd, "session_meta.cwd");
    const created = date(meta.timestamp, "session_meta.timestamp");
    let modified = created;
    let history: HistoryNode | null = null;
    // Persistent heads let rollback restore history across a compaction without copying every turn.
    const turns: (HistoryNode | null)[] = [];
    let inTurn = false;
    let turnHasUser = false;
    let leafId: string | null = null;
    const append = (message: ConversationMessage) => {
        history = { message, previous: history };
    };

    for (const record of records) {
        if (record.timestamp !== undefined) {
            const timestamp = date(record.timestamp, "rollout.timestamp");
            if (timestamp > modified) modified = timestamp;
        }
        if (record.type === "response_item") {
            const item = object(record.payload);
            const message = responseMessage(item);
            if (message) {
                if (message.role === "user") {
                    if (!inTurn || !turnHasUser) turns.push(history);
                    turnHasUser = true;
                }
                append(message);
                leafId = typeof item.id === "string" ? item.id : null;
            }
        } else if (record.type === "compacted") {
            const compacted = object(record.payload);
            if (!Array.isArray(compacted.replacement_history)) {
                throw new Error("Unsupported Codex compaction without replacement_history");
            }
            const summary = string(compacted.message, "compacted.message");
            const checkpointOnly = turns.length === 0;
            let hasSummary = false;
            history = null;
            for (const raw of compacted.replacement_history) {
                const message = responseMessage(object(raw), summary);
                if (!message) continue;
                if (checkpointOnly && message.role === "user") turns.push(history);
                if (message.role === "summary") hasSummary = true;
                append(message);
            }
            if (summary.trim() && !hasSummary)
                append({ role: "summary", text: cleanBody(summary) });
            leafId = null;
        } else if (record.type === "event_msg") {
            const event = object(record.payload);
            if (event.type === "task_started") {
                inTurn = true;
                turnHasUser = false;
            } else if (event.type === "task_complete" || event.type === "turn_aborted") {
                inTurn = false;
            } else if (event.type === "thread_rolled_back") {
                const count = event.num_turns;
                if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
                    throw new Error("Invalid Codex rollback num_turns");
                }
                for (let index = 0; index < count && turns.length > 0; index++) {
                    history = turns.pop()!;
                }
                inTurn = false;
                leafId = null;
            }
        }
    }
    const messages: ConversationMessage[] = [];
    for (let node: HistoryNode | null = history; node; node = node.previous) {
        messages.push(node.message);
    }
    messages.reverse();
    return {
        session: {
            source: "codex",
            path,
            id,
            cwd,
            created,
            modified,
            messageCount: messages.filter((message) => message.role !== "summary").length,
            firstMessage: cleanLine(
                messages.find((message) => message.role === "user")?.text ?? "",
            ),
            allMessagesText: messages.map((message) => message.text).join("\n"),
        },
        messages,
        leafId,
    };
}

function responseMessage(item: JsonObject, summary?: string): ConversationMessage | undefined {
    if (
        item.type !== "message" ||
        (item.role !== "user" && item.role !== "assistant") ||
        item.channel === "analysis"
    ) {
        return undefined;
    }
    let content = item.content;
    if (item.role === "user" && item.internal_chat_message_metadata_passthrough !== undefined) {
        const metadata = object(item.internal_chat_message_metadata_passthrough);
        if (Array.isArray(metadata.content_item_kinds) && Array.isArray(content)) {
            // Desktop stores injected AGENTS.md and environment context as user-role content too.
            const kinds = metadata.content_item_kinds;
            content = content.filter((_part, index) =>
                string(kinds[index], "content_item_kinds").startsWith("user."),
            );
        }
    }
    const text = cleanBody(textContent(content, ["input_text", "output_text"]));
    if (!text) return undefined;
    const isSummary =
        summary !== undefined &&
        ((summary !== "" && text === cleanBody(summary)) ||
            text.startsWith(
                "Another language model started to solve this problem and produced a summary",
            ));
    return { role: isSummary ? "summary" : item.role, text };
}
