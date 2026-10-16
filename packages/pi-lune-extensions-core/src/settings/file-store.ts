/**
 * Low-level per-namespace JSON files used by the default backend.
 *
 * Each Settings ID owns one file per scope, so a damaged file affects only its own
 * namespace. A file holds that scope's overrides plus an optional "$version" marker;
 * absence means version 1, and empty overrides remove the file. Writes go through a
 * per-file queue shared across Core copies by Core Host and replace the file through
 * a same-directory temporary file and atomic rename.
 *
 * Missing files mean no overrides; corrupt files are never silently repaired. This
 * layer provides neither schema validation, live-view notification nor cross-process locks.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getCoreHost } from "../core/host.ts";

export type SettingsOverrides = Record<string, unknown>;

/** One scope's persisted state; version counts from 1 and is stored only above 1. */
export interface StoredSettings {
    readonly version: number;
    readonly overrides: SettingsOverrides;
}

const VERSION_KEY = "$version";

/** Directory holding global namespace files below Pi's agent directory. */
export function globalSettingsDirectory(agentDir: string): string {
    return path.resolve(agentDir, "lune-settings");
}

/** Directory holding project namespace files below the project's .pi directory. */
export function projectSettingsDirectory(cwd: string): string {
    return path.resolve(cwd, ".pi", "lune-settings");
}

/** IDs are validated as file names by defineSettings before reaching storage. */
export function settingsFile(directory: string, id: string): string {
    return path.join(directory, `${id}.json`);
}

function isPlainObject(value: unknown): value is SettingsOverrides {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only ENOENT means absence; swallowing corruption or permission errors would lose user data.
async function readStored(file: string): Promise<StoredSettings> {
    let rawText: string;
    try {
        rawText = await fs.readFile(file, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { version: 1, overrides: {} };
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new SyntaxError(`Invalid settings JSON in ${file}: ${error.message}`, {
            cause: error,
        });
    }
    if (!isPlainObject(parsed)) throw new TypeError(`Settings file is not a JSON object: ${file}`);
    const overrides: SettingsOverrides = {};
    let version = 1;
    for (const [key, value] of Object.entries(parsed)) {
        if (key === VERSION_KEY) {
            if (!Number.isSafeInteger(value) || (value as number) < 1)
                throw new TypeError(
                    `Invalid "${VERSION_KEY}" in ${file}: expected a positive integer`,
                );
            version = value as number;
        } else if (key.startsWith("$")) {
            throw new TypeError(`Unknown settings metadata "${key}" in ${file}`);
        } else {
            // Own data properties keep "__proto__" keys from invoking prototype setters.
            Object.defineProperty(overrides, key, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }
    return { version, overrides };
}

// A sibling temporary file keeps rename on the same filesystem; failed writes clean it up.
async function writeStored(file: string, stored: StoredSettings): Promise<void> {
    if (!Object.keys(stored.overrides).length) {
        await fs.rm(file, { force: true });
        return;
    }
    const root: SettingsOverrides = {};
    if (stored.version > 1) root[VERSION_KEY] = stored.version;
    for (const [key, value] of Object.entries(stored.overrides))
        Object.defineProperty(root, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmpPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        // Settings may hold secrets such as API keys; rename keeps this owner-only mode.
        await fs.writeFile(tmpPath, `${JSON.stringify(root, null, 4)}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });
        await fs.rename(tmpPath, file);
    } catch (error) {
        try {
            await fs.rm(tmpPath, { force: true });
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                "Settings write and temporary file cleanup failed",
            );
        }
        throw error;
    }
}

// Both success and failure advance the tail; one bad write must not poison later work.
function serialize<T>(file: string, task: () => Promise<T>): Promise<T> {
    const queues = getCoreHost().settings.fileQueues;
    const prev = queues.get(file) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(file, next);
    const release = () => {
        if (queues.get(file) === next) queues.delete(file);
    };
    next.then(release, release);
    return next;
}

/**
 * Read, transform and conditionally rewrite one file under its shared queue.
 *
 * The synchronous transform receives an isolated copy and returns the complete next
 * state; an unchanged result performs no write, and empty overrides remove the file.
 * Transform/I/O failures propagate without writing; later queued operations proceed.
 * @returns The state now on disk.
 * @internal
 */
export function updateStoredSettings(
    file: string,
    transform: (stored: StoredSettings) => StoredSettings,
): Promise<StoredSettings> {
    return serialize(file, async () => {
        const current = await readStored(file);
        const next = transform(structuredClone(current));
        if (!isPlainObject(next.overrides))
            throw new TypeError(`Settings overrides for ${file} must be a plain object`);
        if (!isDeepStrictEqual(next, current)) await writeStored(file, next);
        return next;
    });
}
