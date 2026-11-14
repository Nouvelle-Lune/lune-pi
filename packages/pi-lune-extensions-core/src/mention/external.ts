import type { Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseClaudeSession } from "./claude.ts";
import { parseCodexSession } from "./codex.ts";
import { jsonl, string } from "./jsonl.ts";
import { SOURCE_NAMES, type ExternalSession, type SessionSource } from "./session.ts";
import type { SessionFile } from "./session-index.ts";

type ExternalSource = Exclude<SessionSource, "pi">;

/** Codex and Claude Code session files; the Codex title index is cached per Pi session. */
export class ExternalSessions {
    private readonly codexHome = resolve(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"));
    private readonly claudeHome = resolve(
        process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"),
    );
    private titleIndex: { version: string; names: Map<string, string> } | undefined;

    async list(signal: AbortSignal, report: (error: unknown) => void): Promise<SessionFile[]> {
        const errors: Error[] = [];
        const sources: ExternalSource[] = ["codex", "claude"];
        const results = await Promise.all(
            sources.map(async (source) => {
                try {
                    const paths = await this.paths(source);
                    const names = source === "codex" ? await this.codexNames(signal) : undefined;
                    const files = await Promise.all(
                        paths.map(async (path) => {
                            try {
                                return externalFile(source, path, await stat(path), names);
                            } catch (error) {
                                // Removed since the directory was listed.
                                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                                    errors.push(fileError(source, path, error));
                                }
                                return undefined;
                            }
                        }),
                    );
                    return files.filter((file) => file !== undefined);
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

function externalFile(
    source: ExternalSource,
    path: string,
    stats: Stats,
    codexNames: ReadonlyMap<string, string> | undefined,
): SessionFile {
    return {
        path,
        stats,
        label: SOURCE_NAMES[source],
        async read(signal) {
            const content = await readFile(path, { encoding: "utf8", signal });
            return parseExternalSession(source, content, path)?.session;
        },
        // Codex keeps titles in its own index, so a rename does not change the rollout.
        current: codexNames
            ? (session) => {
                  const name = codexNames.get(session.id);
                  // The same object keeps autocomplete's search cache for the session.
                  return name === session.name ? session : { ...session, name };
              }
            : undefined,
    };
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
