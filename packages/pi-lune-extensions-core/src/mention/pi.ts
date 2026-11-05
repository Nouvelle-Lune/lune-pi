import { createReadStream, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fileVersion, type SessionIndex } from "./session-index.ts";
import type { LocalSession } from "./session.ts";

/** Pi's own listing reads ten session files at a time; files are streamed line by line. */
const READ_CONCURRENCY = 10;

interface SessionFile {
    path: string;
    stats: Stats;
}

/**
 * Pi sessions with the fields `SessionManager.listAll` builds, read through the index.
 * listAll keeps no cache and reads every file again on each call.
 */
export class PiSessions {
    private readonly sessionDir: string;
    private readonly index: SessionIndex;

    constructor(sessionDir: string, index: SessionIndex) {
        this.sessionDir = sessionDir;
        this.index = index;
    }

    async list(signal: AbortSignal, report: (error: unknown) => void): Promise<LocalSession[]> {
        const files = await sessionFiles(this.sessionDir, signal);
        const errors: Error[] = [];
        const sessions = await mapLimit(files, READ_CONCURRENCY, async ({ path, stats }) => {
            signal.throwIfAborted();
            const version = fileVersion(stats);
            let entry = this.index.get(path, version);
            if (!entry) {
                try {
                    entry = { version, session: await readSession(path, stats, signal) };
                } catch (error) {
                    signal.throwIfAborted();
                    // Removed since the directory was listed.
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                    const message = error instanceof Error ? error.message : String(error);
                    errors.push(new Error(`Pi: ${path}: ${message}`, { cause: error }));
                    return undefined;
                }
                this.index.set(path, entry);
            }
            return entry.session;
        });
        signal.throwIfAborted();
        if (errors.length > 0) {
            report(new AggregateError(errors, errors.map((error) => error.message).join("\n")));
        }
        return sessions.filter((session) => session !== undefined);
    }
}

/**
 * Matches the "all" scope of /resume: the default store keeps one folder per project under
 * the agent's sessions root, and a custom session directory holds every session itself.
 * The order is listAll's, so sessions with equal activity times keep its order.
 */
async function sessionFiles(sessionDir: string, signal: AbortSignal): Promise<SessionFile[]> {
    const root = join(getAgentDir(), "sessions");
    if (sessionDir !== "" && resolve(dirname(sessionDir)) !== resolve(root)) {
        const names = (await jsonlFiles(sessionDir)).sort((a, b) => b.localeCompare(a));
        return withStats(
            names.map((name) => join(sessionDir, name)),
            signal,
        );
    }
    let projects: string[];
    try {
        projects = (await readdir(root, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => join(root, entry.name));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const paths = await Promise.all(
        projects.map(async (project) =>
            (await jsonlFiles(project)).map((name) => join(project, name)),
        ),
    );
    const files = await withStats(paths.flat(), signal);
    return files.sort(
        (a, b) =>
            b.stats.mtimeMs - a.stats.mtimeMs || basename(b.path).localeCompare(basename(a.path)),
    );
}

async function jsonlFiles(directory: string): Promise<string[]> {
    try {
        return (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
        // A project entry may be a link to a file, and a custom store may not exist yet.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return [];
        throw error;
    }
}

async function withStats(paths: readonly string[], signal: AbortSignal): Promise<SessionFile[]> {
    const files = await Promise.all(
        paths.map(async (path) => {
            try {
                return { path, stats: await stat(path) };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw error;
            }
        }),
    );
    signal.throwIfAborted();
    return files.filter((file) => file !== undefined);
}

/** Pi's buildSessionInfo, field for field; undefined where it returns null. */
async function readSession(
    path: string,
    stats: Stats,
    signal: AbortSignal,
): Promise<LocalSession | undefined> {
    let header: Record<string, unknown> | undefined;
    let name: string | undefined;
    let messageCount = 0;
    let firstMessage = "";
    let lastActivity: number | undefined;
    const texts: string[] = [];
    const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8", signal }),
        crlfDelay: Infinity,
    });
    for await (const line of lines) {
        const entry = parseLine(line);
        if (!entry) continue;
        if (!header) {
            if (entry["type"] !== "session" || typeof entry["id"] !== "string") return undefined;
            header = entry;
            continue;
        }
        if (entry["type"] === "session_info") {
            const value = entry["name"];
            name = (typeof value === "string" ? value.trim() : "") || undefined;
        }
        if (entry["type"] !== "message") continue;
        messageCount++;
        const message = entry["message"];
        if (!isRecord(message) || !("content" in message)) continue;
        if (message["role"] !== "user" && message["role"] !== "assistant") continue;
        const timestamp = message["timestamp"];
        const activity = typeof timestamp === "number" ? timestamp : timeOf(entry["timestamp"]);
        if (activity !== undefined) lastActivity = Math.max(lastActivity ?? 0, activity);
        const text = textOf(message["content"]);
        if (!text) continue;
        texts.push(text);
        if (!firstMessage && message["role"] === "user") firstMessage = text;
    }
    if (!header) return undefined;
    const headerTime =
        typeof header["timestamp"] === "string" ? timeOf(header["timestamp"]) : undefined;
    const parent = header["parentSession"];
    return {
        source: "pi",
        path,
        id: header["id"] as string,
        cwd: typeof header["cwd"] === "string" ? header["cwd"] : "",
        name,
        parentSessionPath: typeof parent === "string" ? parent : undefined,
        created: new Date(header["timestamp"] as string),
        modified:
            lastActivity !== undefined && lastActivity > 0
                ? new Date(lastActivity)
                : headerTime !== undefined
                  ? new Date(headerTime)
                  : stats.mtime,
        messageCount,
        firstMessage: firstMessage || "(no messages)",
        allMessagesText: texts.join(" "),
    };
}

// Pi skips malformed lines too; the last line can be cut off while Pi appends to the file.
function parseLine(line: string): Record<string, unknown> | undefined {
    if (!line.trim()) return undefined;
    try {
        const entry: unknown = JSON.parse(line);
        return isRecord(entry) ? entry : undefined;
    } catch {
        return undefined;
    }
}

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (block): block is Record<string, unknown> =>
                isRecord(block) && block["type"] === "text",
        )
        .map((block) => block["text"])
        .join(" ");
}

function timeOf(value: unknown): number | undefined {
    const time = new Date(value as string).getTime();
    return Number.isNaN(time) ? undefined : time;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    map: (item: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await map(items[index]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
