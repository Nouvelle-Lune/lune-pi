import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseClaudeSession } from "./claude.ts";
import { parseCodexSession } from "./codex.ts";
import { jsonl, string } from "./jsonl.ts";
import {
    SOURCE_NAMES,
    type ExternalSession,
    type LocalSession,
    type SessionSource,
} from "./session.ts";
import { fileVersion, type SessionIndex } from "./session-index.ts";

type ExternalSource = Exclude<SessionSource, "pi">;

/** Parsed sessions live in the shared index; the Codex title index is cached per Pi session. */
export class ExternalSessions {
    private readonly codexHome = resolve(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"));
    private readonly claudeHome = resolve(
        process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"),
    );
    private readonly index: SessionIndex;
    private titleIndex: { version: string; names: Map<string, string> } | undefined;

    constructor(index: SessionIndex) {
        this.index = index;
    }

    async list(signal: AbortSignal, report: (error: unknown) => void): Promise<LocalSession[]> {
        const errors: Error[] = [];
        const sources: ExternalSource[] = ["codex", "claude"];
        const results = await Promise.all(
            sources.map(async (source) => {
                try {
                    const paths = await this.paths(source);
                    const names = source === "codex" ? await this.codexNames(signal) : new Map();
                    const sessions: LocalSession[] = [];
                    // One file per source at a time bounds memory when rollouts contain large tool results.
                    for (const path of paths) {
                        signal.throwIfAborted();
                        try {
                            const version = fileVersion(await stat(path));
                            let entry = this.index.get(path, version);
                            if (!entry) {
                                const content = await readFile(path, { encoding: "utf8", signal });
                                entry = {
                                    version,
                                    session: parseExternalSession(source, content, path)?.session,
                                };
                                this.index.set(path, entry);
                            }
                            let session = entry.session;
                            if (session) {
                                const name =
                                    source === "codex" ? names.get(session.id) : session.name;
                                if (name !== session.name) {
                                    session = { ...session, name };
                                    this.index.set(path, { version, session });
                                }
                                // Stable objects preserve autocomplete's existing WeakMap search cache.
                                sessions.push(session);
                            }
                        } catch (error) {
                            signal.throwIfAborted();
                            errors.push(fileError(source, path, error));
                        }
                    }
                    return sessions;
                } catch (error) {
                    signal.throwIfAborted();
                    errors.push(
                        fileError(
                            source,
                            source === "codex" ? this.codexHome : this.claudeHome,
                            error,
                        ),
                    );
                    return [];
                }
            }),
        );
        signal.throwIfAborted();
        if (errors.length > 0) {
            report(new AggregateError(errors, errors.map((error) => error.message).join("\n")));
        }
        return results.flat();
    }

    clear(): void {
        this.titleIndex = undefined;
    }

    private async paths(source: ExternalSource): Promise<string[]> {
        const root = join(
            source === "codex" ? this.codexHome : this.claudeHome,
            source === "codex" ? "sessions" : "projects",
        );
        let projects: string[];
        try {
            if (source === "codex") {
                return (await readdir(root, { recursive: true }))
                    .filter((file) => /^rollout-.+\.jsonl$/.test(basename(file)))
                    .map((file) => join(root, file));
            }
            projects = (await readdir(root, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => join(root, entry.name));
        } catch (error) {
            // Neither external tool is required to be installed; only an absent store is empty.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        // Subagents and tool-result stores are nested below the main files; never traverse them.
        const files = await Promise.all(
            projects.map(async (project) =>
                (await readdir(project, { withFileTypes: true }))
                    .filter(
                        (entry) =>
                            entry.isFile() &&
                            entry.name.endsWith(".jsonl") &&
                            !entry.name.startsWith("agent-"),
                    )
                    .map((entry) => join(project, entry.name)),
            ),
        );
        return files.flat();
    }

    private async codexNames(signal: AbortSignal): Promise<Map<string, string>> {
        const path = join(this.codexHome, "session_index.jsonl");
        let content: string;
        let version: string;
        try {
            const stats = await stat(path);
            version = `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
            if (this.titleIndex?.version === version) return this.titleIndex.names;
            content = await readFile(path, { encoding: "utf8", signal });
        } catch (error) {
            // The title index is optional; the rollout itself owns the session and its messages.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                this.titleIndex = undefined;
                return new Map();
            }
            throw error;
        }
        const names = new Map<string, string>();
        try {
            for (const record of jsonl(content, path)) {
                names.set(
                    string(record.id, "session_index.id"),
                    string(record.thread_name, "thread_name"),
                );
            }
        } catch {
            // TODO: Record Codex title parser errors in Core Log when it is available.
            names.clear();
        }
        if (!signal.aborted) this.titleIndex = { version, names };
        return names;
    }
}

export function parseExternalSession(
    source: ExternalSource,
    content: string,
    path: string,
): ExternalSession | undefined {
    try {
        return source === "codex"
            ? parseCodexSession(content, path)
            : parseClaudeSession(content, path);
    } catch {
        // TODO: Record Codex and Claude Code parser errors in Core Log when it is available.
        return undefined;
    }
}

function fileError(source: ExternalSource, path: string, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${SOURCE_NAMES[source]}: ${path}: ${message}`, { cause: error });
}
