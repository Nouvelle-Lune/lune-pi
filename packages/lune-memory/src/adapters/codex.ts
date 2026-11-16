import { basename } from "node:path";

import { MEMORY_CONTEXT_TAG, type EventRole } from "../core/types.ts";
import { hash8 } from "../core/util.ts";
import {
    argumentsToText,
    blocksToText,
    bump,
    containsMemoryContext,
    findJsonlFiles,
    isMemoryToolCall,
    isMemoryToolName,
    obj,
    parseJsonl,
    str,
} from "./common.ts";
import {
    AdapterFormatError,
    type EvidenceEvent,
    type HarnessAdapter,
    type SessionEvidence,
} from "./types.ts";

/*
 * OpenAI Codex adapter. The CLI and the desktop app write the same rollout format:
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. Each line is
 * `{timestamp, type, payload}` and the first line is `session_meta`.
 *
 * Old rollouts (2025) use a legacy format: the first line is a header `{id, timestamp, git?}`
 * without `type`, and the next lines are bare response items or `{record_type}` state records.
 * The adapter reads both formats.
 */

type Rec = Record<string, unknown>;

/** Top-level record types that hold no conversation content. */
const SKIPPED_RECORDS = new Set([
    "turn_context",
    "token_usage_record",
    "world_state",
    "inter_agent_communication_metadata",
]);

/** Response item types that hold no usable evidence. Most are encrypted or tool metadata. */
const SKIPPED_ITEMS = new Set([
    "reasoning",
    "additional_tools",
    "compaction",
    "ghost_snapshot",
    "tool_search_call",
    "tool_search_output",
    "image_generation_call",
]);

/** Block types that carry text in messages and tool outputs. */
const TEXT_BLOCKS = ["input_text", "output_text", "text"];

/**
 * Wrapper tags that Codex puts at the start of a user text block to inject context. The block is
 * not user input. Text after the closing tag is user input.
 */
const INJECTED_TAGS = new Set([
    "environment_context",
    "codex_internal_context",
    "external_codex_apps_open_page",
    "recommended_plugins",
    "subagent_notification",
    "turn_aborted",
    "heartbeat",
    "guardian_tool_descriptions",
    "in-app-browser-context",
    "user_instructions",
    "user_shell_command",
    "skill",
]);

/** Wrapper tags in user text blocks that hold real user input, or L1 context to keep and mark. */
const KEPT_TAGS = new Set(["send_user_message_question_reply", MEMORY_CONTEXT_TAG]);

/** Codex injects the project instructions as a user text block with this heading. */
const AGENTS_PREFIX = "# AGENTS.md instructions";

/** First words of the Codex compaction summary prefix (`SUMMARY_PREFIX` in codex-rs). */
const SUMMARY_PREFIX = "Another language model started to solve this problem";

const LEAD_TAG = /^<([A-Za-z][\w-]*)(?=[\s/>])/u;
/** A snake_case or kebab-case tag name. A block that this tag wraps fully is injected context. */
const WRAPPER_TAG = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/u;
const IMAGE_OPEN = /^<image\b[^>]*>$/u;
const CWD_ELEMENT = /<cwd>([^<]*)<\/cwd>/u;

interface Header {
    sessionId: string;
    paginated: boolean;
    legacy: boolean;
    subagent: boolean;
    cwd?: string;
    branch?: string;
    startedAt?: string;
}

interface CallInfo {
    toolName: string;
    memory: boolean;
}

interface EmitOptions {
    toolName?: string;
    memoryDerived?: boolean;
    untrusted?: boolean;
}

interface State {
    events: EvidenceEvent[];
    filtered: Record<string, number>;
    warnings: string[];
    warned: Set<string>;
    calls: Map<string, CallInfo>;
    /** Event index of each active user turn start, oldest first. A rollback pops from the end. */
    turnStarts: number[];
    /** cwd from the first `<environment_context>` block. Legacy rollouts have no other source. */
    contextCwd?: string;
    line: number;
    part: number;
    time?: string;
}

function warnOnce(state: State, key: string, message: string): void {
    if (state.warned.has(key)) return;
    state.warned.add(key);
    state.warnings.push(message);
}

function emit(state: State, role: EventRole, text: string, options: EmitOptions = {}): void {
    const event: EvidenceEvent = {
        key: `L${state.line}#${state.part}`,
        role,
        text,
        sourceLine: state.line,
        memoryDerived: options.memoryDerived ?? containsMemoryContext(text),
        untrusted: options.untrusted ?? false,
        active: true,
    };
    if (state.time !== undefined) event.time = state.time;
    if (options.toolName !== undefined) event.toolName = options.toolName;
    state.events.push(event);
    state.part++;
}

function readHeader(record: Rec, line: number): Header | undefined {
    if (record.type === "session_meta") {
        const payload = obj(record.payload);
        const sessionId = str(payload?.id);
        if (!payload || !sessionId) {
            throw new AdapterFormatError(`line ${line}: session_meta has no session id`);
        }
        const source = obj(payload.source);
        return {
            sessionId,
            paginated: payload.history_mode === "paginated",
            legacy: false,
            subagent: source !== undefined && "subagent" in source,
            cwd: str(payload.cwd),
            branch: str(obj(payload.git)?.branch),
            startedAt: str(record.timestamp) ?? str(payload.timestamp),
        };
    }
    const sessionId = str(record.id);
    const startedAt = str(record.timestamp);
    if (record.type === undefined && sessionId && startedAt) {
        return {
            sessionId,
            paginated: false,
            legacy: true,
            subagent: false,
            branch: str(obj(record.git)?.branch),
            startedAt,
        };
    }
    return undefined;
}

/** Throw when an unknown record holds a conversation message, else count and skip it. */
function skipUnknown(state: State, kind: string, type: string, value: unknown): void {
    const role = str(obj(value)?.role);
    if (role === "user" || role === "assistant") {
        throw new AdapterFormatError(
            `line ${state.line}: unknown ${kind} type "${type}" has role "${role}"`,
        );
    }
    bump(state.filtered, `unknown:${type}`);
    warnOnce(state, `${kind}:${type}`, `unknown ${kind} type "${type}" skipped`);
}

function handleRecord(state: State, record: Rec): void {
    const type = str(record.type);
    if (type === undefined) {
        bump(state.filtered, "no_type");
        return;
    }
    switch (type) {
        case "response_item": {
            const payload = obj(record.payload);
            if (payload) handleItem(state, payload);
            else bump(state.filtered, "no_payload");
            return;
        }
        case "event_msg":
            handleEvent(state, obj(record.payload));
            return;
        case "compacted":
            handleCompacted(state, obj(record.payload));
            return;
        case "session_meta":
            // Forked and subagent rollouts repeat the parent session_meta.
            bump(state.filtered, "session_meta");
            return;
    }
    if (SKIPPED_RECORDS.has(type)) bump(state.filtered, type);
    else skipUnknown(state, "record", type, record.payload ?? record);
}

function handleLegacyRecord(state: State, record: Rec): void {
    const recordType = str(record.record_type);
    if (recordType !== undefined) bump(state.filtered, recordType);
    else if (typeof record.type === "string") handleItem(state, record);
    else bump(state.filtered, "no_type");
}

function handleItem(state: State, item: Rec): void {
    const type = str(item.type);
    switch (type) {
        case undefined:
            bump(state.filtered, "no_type");
            return;
        case "message":
            handleMessage(state, item);
            return;
        case "function_call":
            emitCall(state, str(item.call_id), toolName(item), compactArguments(item.arguments));
            return;
        case "custom_tool_call":
            emitCall(state, str(item.call_id), toolName(item), str(item.input) ?? "");
            return;
        case "local_shell_call": {
            const action = obj(item.action);
            const command = Array.isArray(action?.command)
                ? action.command.filter((part) => typeof part === "string").join(" ")
                : argumentsToText(action);
            emitCall(state, str(item.call_id) ?? str(item.id), "local_shell", command);
            return;
        }
        case "web_search_call":
            // Codex runs web search on the server. No output item follows.
            emitCall(state, undefined, "web_search", argumentsToText(item.action));
            return;
        case "function_call_output":
        case "custom_tool_call_output":
            handleOutput(state, item);
            return;
        case "agent_message":
            handleAgentMessage(state, item);
            return;
    }
    if (SKIPPED_ITEMS.has(type)) bump(state.filtered, type);
    else skipUnknown(state, "response_item", type, item);
}

function handleMessage(state: State, item: Rec): void {
    const role = str(item.role);
    if (role === "user") {
        handleUserMessage(state, item.content);
        return;
    }
    if (role === "assistant") {
        const text = blocksToText(item.content, TEXT_BLOCKS).trim();
        if (text) emit(state, "assistant", text);
        else bump(state.filtered, "empty");
        return;
    }
    if (role === "developer" || role === "system") {
        bump(state.filtered, role);
        return;
    }
    bump(state.filtered, `role:${role ?? "none"}`);
    warnOnce(state, `role:${role}`, `message role "${role ?? ""}" skipped`);
}

function handleUserMessage(state: State, content: unknown): void {
    const blocks: unknown[] =
        typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
    const parts: string[] = [];
    let reason: string | undefined;
    for (const block of blocks) {
        const record = typeof block === "string" ? { type: "input_text", text: block } : obj(block);
        const type = str(record?.type);
        if (type === "input_image" || type === "image") {
            parts.push("[image]");
            continue;
        }
        const raw = str(record?.text);
        if (raw === undefined) continue;
        const result = stripInjected(state, raw);
        if (result.text) parts.push(result.text);
        reason ??= result.reason;
    }
    if (parts.length === 0) {
        bump(state.filtered, reason ?? "empty");
        return;
    }
    state.turnStarts.push(state.events.length);
    emit(state, "user", parts.join("\n"));
}

/**
 * Remove injected context from one user text block. Return the user text that remains, and the
 * filter reason when the block held injected context.
 */
function stripInjected(state: State, raw: string): { text: string; reason?: string } {
    const text = raw.trim();
    if (text.startsWith(AGENTS_PREFIX)) return { text: "", reason: "injected" };
    // Codex wraps each pasted image in `<image name=...>` and `</image>` text blocks.
    if (text === "</image>" || IMAGE_OPEN.test(text)) return { text: "" };
    const tag = LEAD_TAG.exec(text)?.[1];
    if (tag === undefined || KEPT_TAGS.has(tag)) return { text };
    const close = `</${tag}>`;
    if (INJECTED_TAGS.has(tag)) {
        if (tag === "environment_context" && state.contextCwd === undefined) {
            state.contextCwd = CWD_ELEMENT.exec(text)?.[1]?.trim() || undefined;
        }
        const end = text.indexOf(close);
        if (end < 0) return { text: "", reason: "injected" };
        return {
            text: stripInjected(state, text.slice(end + close.length)).text,
            reason: "injected",
        };
    }
    if (WRAPPER_TAG.test(tag) && text.endsWith(close)) {
        return { text: "", reason: "injected_wrapper" };
    }
    return { text };
}

/** Tool name with its namespace. MCP namespaces such as `mcp__server` join with `__`. */
function toolName(item: Rec): string {
    const name = str(item.name) ?? "unknown";
    const namespace = str(item.namespace);
    if (!namespace) return name;
    if (namespace.endsWith("_") || name.startsWith("_")) return `${namespace}${name}`;
    return `${namespace}__${name}`;
}

/** Arguments as compact text. JSON strings are parsed and written again without spaces. */
function compactArguments(value: unknown): string {
    if (typeof value !== "string") return argumentsToText(value);
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
        return trimmed;
    }
}

function emitCall(state: State, callId: string | undefined, name: string, args: string): void {
    const memory = isMemoryToolCall(name, args) || containsMemoryContext(args);
    if (callId !== undefined) state.calls.set(callId, { toolName: name, memory });
    emit(state, "tool_call", args ? `${name} ${args}` : name, {
        toolName: name,
        memoryDerived: memory,
    });
}

function outputText(output: unknown): string {
    if (typeof output === "string") return unwrapShellOutput(output);
    if (Array.isArray(output)) return blocksToText(output, TEXT_BLOCKS);
    const content = obj(output)?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return blocksToText(content, TEXT_BLOCKS);
    return argumentsToText(output);
}

/** Some tools return `{"output": "...", "metadata": {...}}` as a string. Keep only the output. */
function unwrapShellOutput(text: string): string {
    if (!text.startsWith("{") || !text.includes('"metadata"')) return text;
    try {
        const parsed = obj(JSON.parse(text));
        const output = str(parsed?.output);
        if (output !== undefined && Object.keys(parsed ?? {}).length === 2 && parsed?.metadata) {
            return output;
        }
    } catch {
        // Not JSON. Keep the text.
    }
    return text;
}

function handleOutput(state: State, item: Rec): void {
    const callId = str(item.call_id);
    const call = callId === undefined ? undefined : state.calls.get(callId);
    // Some outputs have no call id. They carry the tool name and namespace instead.
    const name = call?.toolName ?? (item.name === undefined ? undefined : toolName(item));
    const text = outputText(item.output).trim();
    if (!text) {
        bump(state.filtered, "empty_output");
        return;
    }
    const memory = call?.memory ?? isMemoryToolName(name);
    emit(state, "tool_result", text, {
        toolName: name,
        memoryDerived: memory || containsMemoryContext(text),
        untrusted: true,
    });
}

/** A message from another agent, such as a subagent report. It is model output, so untrusted. */
function handleAgentMessage(state: State, item: Rec): void {
    const text = blocksToText(item.content, TEXT_BLOCKS).trim();
    if (!text) {
        bump(state.filtered, "agent_message_encrypted");
        return;
    }
    emit(state, "tool_result", text, { toolName: "agent_message", untrusted: true });
}

function handleEvent(state: State, payload: Rec | undefined): void {
    const type = str(payload?.type) ?? "none";
    if (type === "turn_aborted") {
        const reason = str(payload?.reason);
        emit(state, "notice", reason ? `Turn aborted: ${reason}` : "Turn aborted");
        return;
    }
    if (type === "thread_rolled_back") {
        rollBack(state, payload?.num_turns);
        return;
    }
    // Other events repeat response items or hold telemetry.
    bump(state.filtered, `event:${type}`);
}

/** Mark the events of the last `numTurns` user turns inactive. */
function rollBack(state: State, numTurns: unknown): void {
    const count =
        typeof numTurns === "number" && Number.isInteger(numTurns) && numTurns > 0 ? numTurns : 0;
    if (count === 0) warnOnce(state, "rollback", "thread_rolled_back without a valid num_turns");
    let start: number | undefined;
    for (let i = 0; i < count; i++) {
        const turnStart = state.turnStarts.pop();
        if (turnStart === undefined) break;
        start = turnStart;
    }
    if (start !== undefined) {
        for (const event of state.events.slice(start)) event.active = false;
    }
    emit(state, "notice", `Rolled back ${count} ${count === 1 ? "turn" : "turns"}`);
}

function handleCompacted(state: State, payload: Rec | undefined): void {
    const message = str(payload?.message)?.trim();
    const text = message ? stripSummaryPrefix(message) : findHistorySummary(payload);
    if (text) emit(state, "summary", text);
    else bump(state.filtered, "compaction_encrypted");
}

/**
 * Local compaction writes the summary as a user message in `replacement_history`, after
 * `SUMMARY_PREFIX`. Remote compaction keeps only an encrypted item, so no text is found.
 */
function findHistorySummary(payload: Rec | undefined): string | undefined {
    const history = payload?.replacement_history;
    if (!Array.isArray(history)) return undefined;
    for (let i = history.length - 1; i >= 0; i--) {
        const item = obj(history[i]);
        if (item?.type !== "message" || item.role !== "user") continue;
        const text = blocksToText(item.content, TEXT_BLOCKS).trim();
        if (text.startsWith(SUMMARY_PREFIX)) return stripSummaryPrefix(text);
    }
    return undefined;
}

/** Remove the first line when it is the summary prefix. */
function stripSummaryPrefix(text: string): string {
    if (!text.startsWith(SUMMARY_PREFIX)) return text;
    const newline = text.indexOf("\n");
    const rest = newline < 0 ? "" : text.slice(newline + 1).trim();
    return rest || text;
}

/**
 * A paginated thread writes one rollout file per page, and all pages have the same thread id.
 * Each page is a separate session in memory, with the rollout time of the file stem as a suffix:
 * `<thread id>~<time>`. The suffix is stable, so keys do not change when a page grows.
 */
export function pageSessionId(path: string, threadId: string): string {
    const stem = basename(path).replace(/\.jsonl(?:\.zst)?$/u, "");
    const prefix = "rollout-";
    const suffix = `-${threadId}`;
    const time =
        stem.startsWith(prefix) &&
        stem.endsWith(suffix) &&
        stem.length > prefix.length + suffix.length
            ? stem.slice(prefix.length, -suffix.length)
            : undefined;
    return `${threadId}~${time ?? hash8(stem)}`;
}

function parseCodexSession(path: string, text: string): SessionEvidence | null {
    const warnings: string[] = [];
    const records = parseJsonl(text, warnings);
    const first = records[0];
    if (!first) throw new AdapterFormatError("rollout has no records");
    const header = readHeader(first.record, first.line);
    if (!header) {
        throw new AdapterFormatError(`line ${first.line}: first record is not session_meta`);
    }
    // Subagent rollouts are part of the parent session.
    if (header.subagent) return null;

    const state: State = {
        events: [],
        filtered: {},
        warnings,
        warned: new Set(),
        calls: new Map(),
        turnStarts: [],
        line: first.line,
        part: 0,
    };
    for (const { line, record } of records.slice(1)) {
        state.line = line;
        state.part = 0;
        state.time = str(record.timestamp);
        if (header.legacy) handleLegacyRecord(state, record);
        else handleRecord(state, record);
    }

    const evidence: SessionEvidence = {
        harness: "codex",
        sessionId: header.paginated ? pageSessionId(path, header.sessionId) : header.sessionId,
        sourcePath: path,
        events: state.events,
        filtered: state.filtered,
        warnings,
    };
    const cwd = header.cwd ?? state.contextCwd;
    if (cwd !== undefined) evidence.cwd = cwd;
    if (header.branch !== undefined) evidence.branch = header.branch;
    if (header.startedAt !== undefined) evidence.startedAt = header.startedAt;
    const updatedAt =
        state.events.findLast((event) => event.time !== undefined)?.time ?? header.startedAt;
    if (updatedAt !== undefined) evidence.updatedAt = updatedAt;
    return evidence;
}

export const codexAdapter: HarnessAdapter = {
    harness: "codex",
    discover(root: string) {
        // `<root>/YYYY/MM/DD/rollout-*.jsonl[.zst]`. Depth 4 also covers one more directory level.
        return findJsonlFiles("codex", root, 4, true)
            .filter((file) => basename(file.path).startsWith("rollout-"))
            .sort((a, b) => a.path.localeCompare(b.path));
    },
    parse: parseCodexSession,
};
