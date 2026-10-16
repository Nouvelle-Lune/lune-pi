import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
    AssistantMessage,
    ImageContent,
    JsonObject,
    TextContent,
    ToolCall,
    ToolResultMessage,
    Usage,
    UserMessage,
} from "@earendil-works/pi-ai";
import type { CompactionPolicy } from "../../src/options.ts";

/** Deterministic zero usage so fixture messages never contribute context tokens. */
export const ZERO_USAGE: Usage = Object.freeze({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

let clock = 1_700_000_000_000;

export function user(text: string): UserMessage {
    return { role: "user", content: text, timestamp: clock++ };
}

export function userBlocks(content: (TextContent | ImageContent)[]): UserMessage {
    return { role: "user", content, timestamp: clock++ };
}

export function assistantText(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: clock++,
    };
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
    return { type: "toolCall", id, name, arguments: args as JsonObject };
}

export function assistantToolCall(
    id: string,
    name: string,
    args: Record<string, unknown> = {},
    text = "",
): AssistantMessage {
    const content: (TextContent | ToolCall)[] = [];
    if (text) content.push({ type: "text", text });
    content.push(toolCall(id, name, args));
    return {
        role: "assistant",
        content,
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: ZERO_USAGE,
        stopReason: "toolUse",
        timestamp: clock++,
    };
}

export function toolResult(
    id: string,
    name: string,
    text: string,
    options: { isError?: boolean; nonText?: ImageContent[] } = {},
): ToolResultMessage {
    const content: (TextContent | ImageContent)[] = [];
    if (text.length > 0 || (!options.nonText && !options.isError))
        content.push({ type: "text", text });
    for (const block of options.nonText ?? []) content.push(block);
    return {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content,
        isError: options.isError ?? false,
        timestamp: clock++,
    };
}

/** A tool result built from an explicit content list so media/empty cases can be expressed. */
export function toolResultBlocks(
    id: string,
    name: string,
    content: (TextContent | ImageContent)[],
    isError = false,
): ToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content,
        isError,
        timestamp: clock++,
    };
}

export function image(data = "AAAA", mimeType = "image/png"): ImageContent {
    return { type: "image", data, mimeType };
}

export function policy(overrides: Partial<CompactionPolicy> = {}): CompactionPolicy {
    return Object.freeze({
        deleteThreshold: 0.7,
        deletableTools: Object.freeze([
            "read",
            "grep",
            "find",
            "ls",
            "codemode",
            "bash",
            "edit",
            "powershell",
            "tool_search",
        ]),
        ...overrides,
    });
}

export const allMessages = (...messages: AgentMessage[]): AgentMessage[] => [...messages];
