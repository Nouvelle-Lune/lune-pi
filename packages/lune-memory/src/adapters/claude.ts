import { basename, relative, sep } from "node:path";

import type { EventRole } from "../core/types.ts";
import {
    argumentsToText,
    blockText,
    blocksToText,
    bump,
    containsMemoryContext,
    findJsonlFiles,
    isMemoryToolCall,
    knownContent,
    obj,
    parseJsonl,
    str,
} from "./common.ts";
import {
    AdapterFormatError,
    type EvidenceEvent,
    type HarnessAdapter,
    type ParseContext,
    type SessionEvidence,
} from "./types.ts";

/*
 * Claude Code adapter. The CLI and the desktop app write the same format:
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Deeper directories hold subagent
 * traces and tool output files, so they are not sessions.
 */

type Rec = Record<string, unknown>;

/** Record types without conversation content. They are skipped and counted by type. */
const SKIPPED_TYPES = new Set([
    // Raw API request logs. They repeat conversation messages, so they are not evidence.
    "api-request",
    "api-request-blob",
    "api-request-shape",
    // Session metadata.
    "agent-name",
    "ai-title",
    "atis-latch",
    "bridge-session",
    "cost-state",
    "custom-title",
    "file-history-delta",
    "file-history-snapshot",
    "last-prompt",
    "mode",
    "permission-mode",
    "pr-link",
    "queue-operation",
    "relocated",
    "session-owner",
    // Legacy title record of older versions.
    "summary",
    "tools-used",
]);

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;
const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]]*\]$/u;
const START_TAG = /^<([a-z][a-z0-9_-]*)>/u;

/** One record of the file, in file order. */
interface Entry {
    index: number;
    line: number;
    record: Rec;
    uuid?: string;
}

/** Text after classification, before it becomes an event. */
interface Piece {
    role: EventRole;
    text: string;
    toolName?: string;
    untrusted: boolean;
}

interface Pending {
    event: EvidenceEvent;
    /** Index of the record in the file. */
    entryIndex: number;
    recordUuid?: string;
    /** Record that holds the matching tool call, for a tool result. */
    callRecord?: string;
}

interface ToolCall {
    name?: string;
    memory: boolean;
    recordUuid?: string;
}

/** Remove `<system-reminder>` blocks that the harness injects. Count each removed block. */
function stripReminders(text: string, filtered: Record<string, number>): string {
    return text.replace(SYSTEM_REMINDER, () => {
        bump(filtered, "system-reminder");
        return "";
    });
}

function tagText(text: string, tag: string): string {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(text);
    return match?.[1]?.trim() ?? "";
}

function commandOutput(text: string, tags: readonly string[], toolName: string): Piece {
    const parts = tags.map((tag) => tagText(text, tag)).filter(Boolean);
    return { role: "tool_result", text: parts.join("\n"), toolName, untrusted: true };
}

/**
 * Classify user text that the harness can wrap in its own tags.
 * - A typed slash command or a shell-mode command is user intent. It becomes `/name args` or
 *   `!command`.
 * - Command output is tool output. It becomes an untrusted `tool_result`.
 * - A `<task-notification>` reports a background task. It becomes an untrusted `tool_result`.
 * - The local command caveat is harness text. It is skipped.
 * Other text is a user statement.
 */
function classifyUserText(text: string, filtered: Record<string, number>): Piece | undefined {
    if (INTERRUPT_MARKER.test(text)) return { role: "notice", text, untrusted: false };
    switch (START_TAG.exec(text)?.[1]) {
        case "command-name":
        case "command-message": {
            const command = [tagText(text, "command-name"), tagText(text, "command-args")];
            return { role: "user", text: command.filter(Boolean).join(" "), untrusted: false };
        }
        case "bash-input":
            return { role: "user", text: `!${tagText(text, "bash-input")}`, untrusted: false };
        case "local-command-stdout":
        case "local-command-stderr":
            return commandOutput(
                text,
                ["local-command-stdout", "local-command-stderr"],
                "local-command",
            );
        case "bash-stdout":
        case "bash-stderr":
            return commandOutput(text, ["bash-stdout", "bash-stderr"], "user-shell");
        case "task-notification":
            return { role: "tool_result", text, toolName: "task-notification", untrusted: true };
        case "local-command-caveat":
            bump(filtered, "command-caveat");
            return undefined;
        default:
            return { role: "user", text, untrusted: false };
    }
}

/**
 * Return the source kind when a user-role message did not come from the person, for example a
 * background task notification or a message from a peer session. Return undefined for the person.
 * Records without origin fields come from older versions, where user-role text is the person.
 */
function nonHumanSource(origin: unknown, turnOrigin: unknown): string | undefined {
    const kind = str(obj(origin)?.kind) ?? str(turnOrigin);
    if (!kind || kind === "human") return undefined;
    return kind.replaceAll("_", "-");
}

/** Classify one text of a user-role message. Return undefined when nothing is left. */
function userTextPiece(
    raw: string,
    source: string | undefined,
    filtered: Record<string, number>,
): Piece | undefined {
    const text = stripReminders(raw, filtered).trim();
    if (!text) return undefined;
    const piece = classifyUserText(text, filtered);
    if (!source || piece?.role !== "user") return piece;
    return { role: "tool_result", text, toolName: source, untrusted: true };
}

/** The first cwd of a record of this session, else the first cwd of any record. */
function firstCwd(entries: readonly Entry[], sessionId: string): string | undefined {
    let fallback: string | undefined;
    for (const { record } of entries) {
        const cwd = str(record.cwd);
        if (!cwd) continue;
        const recordSession = str(record.sessionId);
        if (recordSession === undefined || recordSession === sessionId) return cwd;
        fallback ??= cwd;
    }
    return fallback;
}

function contentBlocks(content: unknown): unknown[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    return Array.isArray(content) ? content : [];
}

function isOwnFileDepth(root: string, path: string): boolean {
    return relative(root, path).split(sep).length === 2;
}

function parseClaudeSession(
    path: string,
    text: string,
    context: ParseContext = {},
): SessionEvidence | null {
    const sessionId = basename(path, ".jsonl");
    const memoryPath = context.memoryPath;
    const filtered: Record<string, number> = {};
    const warnings: string[] = [];
    const warned = new Set<string>();
    const warnOnce = (key: string, message: string): void => {
        if (warned.has(key)) return;
        warned.add(key);
        warnings.push(message);
    };

    const entries: Entry[] = parseJsonl(text, warnings).map(({ line, record }, index) => {
        const uuid = str(record.uuid);
        return uuid ? { index, line, record, uuid } : { index, line, record };
    });

    // Working folder for tool calls whose record has no cwd: the first own cwd, else any cwd.
    const sessionCwd = firstCwd(entries, sessionId);
    const callCwd = (record: Record<string, unknown>): string | undefined =>
        str(record.cwd) ?? sessionCwd;

    // First pass: index records and tool calls. The file order is not always the chain order,
    // for example a tool result can come before the record of its call. The events are sorted
    // into the chain order at the end.
    const byUuid = new Map<string, Entry>();
    const toolCalls = new Map<string, ToolCall>();
    for (const entry of entries) {
        const { record, uuid } = entry;
        if (uuid && !byUuid.has(uuid)) byUuid.set(uuid, entry);
        const message = obj(record.message);
        if (record.type !== "assistant" || !message) continue;
        for (const block of contentBlocks(message.content)) {
            const call = obj(block);
            const id = str(call?.id);
            if (!call || call.type !== "tool_use" || !id) continue;
            const name = str(call.name);
            const memory = isMemoryToolCall(
                name,
                argumentsToText(call.input),
                memoryPath,
                callCwd(record),
            );
            toolCalls.set(id, uuid ? { name, memory, recordUuid: uuid } : { name, memory });
        }
    }

    const foreignIds = new Set<string>();
    const pending: Pending[] = [];
    const emitted = new Set<string>();
    let conversationRecords = 0;
    let sidechainRecords = 0;
    const leafCandidates: Entry[] = [];
    let cwd: string | undefined;
    let fallbackCwd: string | undefined;
    let branch: string | undefined;
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    let legacyTitle: string | undefined;

    for (const entry of entries) {
        const { record, line, uuid } = entry;
        const type = str(record.type);
        // A resumed or forked session can start with copies of records from the earlier
        // session. That session has its own file, so the copies are skipped to import each
        // event once. The check uses only the record itself, so it is stable when the file grows.
        const recordSession = str(record.sessionId);
        const foreign = recordSession !== undefined && recordSession !== sessionId;
        const sidechain = record.isSidechain === true;
        const message = obj(record.message);
        const time = str(record.timestamp);

        // Session fields. The cwd is where the session started, so it stays stable when the
        // file grows. The branch is the latest one.
        const recordCwd = str(record.cwd);
        if (recordCwd) {
            fallbackCwd ??= recordCwd;
            if (!foreign) cwd ??= recordCwd;
        }
        const recordBranch = str(record.gitBranch);
        if (recordBranch) branch = recordBranch;
        if (type === "custom-title") customTitle = str(record.customTitle)?.trim() || customTitle;
        if (type === "ai-title") aiTitle = str(record.aiTitle)?.trim() || aiTitle;
        if (type === "summary") legacyTitle = str(record.summary)?.trim() || legacyTitle;

        if (type === "user" || type === "assistant") {
            conversationRecords++;
            if (sidechain) sidechainRecords++;
        }
        if (type && SKIPPED_TYPES.has(type)) {
            bump(filtered, type);
            continue;
        }
        if (sidechain) {
            bump(filtered, "sidechain");
            continue;
        }
        if (foreign) {
            bump(filtered, "foreign-session");
            if (recordSession) foreignIds.add(recordSession);
            continue;
        }

        const pieces: Array<Piece & { part: number; callId?: string }> = [];
        const add = (part: number, piece: Piece | undefined, callId?: string): void => {
            if (!piece) return;
            if (!piece.text.trim()) {
                bump(filtered, "empty");
                return;
            }
            pieces.push(callId ? { ...piece, part, callId } : { ...piece, part });
        };

        if (type === "user") {
            if (record.isCompactSummary === true) {
                const content = knownContent(message?.content, `line ${line}: Claude summary`);
                add(0, {
                    role: "summary",
                    text: blocksToText(content, `line ${line}: Claude summary`),
                    untrusted: false,
                });
            } else if (record.isMeta === true) {
                // Harness-generated context, for example an expanded skill prompt.
                bump(filtered, "meta");
            } else if (record.isVisibleInTranscriptOnly === true) {
                // Hidden from the main view, so it is harness text and not a user statement.
                bump(filtered, "transcript-only");
            } else {
                const source = nonHumanSource(record.origin, record.turnOrigin);
                const content = knownContent(message?.content, `line ${line}: Claude user`);
                contentBlocks(content).forEach((value, part) => {
                    const block = obj(value);
                    const blockType = str(block?.type);
                    if (blockType === "text") {
                        const where = `line ${line}: Claude user`;
                        add(part, userTextPiece(blockText(block, where), source, filtered));
                    } else if (blockType === "image" || blockType === "document") {
                        const placeholder = `[${blockType}]`;
                        add(
                            part,
                            source
                                ? {
                                      role: "tool_result",
                                      text: placeholder,
                                      toolName: source,
                                      untrusted: true,
                                  }
                                : { role: "user", text: placeholder, untrusted: false },
                        );
                    } else if (blockType === "tool_result") {
                        const callId = str(block?.tool_use_id);
                        const call = callId ? toolCalls.get(callId) : undefined;
                        // The harness also appends reminders to tool output.
                        const output = stripReminders(
                            blocksToText(block?.content, `line ${line}: Claude tool result`),
                            filtered,
                        );
                        const result = block?.is_error === true ? `[error] ${output}` : output;
                        const piece: Piece = { role: "tool_result", text: result, untrusted: true };
                        if (call?.name) piece.toolName = call.name;
                        add(part, piece, callId);
                    } else {
                        bump(filtered, `block:${blockType ?? "unknown"}`);
                        warnOnce(`block:${blockType}`, `unknown user block "${blockType}" skipped`);
                    }
                });
            }
        } else if (type === "assistant") {
            if (record.isApiErrorMessage === true) {
                const where = `line ${line}: Claude API error`;
                const error =
                    blocksToText(message?.content, where) || str(record.error) || "API error";
                add(0, { role: "notice", text: error, untrusted: false });
            } else {
                const content = knownContent(message?.content, `line ${line}: Claude assistant`);
                contentBlocks(content).forEach((value, part) => {
                    const block = obj(value);
                    const blockType = str(block?.type);
                    if (blockType === "text") {
                        add(part, {
                            role: "assistant",
                            text: blockText(block, `line ${line}: Claude assistant`),
                            untrusted: false,
                        });
                    } else if (blockType === "thinking" || blockType === "redacted_thinking") {
                        bump(filtered, "thinking");
                    } else if (blockType === "tool_use") {
                        const name = str(block?.name) ?? "";
                        const args = argumentsToText(block?.input);
                        const piece: Piece = {
                            role: "tool_call",
                            text: `${name} ${args}`.trim(),
                            untrusted: false,
                        };
                        if (name) piece.toolName = name;
                        add(part, piece);
                    } else {
                        bump(filtered, `block:${blockType ?? "unknown"}`);
                        warnOnce(
                            `block:${blockType}`,
                            `unknown assistant block "${blockType}" skipped`,
                        );
                    }
                });
            }
        } else if (type === "system") {
            const subtype = str(record.subtype) ?? "unknown";
            if (subtype === "local_command" && record.isMeta !== true) {
                // Newer versions log local slash commands and their output as system records.
                add(0, userTextPiece(str(record.content) ?? "", undefined, filtered));
            } else {
                bump(filtered, `system:${subtype}`);
            }
        } else if (type === "attachment") {
            const attachment = obj(record.attachment);
            // A prompt that the person queued during a turn is delivered as an attachment and
            // never as a user record. Other attachments are harness context.
            if (attachment?.type === "queued_command" && attachment.isMeta !== true) {
                const source = nonHumanSource(attachment.origin, undefined);
                const prompt = blocksToText(
                    attachment.prompt,
                    `line ${line}: Claude queued prompt`,
                );
                add(0, userTextPiece(prompt, source, filtered));
            } else {
                bump(filtered, attachment?.type === "queued_command" ? "meta" : "attachment");
            }
        } else {
            const role = str(message?.role);
            if (role === "user" || role === "assistant") {
                throw new AdapterFormatError(
                    `line ${line}: unknown record type "${type ?? ""}" carries a ${role} message`,
                );
            }
            bump(filtered, `unknown:${type ?? "none"}`);
            warnOnce(`type:${type}`, `unknown record type "${type ?? ""}" skipped`);
            continue;
        }

        if (uuid && (type === "user" || type === "assistant" || pieces.length > 0)) {
            leafCandidates.push(entry);
        }
        if (pieces.length === 0) continue;
        if (uuid && emitted.has(uuid)) {
            bump(filtered, "duplicate");
            warnOnce(`dup:${uuid}`, `line ${line}: duplicate record uuid skipped`);
            continue;
        }
        if (uuid) emitted.add(uuid);
        else warnOnce("no-uuid", `line ${line}: record without uuid uses a line-based key`);

        // Text and images of one user message become one event.
        const merged: typeof pieces = [];
        for (const piece of pieces) {
            const last = merged[merged.length - 1];
            if (last && last.role === "user" && piece.role === "user") {
                last.text = `${last.text}\n${piece.text}`;
            } else {
                merged.push({ ...piece });
            }
        }

        for (const piece of merged) {
            const call = piece.callId ? toolCalls.get(piece.callId) : undefined;
            const event: EvidenceEvent = {
                key: `${uuid ?? `line${line}`}#${piece.part}`,
                role: piece.role,
                text: piece.text,
                sourceLine: line,
                memoryDerived:
                    (piece.role === "tool_call" &&
                        isMemoryToolCall(
                            piece.toolName,
                            piece.text,
                            memoryPath,
                            callCwd(record),
                        )) ||
                    call?.memory === true ||
                    containsMemoryContext(piece.text),
                untrusted: piece.untrusted,
                active: false,
            };
            if (time) event.time = time;
            if (piece.toolName) event.toolName = piece.toolName;
            const item: Pending = { event, entryIndex: entry.index };
            if (uuid) item.recordUuid = uuid;
            if (call?.recordUuid) item.callRecord = call.recordUuid;
            pending.push(item);
        }
    }

    if (conversationRecords > 0 && sidechainRecords === conversationRecords) return null;

    if (foreignIds.size > 0) {
        const copied = filtered["foreign-session"] ?? 0;
        const sources = [...foreignIds].join(", ");
        warnings.push(`skipped ${copied} records copied from earlier session ${sources}`);
    }

    const places = chainPlaces(entries, byUuid);
    const placeAt = (index: number): ChainPlace => places.get(index) ?? { pos: index, depth: 0 };
    const chainOrder = (a: ChainPlace, b: ChainPlace): number => a.pos - b.pos || a.depth - b.depth;

    // The leaf is the last candidate in chain order, not the last record in the file. A record
    // can come after its child in the file, and then the last record is not the newest message.
    // On a tie the later record in the file wins, as in the event sort below.
    let leaf: Entry | undefined;
    for (const entry of leafCandidates) {
        if (!leaf || chainOrder(placeAt(entry.index), placeAt(leaf.index)) >= 0) leaf = entry;
    }
    const active = leaf ? activePath(leaf, entries, byUuid, warnings) : new Set<string>();
    for (const { event, recordUuid, callRecord } of pending) {
        event.active =
            (recordUuid !== undefined && active.has(recordUuid)) ||
            (callRecord !== undefined && active.has(callRecord));
    }

    // The sort is stable, so records with the same place, and the parts of a record, keep the
    // file order.
    const events = pending
        .toSorted((a, b) => chainOrder(placeAt(a.entryIndex), placeAt(b.entryIndex)))
        .map((item) => item.event);
    const evidence: SessionEvidence = {
        harness: "claude",
        sessionId,
        sourcePath: path,
        events,
        filtered,
        warnings,
    };
    const startCwd = cwd ?? fallbackCwd;
    if (startCwd) evidence.cwd = startCwd;
    if (branch) evidence.branch = branch;
    const title = customTitle ?? aiTitle ?? legacyTitle;
    if (title) evidence.title = title;
    const startedAt = events.find((event) => event.time)?.time;
    if (startedAt) evidence.startedAt = startedAt;
    const updatedAt = events.findLast((event) => event.time)?.time;
    if (updatedAt) evidence.updatedAt = updatedAt;
    return evidence;
}

/** Place of a record on its parent chain. */
interface ChainPlace {
    /** Highest file index on the chain from the root to the record. */
    pos: number;
    /** Number of parents above the record. */
    depth: number;
}

/**
 * Place each record on its `parentUuid` chain, so that L4 keeps the chain order (§2). The file
 * order is not always the chain order: a record can come before its parent, for example a tool
 * result before its call. A record never sorts before its parent when the events sort by `pos`,
 * then by `depth`. A file in chain order keeps its order. A record in a parent cycle is placed as
 * a root, and `activePath` reports the cycle when it is on the active path.
 */
function chainPlaces(
    entries: readonly Entry[],
    byUuid: ReadonlyMap<string, Entry>,
): Map<number, ChainPlace> {
    const places = new Map<number, ChainPlace>();
    for (const start of entries) {
        if (places.has(start.index)) continue;
        // Walk up to a placed record, a root or a cycle. Then place the walk from the top down.
        const walk: Entry[] = [];
        const onWalk = new Set<number>();
        let current: Entry | undefined = start;
        while (current && !places.has(current.index) && !onWalk.has(current.index)) {
            walk.push(current);
            onWalk.add(current.index);
            const parent = str(current.record.parentUuid);
            current = parent ? byUuid.get(parent) : undefined;
        }
        let above = current ? places.get(current.index) : undefined;
        for (const entry of walk.reverse()) {
            const placed: ChainPlace = above
                ? { pos: Math.max(entry.index, above.pos), depth: above.depth + 1 }
                : { pos: entry.index, depth: 0 };
            places.set(entry.index, placed);
            above = placed;
        }
    }
    return places;
}

/**
 * Collect the uuids of the active conversation path. The walk starts at the leaf and follows
 * `parentUuid`. A compact boundary has no parent, so the walk follows `logicalParentUuid`.
 *
 * Some records are on short side branches, but they are not abandoned:
 * - Claude Code writes each content block of a response as its own record. So all records of an
 *   active response (same `message.id`) are active. The caller also makes a tool result active
 *   when its call is active, because parallel tool results are side branches.
 * - Harness records (system and attachment records, for example a local command and its output)
 *   can branch off the path. A chain of harness records that starts on the path is active.
 * A rewind or an edited prompt starts a side branch with a user or assistant record, so that
 * branch stays inactive.
 */
function activePath(
    leaf: Entry,
    entries: readonly Entry[],
    byUuid: ReadonlyMap<string, Entry>,
    warnings: string[],
): Set<string> {
    const active = new Set<string>();
    let current: Entry | undefined = leaf;
    while (current?.uuid) {
        if (active.has(current.uuid)) {
            throw new AdapterFormatError(`line ${current.line}: parent chain has a cycle`);
        }
        active.add(current.uuid);
        current = parentEntry(current, entries, byUuid, warnings);
    }

    const responses = new Set<string>();
    for (const entry of entries) {
        if (!entry.uuid || !active.has(entry.uuid)) continue;
        const id =
            entry.record.type === "assistant" ? str(obj(entry.record.message)?.id) : undefined;
        if (id) responses.add(id);
    }
    for (const entry of entries) {
        if (entry.uuid && entry.record.type === "assistant") {
            const id = str(obj(entry.record.message)?.id);
            if (id && responses.has(id)) active.add(entry.uuid);
        }
    }

    for (const entry of entries) {
        const chain: string[] = [];
        let current: Entry | undefined = entry;
        while (current?.uuid && !active.has(current.uuid) && !chain.includes(current.uuid)) {
            const type = current.record.type;
            if (type === "user" || type === "assistant") break;
            chain.push(current.uuid);
            current = byUuid.get(str(current.record.parentUuid) ?? "");
        }
        if (current?.uuid && active.has(current.uuid)) {
            for (const uuid of chain) active.add(uuid);
        }
    }
    return active;
}

function parentEntry(
    entry: Entry,
    entries: readonly Entry[],
    byUuid: ReadonlyMap<string, Entry>,
    warnings: string[],
): Entry | undefined {
    const parent = str(entry.record.parentUuid);
    if (parent) {
        const found = byUuid.get(parent);
        if (!found) warnings.push(`line ${entry.line}: parent record is missing`);
        return found;
    }
    const logical = str(entry.record.logicalParentUuid);
    if (!logical) return undefined;
    const found = byUuid.get(logical);
    if (found && found.index < entry.index) return found;
    // Some boundaries link to a record that is not in the file, or to a later record. In real
    // files the logical parent is the last record with a uuid before the boundary, so the walk
    // continues there.
    warnings.push(
        `line ${entry.line}: compact boundary links to a ${found ? "later" : "missing"} record`,
    );
    for (let i = entry.index - 1; i >= 0; i--) {
        const previous = entries[i];
        if (previous?.uuid) return previous;
    }
    return undefined;
}

export const claudeAdapter: HarnessAdapter = {
    harness: "claude",
    discover(root: string) {
        // Only `<root>/<project>/<session>.jsonl`. Deeper files are subagent traces.
        return findJsonlFiles("claude", root, 1)
            .filter((file) => isOwnFileDepth(root, file.path))
            .sort((a, b) => a.path.localeCompare(b.path));
    },
    parse: parseClaudeSession,
};
