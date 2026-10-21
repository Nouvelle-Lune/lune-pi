import { date, jsonl, object, sessionId, string, textContent } from "./jsonl.ts";
import type { ConversationMessage, ExternalSession } from "./session.ts";
import { cleanBody, cleanLine } from "./text.ts";

interface Entry {
    id: string;
    parent: string | null;
    message?: ConversationMessage;
}

interface PreservedSegment {
    head: string;
    anchor: string;
    tail: string;
}

export function parseClaudeSession(content: string, path: string): ExternalSession | undefined {
    const entries = new Map<string, Entry>();
    const segments: PreservedSegment[] = [];
    let id: string | undefined;
    let cwd: string | undefined;
    let created: Date | undefined;
    let modified: Date | undefined;
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    let leafId: string | null = null;
    let hasMainEntry = false;
    let hasSidechain = false;

    for (const record of jsonl(content, path)) {
        if (record.isSidechain === true) {
            hasSidechain = true;
            continue;
        }
        if (record.type === "custom-title") customTitle = string(record.customTitle, "customTitle");
        if (record.type === "ai-title") aiTitle = string(record.aiTitle, "aiTitle");
        if (typeof record.cwd === "string") cwd = record.cwd;
        if (typeof record.sessionId === "string") {
            if (id !== undefined && id !== record.sessionId) {
                throw new Error("Claude Code file contains multiple session ids");
            }
            id = sessionId(record.sessionId, "entry.sessionId");
        }
        if (record.timestamp !== undefined) {
            const timestamp = date(record.timestamp, "entry.timestamp");
            if (!created || timestamp < created) created = timestamp;
            if (!modified || timestamp > modified) modified = timestamp;
        }
        if (record.uuid === undefined || record.parentUuid === undefined) continue;
        hasMainEntry = true;
        const uuid = string(record.uuid, "entry.uuid");
        const parent =
            record.parentUuid === null ? null : string(record.parentUuid, "entry.parentUuid");
        const entry: Entry = { id: uuid, parent };
        if (record.type === "user" || record.type === "assistant") {
            const message = object(record.message);
            const text = cleanBody(
                typeof message.content === "string"
                    ? message.content
                    : textContent(message.content, ["text"]),
            );
            if (text && record.isMeta !== true) {
                entry.message = {
                    role: record.isCompactSummary === true ? "summary" : record.type,
                    text,
                };
            }
        }
        entries.set(uuid, entry);
        leafId = uuid;
        if (record.type === "system" && record.subtype === "compact_boundary") {
            const metadata = object(record.compactMetadata);
            if (metadata.preservedSegment !== undefined) {
                const segment = object(metadata.preservedSegment);
                segments.push({
                    head: string(segment.headUuid, "preservedSegment.headUuid"),
                    anchor: string(segment.anchorUuid, "preservedSegment.anchorUuid"),
                    tail: string(segment.tailUuid, "preservedSegment.tailUuid"),
                });
            }
        }
    }
    if (!hasMainEntry && (id !== undefined || hasSidechain)) return undefined;
    if (!id || cwd === undefined || !created || !modified) {
        throw new Error("Not a supported Claude Code session");
    }
    // Compaction preserves an older segment without rewriting its on-disk parent links.
    for (const segment of segments) {
        const head = entries.get(segment.head);
        if (!head || !entries.has(segment.anchor) || !entries.has(segment.tail)) {
            throw new Error("Claude Code compaction references a missing preserved segment");
        }
        for (const entry of entries.values()) {
            if (entry.parent === segment.anchor) entry.parent = segment.tail;
        }
        head.parent = segment.anchor;
    }
    const messages: ConversationMessage[] = [];
    const visited = new Set<string>();
    for (let cursor = leafId; cursor !== null; ) {
        if (visited.has(cursor)) throw new Error("Claude Code session contains a parent cycle");
        visited.add(cursor);
        const entry = entries.get(cursor);
        if (!entry) throw new Error(`Claude Code session is missing parent ${cursor}`);
        if (entry.message) messages.push(entry.message);
        cursor = entry.parent;
    }
    messages.reverse();
    return {
        session: {
            source: "claude",
            path,
            id,
            cwd,
            created,
            modified,
            name: customTitle ?? aiTitle,
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
