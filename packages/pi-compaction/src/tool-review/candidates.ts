import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type JsonObject } from "@earendil-works/pi-ai";
import type {
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionProjection,
} from "@earendil-works/pi-coding-agent";
import type { CompactionPolicy } from "../options.ts";

export const MAX_TOOL_RESULT_CHARS = 8_000;
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[pi-compaction tool result truncated]\n";
const MAX_CONTEXT_CHARS = 2_000;

export type MessageRegion = "history" | "prefix" | "retained";

export interface MessageLocation {
    readonly region: MessageRegion;
    readonly index: number;
    readonly message: AgentMessage;
}

export interface ToolPair {
    readonly id: string;
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
    readonly call: MessageLocation;
    readonly result: MessageLocation;
}

export interface ProtectedTool {
    readonly id: string;
    readonly reasons: readonly string[];
}

export interface ResultChunk {
    readonly id: string;
    readonly toolCallId: string;
    readonly blockIndex: number;
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

function isSurrogatePair(left: number, right: number): boolean {
    return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

/** Move a cut off a surrogate pair or CRLF in the given direction. */
function safeBoundary(text: string, offset: number, direction: -1 | 1): number {
    const left = text.charCodeAt(offset - 1);
    const right = text.charCodeAt(offset);
    return isSurrogatePair(left, right) || (left === 13 && right === 10)
        ? offset + direction
        : offset;
}

export function truncateToolResult(message: AgentMessage): AgentMessage {
    if (message.role !== "toolResult") return message;
    const raw = contentText(message.content, "");
    if (raw.length <= MAX_TOOL_RESULT_CHARS) return message;
    const budget = MAX_TOOL_RESULT_CHARS - TOOL_RESULT_TRUNCATION_MARKER.length;
    const headEnd = safeBoundary(raw, Math.ceil(budget / 2), -1);
    const tailStart = safeBoundary(raw, raw.length - Math.floor(budget / 2), 1);
    let offset = 0;
    let marked = false;
    const content = message.content.map((block) => {
        if (block.type !== "text") return block;
        const start = offset;
        const end = start + block.text.length;
        offset = end;
        let text = block.text.slice(0, Math.max(0, Math.min(block.text.length, headEnd - start)));
        if (end > headEnd && start < tailStart && !marked) {
            text += TOOL_RESULT_TRUNCATION_MARKER;
            marked = true;
        }
        text += block.text.slice(Math.max(0, tailStart - start));
        return text === block.text ? block : { ...block, text };
    });
    return { ...message, content };
}

export function collectReviewInput(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
    const projection = ctx.sessionManager.buildSessionProjection();
    const converted = new Map<AgentMessage, AgentMessage>();
    const convert = (message: AgentMessage): AgentMessage => {
        if (!converted.has(message)) converted.set(message, truncateToolResult(message));
        return converted.get(message)!;
    };
    // Pi owns message visibility and compaction boundaries; shared identities preserve entry provenance.
    return {
        preparation: {
            ...event.preparation,
            messagesToSummarize: event.preparation.messagesToSummarize.map(convert),
            turnPrefixMessages: event.preparation.turnPrefixMessages.map(convert),
        },
        projection: {
            ...projection,
            messages: projection.messages.map(convert),
            entries: projection.entries.map((entry) => ({
                ...entry,
                messages: entry.messages.map(convert),
            })),
        },
    };
}

function assertJsonArguments(value: unknown, ancestors = new Set<object>()): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || value === null)
        throw new Error("Tool arguments contain a non-JSON value");
    if (
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
    ) {
        throw new Error("Tool arguments must use plain JSON objects");
    }
    if (ancestors.has(value)) throw new Error("Tool arguments contain a cycle");
    ancestors.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value))
        assertJsonArguments(child, ancestors);
    ancestors.delete(value);
}

export function indexTools(
    history: readonly AgentMessage[],
    prefix: readonly AgentMessage[],
    projection: SessionProjection,
    firstKeptEntryId: string,
    policy: CompactionPolicy,
): {
    readonly pairs: readonly ToolPair[];
    readonly protectedTools: readonly ProtectedTool[];
    readonly locations: readonly MessageLocation[];
} {
    const boundary = projection.entries.findIndex(
        (entry) => entry.sourceEntry.id === firstKeptEntryId,
    );
    if (boundary < 0)
        throw new Error(
            `Retained boundary ${firstKeptEntryId} is missing from the current projection`,
        );
    const locations: MessageLocation[] = [];
    const append = (region: MessageRegion, messages: readonly AgentMessage[]): void => {
        messages.forEach((message, index) => locations.push({ region, index, message }));
    };
    append("history", history);
    append("prefix", prefix);
    append(
        "retained",
        projection.entries.slice(boundary).flatMap((entry) => entry.messages),
    );
    const calls = new Map<
        string,
        { location: MessageLocation; name: string; arguments: Record<string, unknown> }[]
    >();
    const results = new Map<string, MessageLocation[]>();
    for (const location of locations) {
        if (location.message.role === "assistant") {
            for (const block of location.message.content) {
                if (block.type !== "toolCall") continue;
                if (
                    block.arguments === null ||
                    typeof block.arguments !== "object" ||
                    Array.isArray(block.arguments)
                ) {
                    throw new Error("Tool arguments must be a JSON object");
                }
                // JSON.stringify would silently erase undefined fields or turn NaN into null, corrupting decision evidence.
                assertJsonArguments(block.arguments);
                const list = calls.get(block.id) ?? [];
                list.push({ location, name: block.name, arguments: block.arguments });
                calls.set(block.id, list);
            }
        } else if (location.message.role === "toolResult") {
            const list = results.get(location.message.toolCallId) ?? [];
            list.push(location);
            results.set(location.message.toolCallId, list);
        }
    }
    const pairs: ToolPair[] = [];
    const protectedTools: ProtectedTool[] = [];
    for (const id of new Set([...calls.keys(), ...results.keys()])) {
        const callList = calls.get(id) ?? [];
        const resultList = results.get(id) ?? [];
        const call = callList[0];
        const result = resultList[0];
        const reasons: string[] = [];
        if (!id.trim()) reasons.push("empty-id");
        if (callList.length !== 1 || resultList.length !== 1)
            reasons.push("unpaired-or-duplicate-id");
        if (call && result) {
            if (call.location.region !== result.region) reasons.push("cross-region-pair");
            if (call.location.region === "retained" || result.region === "retained")
                reasons.push("retained-region");
            if (call.location.region === result.region && call.location.index >= result.index)
                reasons.push("invalid-order");
            if (result.message.role !== "toolResult")
                throw new Error("Tool index contains a non-result message");
            if (call.name !== result.message.toolName) reasons.push("tool-name-mismatch");
            if (result.message.isError) reasons.push("error-result");
            if (result.message.content.some((block) => block.type !== "text"))
                reasons.push("non-text-result");
            if (!policy.deletableTools.includes(call.name)) reasons.push("tool-not-deletable");
            const nested = result.message.nestedCalls;
            // Pi records calls made by nested tools too, so each recorded name needs its own permission.
            if (nested) {
                // An incomplete record can hide calls or arguments past Pi's recording limits.
                if (!nested.complete) reasons.push("incomplete-nested-calls");
                if (
                    nested.calls.some(
                        (nestedCall) => !policy.deletableTools.includes(nestedCall.name),
                    )
                )
                    reasons.push("nested-tool-not-deletable");
                // A failed or unfinished nested call means the outer result may not describe what ran.
                if (nested.calls.some((nestedCall) => nestedCall.status !== "ok"))
                    reasons.push("nested-call-failed");
            }
        }
        if (reasons.length > 0) {
            protectedTools.push({ id, reasons });
            continue;
        }
        if (!call || !result) throw new Error(`Incomplete candidate ${id}`);
        pairs.push({
            id,
            toolName: call.name,
            arguments: call.arguments,
            call: call.location,
            result,
        });
    }
    return { pairs, protectedTools, locations };
}

function safeChunkEnd(text: string, proposed: number): number {
    if (proposed >= text.length) return text.length;
    const left = text.charCodeAt(proposed - 1);
    const right = text.charCodeAt(proposed);
    return (left === 13 && right === 10) || isSurrogatePair(left, right) ? proposed - 1 : proposed;
}

/** Partition every UTF-16 position exactly once; prefer line boundaries inside the cap. */
export function splitText(
    text: string,
    maxChars: number,
): readonly { start: number; end: number; text: string }[] {
    if (!Number.isSafeInteger(maxChars) || maxChars < 2)
        throw new Error("maxChars must be an integer of at least 2");
    const pieces: { start: number; end: number; text: string }[] = [];
    let start = 0;
    while (start < text.length) {
        let end = safeChunkEnd(text, Math.min(start + maxChars, text.length));
        if (end < text.length) {
            const newline = text.lastIndexOf("\n", end - 1);
            if (newline >= start) end = newline + 1;
        }
        if (end <= start) throw new Error("Chunk partition made no progress");
        pieces.push({ start, end, text: text.slice(start, end) });
        start = end;
    }
    return pieces;
}

export function chunkResult(pair: ToolPair, maxChars: number): readonly ResultChunk[] {
    const result = pair.result.message;
    if (result.role !== "toolResult") throw new Error(`Candidate ${pair.id} has no result`);
    return result.content.flatMap((block, blockIndex) => {
        if (block.type !== "text")
            throw new Error(`Candidate ${pair.id} contains non-text content`);
        return splitText(block.text, maxChars).map((piece) => ({
            id: `${pair.result.region}:${encodeURIComponent(pair.id)}:${blockIndex}:${piece.start}-${piece.end}`,
            toolCallId: pair.id,
            blockIndex,
            ...piece,
        }));
    });
}

function excerpt(text: string, fromEnd = false): string {
    const characters = Array.from(text);
    return (
        fromEnd ? characters.slice(-MAX_CONTEXT_CHARS) : characters.slice(0, MAX_CONTEXT_CHARS)
    ).join("");
}

export function candidateContext(
    pair: ToolPair,
    locations: readonly MessageLocation[],
): JsonObject {
    const callPosition = locations.indexOf(pair.call);
    const resultPosition = locations.indexOf(pair.result);
    if (callPosition < 0 || resultPosition <= callPosition)
        throw new Error(`Candidate ${pair.id} is absent from the conversation`);

    let originatingRequest: string | undefined;
    for (let index = callPosition - 1; index >= 0; index--) {
        const message = locations[index]!.message;
        if (message.role === "user") {
            originatingRequest = excerpt(contentText(message.content, "\n"));
            break;
        }
    }
    const current = locations.findLast(({ message }) => message.role === "user")?.message;
    const currentRequest =
        current?.role === "user" ? excerpt(contentText(current.content, "\n")) : undefined;

    const outcome: string[] = [];
    for (let index = resultPosition + 1; index < locations.length; index++) {
        const message = locations[index]!.message;
        if (message.role === "user") break;
        if (message.role === "assistant") {
            const text = contentText(message.content, "\n");
            if (text) outcome.push(text);
        }
    }
    // Like Recap, use bounded visible text; never include thinking or subsequent tool bodies.
    return {
        ...(originatingRequest === undefined ? {} : { originatingRequest }),
        ...(currentRequest === undefined ? {} : { currentRequest }),
        toolCall: { name: pair.toolName, arguments: pair.arguments },
        ...(outcome.length ? { sameTurnOutcome: excerpt(outcome.join("\n"), true) } : {}),
    } as JsonObject;
}
