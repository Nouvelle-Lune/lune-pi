import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { MemoryPaths } from "./paths.ts";

const MAX_LINES = 200;
const MAX_BYTES = 256 * 1024;

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "daemon" | "import" | "dreaming" | "views" | "http";

export interface LogContext {
    level: LogLevel;
    source: LogSource;
}

export type LogDetails = Partial<LogContext>;

export interface LogSnapshot {
    path: string;
    lines: string[];
    truncated: boolean;
}

export function formatLog(message: string, at: string, context: LogContext): string {
    const prefix = `${at} [${context.level.toUpperCase()}] [${context.source.toUpperCase()}] `;
    return `${message
        .split(/\r?\n/u)
        .map((line) => `${prefix}${line}`)
        .join("\n")}\n`;
}

export function appendLog(
    paths: MemoryPaths,
    message: string,
    at: string,
    context: LogContext,
): void {
    mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
    appendFileSync(join(paths.logs, "daemon.log"), formatLog(message, at, context), {
        mode: 0o600,
    });
}

/** Read a bounded tail so an old daemon log cannot make a settings request unbounded. */
export function readLog(paths: MemoryPaths): LogSnapshot {
    const path = join(paths.logs, "daemon.log");
    let file: number;
    try {
        file = openSync(path, "r");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { path, lines: [], truncated: false };
        }
        throw error;
    }
    try {
        const size = fstatSync(file).size;
        const start = Math.max(0, size - MAX_BYTES);
        // Include the preceding byte to distinguish an aligned line from a partial one.
        const readStart = Math.max(0, start - 1);
        const buffer = Buffer.alloc(size - readStart);
        const length = readSync(file, buffer, 0, buffer.length, readStart);
        let text = buffer.subarray(0, length).toString("utf8");
        if (start > 0) {
            const newline = text.indexOf("\n");
            text = newline < 0 ? "" : text.slice(newline + 1);
        }
        const lastNewline = text.lastIndexOf("\n");
        text = lastNewline < 0 ? "" : text.slice(0, lastNewline);
        const lines = text ? text.split("\n") : [];
        return {
            path,
            lines: lines.slice(-MAX_LINES),
            truncated: start > 0 || lines.length > MAX_LINES,
        };
    } finally {
        closeSync(file);
    }
}
