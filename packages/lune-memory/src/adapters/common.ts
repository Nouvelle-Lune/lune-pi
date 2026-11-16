import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { MEMORY_CONTEXT_TAG, type Harness } from "../core/types.ts";
import type { SessionFileRef } from "./types.ts";

/** Pi custom message type that carries injected L1 context. */
export const PI_L1_CUSTOM_TYPE = "lune-memory-l1";

const MEMORY_TOOL_NAMES = new Set([
    "transcript_search",
    "note_write",
    "note_update",
    "note_retract",
    "memory_location",
]);

/**
 * True when a tool name is one of the lune-memory tools. MCP clients add a prefix such as
 * `mcp__lune-memory__`, so the check uses the last name segment.
 */
export function isMemoryToolName(name: string | undefined): boolean {
    if (!name) return false;
    const segments = name.split(/__|[.:/]/u);
    const last = segments[segments.length - 1] ?? name;
    return MEMORY_TOOL_NAMES.has(last) || MEMORY_TOOL_NAMES.has(name);
}

const MEMORY_PATH_PATTERN = /\.lune-memory[\\/](?:views|transcripts|\.generations)\b/u;

/** True when text references the lune-memory projection, for example a file read of L2 or L3. */
export function mentionsMemoryPath(text: string | undefined): boolean {
    return text !== undefined && MEMORY_PATH_PATTERN.test(text);
}

/** True when text contains injected L1 context. */
export function containsMemoryContext(text: string | undefined): boolean {
    return text !== undefined && text.includes(`<${MEMORY_CONTEXT_TAG}`);
}

/** True when a tool call is memory-derived: a memory tool, or a call that reads memory files. */
export function isMemoryToolCall(name: string | undefined, argumentsText: string): boolean {
    return isMemoryToolName(name) || mentionsMemoryPath(argumentsText);
}

/** Serialize tool arguments for an event text. Strings stay as they are. */
export function argumentsToText(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * Join the text of content blocks. `content` can be a string or an array of blocks. Only `text`
 * blocks (or blocks with a string `text` field of the given types) are kept. Images become a
 * placeholder.
 */
export function blocksToText(content: unknown, textTypes: readonly string[] = ["text"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const block of content) {
        if (typeof block === "string") {
            parts.push(block);
            continue;
        }
        if (!block || typeof block !== "object") continue;
        const record = block as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : "";
        if (textTypes.includes(type) && typeof record.text === "string") parts.push(record.text);
        else if (type === "image" || type === "input_image") parts.push("[image]");
    }
    return parts.join("\n");
}

/** Increment a filter counter. */
export function bump(counter: Record<string, number>, reason: string, by = 1): void {
    counter[reason] = (counter[reason] ?? 0) + by;
}

/** Split JSONL text into lines with 1-based numbers. Empty lines are skipped. */
export function jsonlLines(text: string): Array<{ line: number; raw: string }> {
    const lines = text.split("\n");
    const out: Array<{ line: number; raw: string }> = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]?.trim() ?? "";
        if (raw) out.push({ line: i + 1, raw });
    }
    return out;
}

/**
 * Parse JSONL records. A malformed line is a warning. A malformed last line is expected while
 * the harness writes the file, so it does not create a warning.
 */
export function parseJsonl(
    text: string,
    warnings: string[],
): Array<{ line: number; record: Record<string, unknown> }> {
    const lines = jsonlLines(text);
    const out: Array<{ line: number; record: Record<string, unknown> }> = [];
    for (let i = 0; i < lines.length; i++) {
        const entry = lines[i];
        if (!entry) continue;
        try {
            const value: unknown = JSON.parse(entry.raw);
            if (value && typeof value === "object" && !Array.isArray(value)) {
                out.push({ line: entry.line, record: value as Record<string, unknown> });
            } else {
                warnings.push(`line ${entry.line}: record is not an object`);
            }
        } catch {
            if (i < lines.length - 1 || text.endsWith("\n")) {
                warnings.push(`line ${entry.line}: malformed JSON`);
            }
        }
    }
    return out;
}

/**
 * List session files below `root`: `*.jsonl`, and `*.jsonl.zst` when `compressed` is true.
 * `maxDepth` limits recursion. Missing roots give no files.
 */
export function findJsonlFiles(
    harness: Harness,
    root: string,
    maxDepth: number,
    compressed = false,
): SessionFileRef[] {
    const out: SessionFileRef[] = [];
    const walk = (dir: string, depth: number): void => {
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            const path = join(dir, name);
            let stat;
            try {
                stat = statSync(path);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                if (depth < maxDepth) walk(path, depth + 1);
            } else if (
                stat.isFile() &&
                (name.endsWith(".jsonl") || (compressed && name.endsWith(".jsonl.zst")))
            ) {
                out.push({ harness, path, size: stat.size, mtimeMs: stat.mtimeMs });
            }
        }
    };
    walk(root, 0);
    return out;
}

export function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function obj(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
