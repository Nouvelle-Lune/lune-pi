import type { EventRole } from "../core/types.ts";
import {
    PI_L1_CUSTOM_TYPE,
    argumentsToText,
    blockText,
    blocksToText,
    bump,
    containsMemoryContext,
    findJsonlFiles,
    isMemoryToolCall,
    isMemoryToolName,
    knownContent,
    obj,
    parseJsonl,
    rejectUnknownTextBlock,
    str,
} from "./common.ts";
import { AdapterFormatError } from "./types.ts";
import type {
    EvidenceEvent,
    HarnessAdapter,
    MemoryPathTest,
    ParseContext,
    SessionEvidence,
} from "./types.ts";

/**
 * Pi keeps one folder for each working directory below the sessions root. Files in deeper
 * folders are run files of subagent extensions, not main sessions.
 */
const SESSION_DEPTH = 1;

/** Newest Pi session format version that this adapter knows. */
const KNOWN_VERSION = 3;

/** Custom entry that pi-subagent writes into a run file. Its `data.runId` is the run file id. */
const SUBAGENT_RUN_TYPE = "lune-subagent-run";

/** Entry types that hold state or settings and no conversation text. */
const METADATA_TYPES = new Set([
    "custom",
    "model_change",
    "thinking_level_change",
    "usage",
    "label",
    "session_info",
]);

type Draft = Omit<EvidenceEvent, "key" | "sourceLine" | "time" | "active">;

interface DraftFlags {
    toolName?: string | undefined;
    memoryDerived?: boolean;
    untrusted?: boolean;
}

interface Entry {
    /** Tree id. A record without an id gets a line-based id. */
    id: string;
    /** Key prefix of the events of this entry. Unique in the file. */
    keyBase: string;
    parentId: string | undefined;
    type: string;
    line: number;
    record: Record<string, unknown>;
}

interface ParseState {
    filtered: Record<string, number>;
    warnings: string[];
    warned: Set<string>;
    /** Tool call ids of memory-derived tool calls. Their results are memory-derived too. */
    memoryCalls: Set<string>;
    /** Extra test for memory file paths of the home in use. */
    memoryPath?: MemoryPathTest;
    /** Working folder of the session, for relative memory paths in tool calls. */
    cwd?: string;
}

export const piAdapter: HarnessAdapter = {
    harness: "pi",
    discover(root) {
        return findJsonlFiles("pi", root, SESSION_DEPTH);
    },
    parse(path, text, context) {
        return parsePiSession(path, text, context);
    },
};

function parsePiSession(
    path: string,
    text: string,
    context: ParseContext = {},
): SessionEvidence | null {
    const warnings: string[] = [];
    const records = parseJsonl(text, warnings);
    const first = records[0];
    // An empty file, or a header line that Pi is still writing.
    if (!first) return null;

    const header = first.record;
    const sessionId = str(header.id);
    if (header.type !== "session" || !sessionId) {
        throw new AdapterFormatError("Pi session file does not start with a session header");
    }
    const version = typeof header.version === "number" ? header.version : 1;
    if (version > KNOWN_VERSION) warnings.push(`unknown Pi session version ${version}`);

    const entries = readEntries(records.slice(1), version, warnings);
    if (isSubagentRun(entries, sessionId)) return null;

    const onPath = activePath(entries);
    const omitted = omittedTargets(entries, onPath);
    const cwd = str(header.cwd);
    const state: ParseState = { filtered: {}, warnings, warned: new Set(), memoryCalls: new Set() };
    if (context.memoryPath) state.memoryPath = context.memoryPath;
    if (cwd) state.cwd = cwd;
    const events: EvidenceEvent[] = [];
    let title: string | undefined;
    let updatedAt: string | undefined;

    for (const entry of entries) {
        if (entry.type === "session_info") {
            // The latest name wins. An empty name clears the title.
            title = str(entry.record.name)?.trim() || undefined;
        }
        const drafts = entryDrafts(entry, state);
        if (drafts.length === 0) continue;
        const time = isoTime(entry.record.timestamp);
        const active = onPath.has(entry) && !omitted.has(entry.id);
        drafts.forEach((draft, part) => {
            events.push({
                key: `${entry.keyBase}#${part}`,
                ...draft,
                ...(time ? { time } : {}),
                sourceLine: entry.line,
                active,
            });
        });
        if (time && (!updatedAt || time > updatedAt)) updatedAt = time;
    }

    const startedAt = isoTime(header.timestamp);
    return {
        harness: "pi",
        sessionId,
        sourcePath: path,
        ...(cwd ? { cwd } : {}),
        ...(title ? { title } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        events,
        filtered: state.filtered,
        warnings,
    };
}

function readEntries(
    records: Array<{ line: number; record: Record<string, unknown> }>,
    version: number,
    warnings: string[],
): Entry[] {
    const entries: Entry[] = [];
    const keys = new Set<string>();
    let previous: string | undefined;
    for (const { line, record } of records) {
        const rawId = str(record.id);
        // Version 1 entries have no ids. Pi links them in file order.
        if (!rawId && version >= 2) warnings.push(`line ${line}: entry has no id`);
        const id = rawId ?? `L${line}`;
        let keyBase = id;
        if (keys.has(keyBase)) {
            warnings.push(`line ${line}: duplicate entry id`);
            keyBase = `${id}@L${line}`;
        }
        keys.add(keyBase);
        entries.push({
            id,
            keyBase,
            parentId: rawId ? str(record.parentId) : previous,
            type: str(record.type) ?? "(none)",
            line,
            record,
        });
        previous = id;
    }
    return entries;
}

/** A pi-subagent run file is not a conversation session of its own. */
function isSubagentRun(entries: Entry[], sessionId: string): boolean {
    return entries.some(
        (entry) =>
            entry.type === "custom" &&
            entry.record.customType === SUBAGENT_RUN_TYPE &&
            obj(entry.record.data)?.runId === sessionId,
    );
}

/** Entries from the leaf back to the root. Pi takes the last entry of the file as the leaf. */
function activePath(entries: Entry[]): Set<Entry> {
    const byId = new Map<string, Entry>();
    for (const entry of entries) byId.set(entry.id, entry);
    const path = new Set<Entry>();
    let current = entries[entries.length - 1];
    while (current && !path.has(current)) {
        path.add(current);
        current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    return path;
}

/**
 * Targets that the latest `context_edit` on the active path omits. Pi omits a failed attempt
 * before it retries, so the target is rolled back. A replacement changes only the model context,
 * and the raw entry stays the record of what happened.
 */
function omittedTargets(entries: Entry[], path: Set<Entry>): Set<string> {
    const omit = new Map<string, boolean>();
    for (const entry of entries) {
        if (entry.type !== "context_edit" || !path.has(entry)) continue;
        const target = str(entry.record.targetId);
        if (target) omit.set(target, entry.record.replacement === null);
    }
    const out = new Set<string>();
    for (const [target, omitted] of omit) if (omitted) out.add(target);
    return out;
}

function entryDrafts(entry: Entry, state: ParseState): Draft[] {
    const { record } = entry;
    switch (entry.type) {
        case "message":
            return messageDrafts(entry, state);
        case "custom_message":
            return customDrafts(record, entry.line, state);
        case "compaction":
        case "branch_summary":
            return summaryDrafts(str(record.summary), state);
        case "context_edit":
            bump(state.filtered, "context_edit");
            return [];
        default:
            if (METADATA_TYPES.has(entry.type)) {
                bump(state.filtered, entry.type);
                return [];
            }
            return unknownEntry(entry, state);
    }
}

function messageDrafts(entry: Entry, state: ParseState): Draft[] {
    const message = obj(entry.record.message);
    const role = str(message?.role);
    if (!message || !role) {
        throw new AdapterFormatError(`line ${entry.line}: Pi message entry has no role`);
    }
    switch (role) {
        case "user":
            return userDrafts(message, entry.line, state);
        case "assistant":
            return assistantDrafts(message, entry.line, state);
        case "toolResult":
            return [toolResultDraft(message, entry.line, state)];
        case "bashExecution":
            return bashDrafts(message, state);
        // Version 2 files call custom messages `hookMessage`.
        case "custom":
        case "hookMessage":
            return customDrafts(message, entry.line, state);
        case "compactionSummary":
        case "branchSummary":
            return summaryDrafts(str(message.summary), state);
        case "system":
            bump(state.filtered, "system");
            return [];
        default:
            bump(state.filtered, `unknown_role:${role}`);
            warnOnce(state, `role:${role}`, `unknown Pi message role: ${role}`);
            return [];
    }
}

function userDrafts(message: Record<string, unknown>, line: number, state: ParseState): Draft[] {
    const text = contentText(message.content, line, "user");
    if (!text.trim()) {
        bump(state.filtered, "empty:user");
        return [];
    }
    return [draft("user", text, { memoryDerived: containsMemoryContext(text) })];
}

function assistantDrafts(
    message: Record<string, unknown>,
    line: number,
    state: ParseState,
): Draft[] {
    const content = knownContent(message.content, `line ${line}: Pi assistant`);
    const blocks: unknown[] =
        typeof content === "string" ? [{ type: "text", text: content }] : content;
    const drafts: Draft[] = [];
    let texts: string[] = [];
    // Text blocks between tool calls become one assistant event.
    const flush = (): void => {
        const text = texts.join("\n");
        texts = [];
        if (text.trim()) {
            drafts.push(draft("assistant", text, { memoryDerived: containsMemoryContext(text) }));
        }
    };
    for (const block of blocks) {
        const record = obj(block);
        const type = str(record?.type) ?? "(none)";
        if (type === "text") {
            const text = blockText(record, `line ${line}: Pi assistant`);
            if (text) texts.push(text);
        } else if (type === "toolCall" && record) {
            flush();
            drafts.push(toolCallDraft(record, state));
        } else if (type === "thinking") {
            bump(state.filtered, "thinking");
        } else {
            rejectUnknownTextBlock(record, `line ${line}: Pi assistant`);
            bump(state.filtered, `block:${type}`);
            warnOnce(state, `block:${type}`, `unknown Pi assistant block type: ${type}`);
        }
    }
    flush();
    const notice = stopNotice(message);
    if (notice) drafts.push(notice);
    return drafts;
}

function toolCallDraft(block: Record<string, unknown>, state: ParseState): Draft {
    const toolName = str(block.name);
    const args = argumentsToText(block.arguments);
    const memoryDerived = isMemoryToolCall(toolName, args, state.memoryPath, state.cwd);
    const id = str(block.id);
    if (memoryDerived && id) state.memoryCalls.add(id);
    return draft("tool_call", args, { toolName, memoryDerived });
}

/** A turn that did not end normally leaves a runtime marker. */
function stopNotice(message: Record<string, unknown>): Draft | undefined {
    switch (message.stopReason) {
        case "aborted":
            return draft("notice", "Assistant turn aborted");
        case "error": {
            const error = str(message.errorMessage)?.trim();
            return error
                ? draft("notice", `Assistant turn failed: ${error}`, { untrusted: true })
                : draft("notice", "Assistant turn failed");
        }
        case "length":
            return draft("notice", "Assistant turn stopped at the output token limit");
        default:
            return undefined;
    }
}

function toolResultDraft(message: Record<string, unknown>, line: number, state: ParseState): Draft {
    const toolName = str(message.toolName);
    const callId = str(message.toolCallId);
    const where = `line ${line}: Pi tool result`;
    const output = blocksToText(knownContent(message.content, where), where);
    const text = message.isError === true ? (output ? `[error] ${output}` : "[error]") : output;
    const memoryDerived =
        (callId !== undefined && state.memoryCalls.has(callId)) ||
        isMemoryToolName(toolName) ||
        containsMemoryContext(output) ||
        nestedMemoryCall(message.nestedCalls, state);
    return draft("tool_result", text, { toolName, memoryDerived, untrusted: true });
}

/** Calls that a tool made inside its own run. They give no events, but can read memory. */
function nestedMemoryCall(value: unknown, state: ParseState): boolean {
    const calls = obj(value)?.calls;
    if (!Array.isArray(calls) || calls.length === 0) return false;
    bump(state.filtered, "nested_call", calls.length);
    return calls.some((call) => {
        const record = obj(call);
        return isMemoryToolCall(
            str(record?.name),
            argumentsToText(record?.arguments),
            state.memoryPath,
            state.cwd,
        );
    });
}

/** A `!` command that the user ran. The output comes from outside the conversation. */
function bashDrafts(message: Record<string, unknown>, state: ParseState): Draft[] {
    const command = str(message.command) ?? "";
    const output = str(message.output) ?? "";
    const memoryDerived = isMemoryToolCall("bash", command, state.memoryPath, state.cwd);
    const notes: string[] = [];
    if (message.cancelled === true) notes.push("[cancelled]");
    if (message.truncated === true) notes.push("[output truncated]");
    if (typeof message.exitCode === "number" && message.exitCode !== 0) {
        notes.push(`[exit code ${message.exitCode}]`);
    }
    const result = [output, ...notes].filter((part) => part !== "").join("\n");
    return [
        draft("tool_call", command, { toolName: "bash", memoryDerived }),
        draft("tool_result", result, {
            toolName: "bash",
            memoryDerived: memoryDerived || containsMemoryContext(output),
            untrusted: true,
        }),
    ];
}

/**
 * An extension message. Injected L1 context is kept as memory-derived. Other messages are kept
 * only when the user sees them. Extensions write them, so their text is untrusted.
 */
function customDrafts(record: Record<string, unknown>, line: number, state: ParseState): Draft[] {
    const text = blocksToText(record.content, `line ${line}: Pi custom message`);
    const isL1 = record.customType === PI_L1_CUSTOM_TYPE;
    if (!isL1 && record.display !== true) {
        bump(state.filtered, "custom_hidden");
        return [];
    }
    if (!text.trim()) {
        bump(state.filtered, "empty:custom");
        return [];
    }
    if (isL1) return [draft("notice", text, { memoryDerived: true })];
    return [draft("notice", text, { memoryDerived: containsMemoryContext(text), untrusted: true })];
}

function summaryDrafts(summary: string | undefined, state: ParseState): Draft[] {
    if (!summary?.trim()) {
        bump(state.filtered, "empty:summary");
        return [];
    }
    return [draft("summary", summary, { memoryDerived: containsMemoryContext(summary) })];
}

function unknownEntry(entry: Entry, state: ParseState): Draft[] {
    const role = str(obj(entry.record.message)?.role);
    if (role === "user" || role === "assistant") {
        throw new AdapterFormatError(
            `line ${entry.line}: unknown Pi entry type ${entry.type} holds a ${role} message`,
        );
    }
    bump(state.filtered, `unknown:${entry.type}`);
    warnOnce(state, `type:${entry.type}`, `unknown Pi entry type: ${entry.type}`);
    return [];
}

function contentText(content: unknown, line: number, role: string): string {
    const where = `line ${line}: Pi ${role}`;
    return blocksToText(knownContent(content, where), where);
}

function draft(role: EventRole, text: string, flags: DraftFlags = {}): Draft {
    return {
        role,
        text,
        ...(flags.toolName !== undefined ? { toolName: flags.toolName } : {}),
        memoryDerived: flags.memoryDerived ?? false,
        untrusted: flags.untrusted ?? false,
    };
}

function warnOnce(state: ParseState, id: string, warning: string): void {
    if (state.warned.has(id)) return;
    state.warned.add(id);
    state.warnings.push(warning);
}

/** Pi writes ISO entry timestamps. Numbers are epoch milliseconds. */
function isoTime(value: unknown): string | undefined {
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
