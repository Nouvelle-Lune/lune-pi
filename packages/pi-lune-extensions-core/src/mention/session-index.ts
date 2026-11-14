import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { INDEX_BUDGET_MB, megabytes, SESSION_TEXT_LIMIT } from "./budget.ts";
import { SOURCE_NAMES, type LocalSession } from "./session.ts";

/** Raise when the stored shape or what a reader takes from a session file changes. */
const FORMAT = 3;
/**
 * The default budget; Core settings let the user change it. The newest sessions whose entries
 * fit are indexed and listed; older ones are neither read nor listed.
 */
export const INDEX_BUDGET_BYTES = megabytes(INDEX_BUDGET_MB);
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

/** A session file a source found, read only when the index has no entry for its version. */
export interface SessionFile {
    readonly path: string;
    readonly stats: Stats;
    /** Names the source in read errors. */
    readonly label: string;
    /** The session in the file; undefined when the file holds none to list. */
    read(signal: AbortSignal): Promise<LocalSession | undefined>;
    /** The session with state kept outside its file, such as a Codex title, applied. */
    current?(session: LocalSession): LocalSession;
    /** Invalidates an omitted entry's size when state outside its file changes. */
    readonly currentVersion?: string;
}

export interface SessionScan {
    /** The listed sessions, in the order of the files. */
    sessions: LocalSession[];
    errors: Error[];
}

interface IndexEntry {
    version: string;
    /** Absent for a file without a listable session, so it is not read again until it changes. */
    session?: LocalSession;
    /**
     * Set for the first file that did not fit the budget. Only its size is kept, so later
     * scans stop there without reading it until it changes or room is freed.
     */
    omitted?: true;
    currentVersion?: string;
    /** Bytes the full entry takes in JSON, including a separating comma. */
    bytes: number;
}

/**
 * What the catalog read from each session file, saved so that a new Pi session or process
 * reads only the files that changed since. Listing reads every file in full, and the session
 * stores reach gigabytes because of tool output the list never uses.
 *
 * Every load and every changed scan reads or writes the whole index, so it holds only the
 * newest sessions that fit its budget, with their text clipped to the configured limit.
 *
 * Several Pi processes share the file. Each writes a complete index and renames it into
 * place, so readers always see a whole index and the last writer wins.
 */
export class SessionIndex {
    private readonly file: string;
    /**
     * Bytes the entries of a scan may take. A smaller budget drops the oldest entries at the
     * next scan; a larger one reads the files the last scan left out.
     */
    budget: number;
    textLimit: number;
    private entries = new Map<string, IndexEntry>();
    private indexedTextLimit: number | undefined;
    private loaded = false;
    private changed = false;

    constructor(file: string, budget = INDEX_BUDGET_BYTES, textLimit = SESSION_TEXT_LIMIT) {
        this.file = file;
        this.budget = budget;
        this.textLimit = textLimit;
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
            const stored = parseIndex(content);
            if (stored) {
                this.entries = stored.entries;
                this.indexedTextLimit = stored.textLimit;
            } else {
                this.changed = true;
            }
        } catch (error) {
            this.changed = true;
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`${this.file}: unreadable session index, rebuilding it: ${reason}`, {
                cause: error,
            });
        }
    }

    /**
     * Lists the sessions of the newest files, by modification time, until the next one does
     * not fit the budget. Files the index lacks are read one at a time, which bounds memory
     * for large rollouts and keeps the order. Entries for every other file are dropped.
     */
    async scan(files: readonly SessionFile[], signal: AbortSignal): Promise<SessionScan> {
        signal.throwIfAborted();
        if (this.indexedTextLimit !== this.textLimit) {
            // A larger limit needs text that the saved entries no longer contain.
            this.changed ||= this.indexedTextLimit !== undefined;
            this.entries.clear();
            this.indexedTextLimit = this.textLimit;
        }
        const sessions = new Array<LocalSession | undefined>(files.length);
        const errors: Error[] = [];
        const kept = new Map<string, IndexEntry>();
        const newestFirst = files
            .map((_, position) => position)
            .sort((left, right) => files[right]!.stats.mtimeMs - files[left]!.stats.mtimeMs);
        let used = Buffer.byteLength(serializeIndex(new Map(), this.textLimit));
        for (const position of newestFirst) {
            signal.throwIfAborted();
            const file = files[position]!;
            const version = fileVersion(file.stats);
            const stored = this.entries.get(file.path);
            let entry = stored?.version === version ? stored : undefined;
            if (
                !entry ||
                (entry.omitted &&
                    (used + entry.bytes - Number(kept.size === 0) <= this.budget ||
                        entry.currentVersion !== file.currentVersion))
            ) {
                let session: LocalSession | undefined;
                try {
                    session = await file.read(signal);
                } catch (error) {
                    signal.throwIfAborted();
                    // Removed since the directory was listed.
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                    const message = error instanceof Error ? error.message : String(error);
                    errors.push(
                        new Error(`${file.label}: ${file.path}: ${message}`, { cause: error }),
                    );
                    continue;
                }
                entry = indexEntry(file.path, version, session && clipped(session, this.textLimit));
            }
            if (entry.session && file.current) {
                const session = file.current(entry.session);
                if (session !== entry.session) entry = indexEntry(file.path, version, session);
            }
            const separator = Number(kept.size === 0);
            if (used + entry.bytes - separator > this.budget) {
                if (!entry.omitted) {
                    entry = {
                        version,
                        omitted: true,
                        bytes: entry.bytes,
                        currentVersion: file.currentVersion,
                    };
                }
                const markerBytes = serializedEntryBytes(file.path, {
                    version,
                    omittedBytes: entry.bytes,
                    currentVersion: entry.currentVersion,
                });
                // A boundary marker must not push the index beyond its configured size.
                if (used + markerBytes - separator <= this.budget) kept.set(file.path, entry);
                break;
            }
            used += entry.bytes - separator;
            kept.set(file.path, entry);
            sessions[position] = entry.session;
        }
        if (
            kept.size !== this.entries.size ||
            [...kept].some(([path, entry]) => this.entries.get(path) !== entry)
        ) {
            this.changed = true;
        }
        this.entries = kept;
        return { sessions: sessions.filter((session) => session !== undefined), errors };
    }

    /** Writes the index if the last scan changed it. */
    async save(): Promise<void> {
        if (!this.changed) return;
        const content = serializeIndex(this.entries, this.textLimit);
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

function indexEntry(path: string, version: string, session?: LocalSession): IndexEntry {
    return session
        ? { version, session, bytes: entryBytes(path, version, session) }
        : { version, bytes: entryBytes(path, version) };
}

function entryBytes(path: string, version: string, session?: LocalSession): number {
    return serializedEntryBytes(
        path,
        session ? { version, session: storedSession(session) } : { version },
    );
}

function serializedEntryBytes(path: string, value: unknown): number {
    return Buffer.byteLength(JSON.stringify(path)) + Buffer.byteLength(JSON.stringify(value)) + 2;
}

function clipped(session: LocalSession, limit: number): LocalSession {
    const firstMessage = clip(session.firstMessage, limit);
    const allMessagesText = clip(session.allMessagesText, limit);
    return firstMessage === session.firstMessage && allMessagesText === session.allMessagesText
        ? session
        : { ...session, firstMessage, allMessagesText };
}

function clip(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const last = text.charCodeAt(limit - 1);
    // Never keep half of a surrogate pair.
    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

function serializeIndex(entries: ReadonlyMap<string, IndexEntry>, textLimit: number): string {
    const files: Record<string, unknown> = {};
    for (const [path, { version, session, omitted, bytes, currentVersion }] of entries) {
        files[path] = omitted
            ? { version, omittedBytes: bytes, currentVersion }
            : session
              ? { version, session: storedSession(session) }
              : { version };
    }
    return JSON.stringify({ format: FORMAT, textLimit, files });
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

function parseIndex(
    content: string,
): { entries: Map<string, IndexEntry>; textLimit: number } | undefined {
    const entries = new Map<string, IndexEntry>();
    const stored: unknown = JSON.parse(content);
    if (!isRecord(stored) || typeof stored["format"] !== "number") {
        throw new Error("missing format");
    }
    if (stored["format"] !== FORMAT) return undefined;
    const textLimit = stored["textLimit"];
    if (typeof textLimit !== "number" || !Number.isInteger(textLimit) || textLimit < 1) {
        throw new Error("invalid textLimit");
    }
    const files = stored["files"];
    if (!isRecord(files)) throw new Error("missing files");
    for (const [path, value] of Object.entries(files)) {
        if (!isRecord(value) || typeof value["version"] !== "string") {
            throw new Error(`invalid entry for ${path}`);
        }
        const version = value["version"];
        const omittedBytes = value["omittedBytes"];
        if (omittedBytes !== undefined) {
            if (typeof omittedBytes !== "number" || !(omittedBytes >= 0)) {
                throw new Error(`invalid omittedBytes for ${path}`);
            }
            const currentVersion = value["currentVersion"];
            if (currentVersion !== undefined && typeof currentVersion !== "string") {
                throw new Error(`invalid currentVersion for ${path}`);
            }
            entries.set(path, { version, omitted: true, bytes: omittedBytes, currentVersion });
            continue;
        }
        entries.set(
            path,
            indexEntry(
                path,
                version,
                value["session"] === undefined
                    ? undefined
                    : restoredSession(value["session"], path),
            ),
        );
    }
    return { entries, textLimit };
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
