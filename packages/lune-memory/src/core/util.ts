import { createHash, randomBytes } from "node:crypto";
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { dirname } from "node:path";

export function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

export function hash8(text: string): string {
    return sha256(text).slice(0, 8);
}

export function nowIso(now: number = Date.now()): string {
    return new Date(now).toISOString();
}

/** Random lowercase id with a prefix, for example `n-3f9a1c2b7d`. */
export function newId(prefix: string): string {
    return `${prefix}-${randomBytes(5).toString("hex")}`;
}

/** File name part from a title: lowercase ASCII words joined by `-`, at most 48 characters. */
export function slugify(text: string): string {
    const slug = text
        .normalize("NFKD")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 48)
        .replace(/-+$/u, "");
    return slug || "item";
}

/** Safe single path segment for an id that comes from a harness. */
export function safeSegment(text: string): string {
    const cleaned = text.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "_");
    return cleaned.slice(0, 120) || "_";
}

/**
 * Write a file through a temporary file and a rename, so readers never see a partial file.
 * New folders get mode 0700.
 */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
    writeFileSync(temp, content, mode === undefined ? undefined : { mode });
    renameSync(temp, path);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** First sentence of a text, at most `limit` characters, on one line. */
export function firstSentence(text: string, limit = 160): string {
    const line = text.replace(/\s+/gu, " ").trim();
    const match = /^(.+?[.!?。！？])(?:\s|$)/u.exec(line);
    const sentence = match?.[1] ?? line;
    return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence;
}

/** Run async tasks with a concurrency limit. Results keep the input order. */
export async function mapLimit<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index] as T, index);
        }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
    await Promise.all(workers);
    return results;
}

export function byteLength(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

export function lineCount(text: string): number {
    if (!text) return 0;
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

/** True when a process with this id runs. A process of another user counts as running. */
export function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * Take a lock file that holds the process id. A lock whose process stopped is taken over. It
 * returns the release function, or the id of the live holder (null when unknown).
 */
export function takePidLock(file: string): { release: () => void } | { holder: number | null } {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(file, "wx", 0o600);
            writeSync(fd, String(process.pid));
            closeSync(fd);
            return {
                release: () => {
                    try {
                        if (readFileSync(file, "utf8").trim() === String(process.pid)) {
                            rmSync(file, { force: true });
                        }
                    } catch {
                        // The lock is gone already.
                    }
                },
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            let holder: number | null;
            try {
                holder = Number.parseInt(readFileSync(file, "utf8"), 10) || null;
            } catch {
                continue;
            }
            if (holder === process.pid || (holder && pidAlive(holder))) return { holder };
            rmSync(file, { force: true });
        }
    }
    return { holder: null };
}

/** Version of the package, for the health route and the MCP server info. */
export function packageVersion(): string {
    try {
        const raw = JSON.parse(
            readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ) as {
            version?: unknown;
        };
        return typeof raw.version === "string" ? raw.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}
