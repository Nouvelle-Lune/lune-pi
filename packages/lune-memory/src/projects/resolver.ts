import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve as resolvePath, sep } from "node:path";

import { MemoryOperationError } from "../core/errors.ts";
import type { LocatorKind, Project } from "../core/types.ts";
import { hash8, nowIso } from "../core/util.ts";
import { text, textOrNull, type Store } from "../store/db.ts";
import { getProject, liveProjectId } from "../store/rows.ts";
import { currentBranch, repoInfo, type RepoInfo } from "./git.ts";

export interface Resolution {
    projectId: string;
    /** Branch of the work tree now. Null outside a repo or on a detached HEAD. */
    branch: string | null;
    repo: RepoInfo | null;
}

/** A session that moved to another project. */
interface SessionRef {
    harness: string;
    sessionId: string;
}

export interface ResolverOptions {
    /** How long a result for one cwd stays in the cache. */
    ttlMs?: number;
    now?: () => number;
}

function realpath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** The nearest folder of `path` that exists, or null. A deleted cwd still finds its repo. */
function nearestExisting(path: string): string | null {
    let current = resolvePath(path);
    for (;;) {
        if (existsSync(current)) return realpath(current);
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

/**
 * Id of the project that a locator makes. A repo project uses its git common dir and a
 * registered folder uses its path, so a split of that locator finds the same id again.
 */
function projectIdFor(kind: LocatorKind, value: string): string {
    const key = kind === "git_common_dir" ? "git" : kind;
    return `p-${hash8(`${key}:${value}`)}`;
}

function isInside(path: string, root: string): boolean {
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Maps a cwd to a project. A project is the innermost git repo. Its locators are the git common
 * dir and the normalized remotes, so worktrees and clones of one repo share one project. A
 * folder outside any repo has a project only when the user registers its path.
 */
export class ProjectResolver {
    private readonly store: Store;
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly cache = new Map<string, { at: number; value: Resolution | null }>();

    constructor(store: Store, options: ResolverOptions = {}) {
        this.store = store;
        this.ttlMs = options.ttlMs ?? 60_000;
        this.now = options.now ?? Date.now;
    }

    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Project of `cwd`. Creates the project of a repo on first sight. The cache keeps the
     * project, but the branch comes from the work tree on each call: a checkout changes it at
     * any time.
     */
    resolve(cwd: string): Resolution | null {
        const cached = this.cache.get(cwd);
        if (cached && this.now() - cached.at < this.ttlMs) return this.refresh(cached.value);
        const value = this.resolveNow(cwd);
        this.cache.set(cwd, { at: this.now(), value });
        return value;
    }

    /** A cached result with the branch of now and the live project, after a merge elsewhere. */
    private refresh(value: Resolution | null): Resolution | null {
        if (!value) return null;
        const projectId = liveProjectId(this.store, value.projectId);
        if (!value.repo) return { ...value, projectId };
        const branch = currentBranch(value.repo.root);
        return { projectId, branch, repo: { ...value.repo, branch } };
    }

    private resolveNow(cwd: string): Resolution | null {
        if (!cwd) return null;
        const dir = nearestExisting(cwd);
        if (!dir) return null;
        const repo = repoInfo(dir);
        if (repo) {
            const projectId = this.store.tx(() => this.projectForRepo(repo));
            return { projectId, branch: repo.branch, repo };
        }
        const projectId = this.projectForPath(dir);
        return projectId ? { projectId, branch: null, repo: null } : null;
    }

    private locatorOwner(kind: LocatorKind, value: string): string | null {
        const row = this.store.get(
            "SELECT project_id FROM project_locators WHERE kind = ? AND value = ?",
            kind,
            value,
        );
        return row ? liveProjectId(this.store, text(row, "project_id")) : null;
    }

    private addLocator(kind: LocatorKind, value: string, projectId: string): void {
        this.store.run(
            "INSERT OR IGNORE INTO project_locators(kind, value, project_id, created_at) VALUES (?, ?, ?, ?)",
            kind,
            value,
            projectId,
            nowIso(this.now()),
        );
    }

    private createProject(id: string, name: string, root: string | null): void {
        if (getProject(this.store, id)) {
            // A project that was merged away and now has a locator again comes back with its
            // own name and root.
            this.store.run("UPDATE projects SET merged_into = NULL WHERE id = ?", id);
            return;
        }
        this.store.run(
            "INSERT INTO projects(id, name, root, merged_into, created_at) VALUES (?, ?, ?, NULL, ?)",
            id,
            name,
            root,
            nowIso(this.now()),
        );
    }

    private projectForRepo(repo: RepoInfo): string {
        let projectId = this.locatorOwner("git_common_dir", repo.commonDir);
        if (!projectId) {
            for (const remote of repo.remotes) {
                projectId = this.locatorOwner("remote", remote);
                if (projectId) break;
            }
        }
        if (!projectId) {
            projectId = projectIdFor("git_common_dir", repo.commonDir);
            this.createProject(projectId, basename(repo.root) || "project", repo.root);
        } else {
            // A repo that moved keeps its project, and the root follows it.
            const root = getProject(this.store, projectId)?.root;
            if (root && root !== repo.root && !existsSync(root)) {
                this.store.run("UPDATE projects SET root = ? WHERE id = ?", repo.root, projectId);
            }
        }
        this.addLocator("git_common_dir", repo.commonDir, projectId);
        for (const remote of repo.remotes) this.addLocator("remote", remote, projectId);
        return projectId;
    }

    /** Project of the longest registered path that holds `dir`. */
    private projectForPath(dir: string): string | null {
        let best: { value: string; projectId: string } | null = null;
        for (const row of this.store.all(
            "SELECT value, project_id FROM project_locators WHERE kind = 'path'",
        )) {
            const value = text(row, "value");
            if (!isInside(dir, value)) continue;
            if (!best || value.length > best.value.length) {
                best = { value, projectId: text(row, "project_id") };
            }
        }
        return best ? liveProjectId(this.store, best.projectId) : null;
    }

    /**
     * Register a folder as a project. A folder in a repo uses the project of that repo. Other
     * folders get a path locator. Unassigned sessions in the folder join the project at once.
     */
    register(path: string, name?: string): Project {
        const dir = nearestExisting(path);
        if (!dir || dir !== realpath(resolvePath(path))) {
            throw new MemoryOperationError(`Folder not found: ${path}`);
        }
        const repo = repoInfo(dir);
        const projectId = this.store.tx(() => {
            if (repo) return this.projectForRepo(repo);
            const exact = this.locatorOwner("path", dir);
            if (exact) return exact;
            const id = projectIdFor("path", dir);
            this.createProject(id, basename(dir) || dir, dir);
            this.addLocator("path", dir, id);
            return id;
        });
        if (name?.trim()) this.rename(projectId, name.trim());
        this.clearCache();
        this.adoptSessions(projectId, null);
        const project = getProject(this.store, projectId);
        if (!project) throw new Error(`Project ${projectId} is missing after register`);
        return project;
    }

    /**
     * Move the sessions of `from` (null: unassigned sessions) whose cwd now resolves to
     * `projectId`. They become unprocessed, so Dreaming builds the memory of the project from
     * them. Items stay where they are. Returns the moved sessions.
     */
    private adoptSessions(projectId: string, from: string | null): SessionRef[] {
        const sessions = this.store.all(
            from === null
                ? "SELECT harness, id, cwd, branch FROM sessions WHERE project_id IS NULL AND cwd IS NOT NULL"
                : "SELECT harness, id, cwd, branch FROM sessions WHERE project_id = ? AND cwd IS NOT NULL",
            ...(from === null ? [] : [from]),
        );
        const moved: SessionRef[] = [];
        for (const session of sessions) {
            const cwd = textOrNull(session, "cwd");
            if (!cwd || this.resolve(cwd)?.projectId !== projectId) continue;
            const harness = text(session, "harness");
            const sessionId = text(session, "id");
            this.store.tx(() => {
                this.store.run(
                    "UPDATE sessions SET project_id = ?, processed_revision = NULL WHERE harness = ? AND id = ?",
                    projectId,
                    harness,
                    sessionId,
                );
                this.store.run(
                    "UPDATE events SET processed_hash = NULL, processed_chars = NULL WHERE harness = ? AND session_id = ?",
                    harness,
                    sessionId,
                );
                const branch = textOrNull(session, "branch");
                if (branch) {
                    this.store.run(
                        "INSERT OR IGNORE INTO branches(project_id, name, status, first_seen) VALUES (?, ?, 'open', ?)",
                        projectId,
                        branch,
                        nowIso(this.now()),
                    );
                }
            });
            moved.push({ harness, sessionId });
        }
        return moved;
    }

    /**
     * Move the project items of `from` that belong to the moved sessions: each event source is
     * in a moved session, or the item has no event source and a moved session wrote it. Their
     * sessions resolve to `projectId` now, so in `from` no review of these sessions would reach
     * the items (§3). An item with evidence from a session that stays also stays. Returns the
     * number of moved items.
     */
    private adoptItems(projectId: string, from: string, sessions: readonly SessionRef[]): number {
        if (sessions.length === 0) return 0;
        const movedSession = new Set(sessions.map((s) => `${s.harness}\0${s.sessionId}`));
        const items = this.store.all(
            "SELECT id, branch, writer_harness, writer_session FROM items WHERE project_id = ? AND scope = 'project'",
            from,
        );
        let moved = 0;
        this.store.tx(() => {
            for (const item of items) {
                const itemId = text(item, "id");
                const sources = this.store
                    .all(
                        "SELECT harness, session_id FROM item_sources WHERE item_id = ? AND ref_kind = 'event'",
                        itemId,
                    )
                    .map((row) => `${text(row, "harness")}\0${text(row, "session_id")}`);
                const writer = `${textOrNull(item, "writer_harness")}\0${textOrNull(item, "writer_session")}`;
                const belongs =
                    sources.length > 0
                        ? sources.every((source) => movedSession.has(source))
                        : movedSession.has(writer);
                if (!belongs) continue;
                this.store.run("UPDATE items SET project_id = ? WHERE id = ?", projectId, itemId);
                const branch = textOrNull(item, "branch");
                if (branch) {
                    this.store.run(
                        "INSERT OR IGNORE INTO branches(project_id, name, status, first_seen) VALUES (?, ?, 'open', ?)",
                        projectId,
                        branch,
                        nowIso(this.now()),
                    );
                }
                moved++;
            }
        });
        return moved;
    }

    rename(projectId: string, name: string): void {
        const id = liveProjectId(this.store, projectId);
        const changed = this.store.run("UPDATE projects SET name = ? WHERE id = ?", name, id);
        if (changed.changes === 0) throw new MemoryOperationError(`Unknown project: ${projectId}`);
    }

    /**
     * Merge `source` into `target`. Locators, sessions, items and branches move to the target.
     * The source row stays with `merged_into`, so old ids still resolve.
     */
    merge(source: string, target: string): { source: string; target: string } {
        const from = liveProjectId(this.store, source);
        const to = liveProjectId(this.store, target);
        if (!getProject(this.store, from))
            throw new MemoryOperationError(`Unknown project: ${source}`);
        if (!getProject(this.store, to))
            throw new MemoryOperationError(`Unknown project: ${target}`);
        if (from === to)
            throw new MemoryOperationError(`${source} and ${target} are the same project`);
        this.store.tx(() => {
            this.store.run("UPDATE projects SET merged_into = ? WHERE id = ?", to, from);
            this.store.run("UPDATE projects SET merged_into = ? WHERE merged_into = ?", to, from);
            this.store.run(
                "UPDATE project_locators SET project_id = ? WHERE project_id = ?",
                to,
                from,
            );
            this.store.run("UPDATE sessions SET project_id = ? WHERE project_id = ?", to, from);
            this.store.run(
                "UPDATE items SET project_id = ? WHERE project_id = ? AND scope = 'project'",
                to,
                from,
            );
            this.store.run(
                "UPDATE OR IGNORE branches SET project_id = ? WHERE project_id = ?",
                to,
                from,
            );
            this.store.run("DELETE FROM branches WHERE project_id = ?", from);
        });
        this.clearCache();
        return { source: from, target: to };
    }

    /**
     * Move one locator to a project of its own. Sessions whose cwd now resolves to that project
     * move with it and become unprocessed, so Dreaming builds the memory of that project from
     * them. Items move only when all their evidence is in the moved sessions (`adoptItems`), and
     * Dreaming reviews them with these sessions. The target is never a live project: a project
     * that the locator made and that was merged away comes back, else the split makes a new one.
     */
    split(
        kind: LocatorKind,
        value: string,
        name?: string,
    ): { project: Project; moved: number; items: number } {
        const row = this.store.get(
            "SELECT project_id FROM project_locators WHERE kind = ? AND value = ?",
            kind,
            value,
        );
        if (!row) throw new MemoryOperationError(`Unknown locator: ${kind} ${value}`);
        const from = liveProjectId(this.store, text(row, "project_id"));
        const remaining = this.store.get(
            "SELECT COUNT(*) AS n FROM project_locators WHERE project_id = ?",
            from,
        );
        if (Number(remaining?.n ?? 0) <= 1) {
            throw new MemoryOperationError(
                `${kind} ${value} is the only locator of ${from}. Nothing to split.`,
            );
        }
        const id = this.splitTarget(kind, value, from);
        const root =
            kind === "path"
                ? value
                : kind === "git_common_dir" && basename(value) === ".git"
                  ? dirname(value)
                  : null;
        const label =
            name?.trim() ||
            (root ? basename(root) : basename(value.replace(/\.git$/u, ""))) ||
            "project";
        this.store.tx(() => {
            this.createProject(id, label, root);
            if (name?.trim()) {
                this.store.run("UPDATE projects SET name = ? WHERE id = ?", name.trim(), id);
            }
            this.store.run(
                "UPDATE project_locators SET project_id = ? WHERE kind = ? AND value = ?",
                id,
                kind,
                value,
            );
        });
        this.clearCache();
        const sessions = this.adoptSessions(id, from);
        const items = this.adoptItems(id, from, sessions);
        const project = getProject(this.store, id);
        if (!project) throw new Error(`Project ${id} is missing after split`);
        return { project, moved: sessions.length, items };
    }

    /**
     * Id of the project that a split of a locator goes to. The candidates are the id that the
     * locator makes, then ids salted with `split:<attempt>:`. The first candidate that is not
     * `from` and is missing or merged away wins, so a split never moves a locator into a live
     * project, and a project that an earlier split of the locator made comes back.
     */
    private splitTarget(kind: LocatorKind, value: string, from: string): string {
        for (let attempt = 0; ; attempt++) {
            // The attempt comes before the kind and the value, so no other locator value can
            // make the same seed.
            const id =
                attempt === 0
                    ? projectIdFor(kind, value)
                    : `p-${hash8(`split:${attempt}:${kind}:${value}`)}`;
            if (id === from) continue;
            const project = getProject(this.store, id);
            if (!project || project.mergedInto !== null) return id;
        }
    }

    /** Locators of a project, for status output. */
    locators(projectId: string): Array<{ kind: LocatorKind; value: string }> {
        return this.store
            .all(
                "SELECT kind, value FROM project_locators WHERE project_id = ? ORDER BY kind, value",
                liveProjectId(this.store, projectId),
            )
            .map((row) => ({ kind: text(row, "kind") as LocatorKind, value: text(row, "value") }));
    }
}
