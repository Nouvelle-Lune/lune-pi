import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SOURCE_NAMES, type LocalSession } from "./session.ts";

/** Raise when the stored shape or what a reader takes from a session file changes. */
const FORMAT = 1;
const STRING_FIELDS = ["path", "id", "cwd", "firstMessage", "allMessagesText"] as const;
const OPTIONAL_STRING_FIELDS = ["name", "parentSessionPath"] as const;
const DATE_FIELDS = ["created", "modified"] as const;

export function sessionIndexFile(agentDir = getAgentDir()): string {
    return join(agentDir, "lune-cache", "session-index.json");
}

/** A file with the same inode, size and modification time reads the same. */
export function fileVersion(stats: Stats): string {
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

export interface IndexEntry {
    version: string;
    /** Absent for a file without a listable session, so it is not read again until it changes. */
    session?: LocalSession;
}

/**
 * What the catalog read from each session file, saved so that a new Pi session or process
 * reads only the files that changed since. Listing reads every file in full, and the session
 * stores reach gigabytes because of tool output the list never uses.
 *
 * Several Pi processes share the file. Each writes a complete index and renames it into
 * place, so readers always see a whole index and the last writer wins.
 */
export class SessionIndex {
    private readonly file: string;
    private entries = new Map<string, IndexEntry>();
    private readonly seen = new Set<string>();
    private loaded = false;
    private changed = false;

    constructor(file: string) {
        this.file = file;
    }

    /**
     * Reads the saved index once. A missing file or another format starts empty; an invalid
     * one is reported and replaced by the next save.
     */
    async load(signal: AbortSignal): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        let content: string;
        try {
            content = await readFile(this.file, { encoding: "utf8", signal });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        try {
            this.entries = parseIndex(content);
        } catch (error) {
            this.changed = true;
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`${this.file}: unreadable session index, rebuilding it: ${reason}`, {
                cause: error,
            });
        }
    }

    beginScan(): void {
        this.seen.clear();
    }

    /** The entry read from this version of the file. A lookup marks the file as present. */
    get(path: string, version: string): IndexEntry | undefined {
        this.seen.add(path);
        const entry = this.entries.get(path);
        return entry?.version === version ? entry : undefined;
    }

    set(path: string, entry: IndexEntry): void {
        this.seen.add(path);
        this.entries.set(path, entry);
        this.changed = true;
    }

    /** Drops the files this scan did not find and writes the index if anything changed. */
    async endScan(): Promise<void> {
        for (const path of this.entries.keys()) {
            if (this.seen.has(path)) continue;
            this.entries.delete(path);
            this.changed = true;
        }
        if (!this.changed) return;
        const content = serializeIndex(this.entries);
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        try {
            // Owner-only: the index holds the message text of every listed session.
            await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
            await rename(temporary, this.file);
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
        this.changed = false;
    }
}

function serializeIndex(entries: ReadonlyMap<string, IndexEntry>): string {
    const files: Record<string, unknown> = {};
    for (const [path, { version, session }] of entries) {
        files[path] = session ? { version, session: storedSession(session) } : { version };
    }
    return JSON.stringify({ format: FORMAT, files });
}

// JSON drops undefined values, but the readers set `name` and `parentSessionPath` keys that
// may hold undefined. Null keeps the key, so a stored session equals a fresh read.
function storedSession(session: LocalSession): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(session).map(([key, value]) => [
            key,
            value instanceof Date ? value.getTime() : (value ?? null),
        ]),
    );
}

function parseIndex(content: string): Map<string, IndexEntry> {
    const entries = new Map<string, IndexEntry>();
    const stored: unknown = JSON.parse(content);
    if (!isRecord(stored) || typeof stored["format"] !== "number") {
        throw new Error("missing format");
    }
    if (stored["format"] !== FORMAT) return entries;
    const files = stored["files"];
    if (!isRecord(files)) throw new Error("missing files");
    for (const [path, value] of Object.entries(files)) {
        if (!isRecord(value) || typeof value["version"] !== "string") {
            throw new Error(`invalid entry for ${path}`);
        }
        const version = value["version"];
        entries.set(
            path,
            value["session"] === undefined
                ? { version }
                : { version, session: restoredSession(value["session"], path) },
        );
    }
    return entries;
}

function restoredSession(value: unknown, path: string): LocalSession {
    const invalid = (field: string) => new Error(`invalid ${field} for ${path}`);
    if (!isRecord(value)) throw invalid("session");
    const session: Record<string, unknown> = { ...value };
    for (const field of STRING_FIELDS) {
        if (typeof value[field] !== "string") throw invalid(field);
    }
    if (typeof value["messageCount"] !== "number") throw invalid("messageCount");
    const source = value["source"];
    if (typeof source !== "string" || !Object.hasOwn(SOURCE_NAMES, source)) {
        throw invalid("source");
    }
    for (const field of OPTIONAL_STRING_FIELDS) {
        if (!Object.hasOwn(value, field)) continue;
        const text = value[field];
        if (text !== null && typeof text !== "string") throw invalid(field);
        session[field] = text ?? undefined;
    }
    for (const field of DATE_FIELDS) {
        const time = value[field];
        // An invalid date is stored as NaN, which JSON writes as null.
        if (time !== null && typeof time !== "number") throw invalid(field);
        session[field] = new Date(time ?? Number.NaN);
    }
    return session as unknown as LocalSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
