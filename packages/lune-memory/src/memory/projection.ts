import { randomBytes } from "node:crypto";
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeSync,
} from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

import {
    globalViewPaths,
    projectTranscriptDir,
    projectViewPaths,
    type MemoryPaths,
} from "../core/paths.ts";
import type { Item, ItemKind, Project, SessionRow, SourceRef } from "../core/types.ts";
import { firstSentence, nowIso, safeSegment, slugify, writeFileAtomic } from "../core/util.ts";
import type { Store } from "../store/db.ts";
import { getEvent, getProject, getSession, listItems, listProjects } from "../store/rows.ts";

/**
 * The Markdown projection. SQLite is the only store. The views are a read-only projection of
 * it: each full regeneration writes a new generation folder and swaps the `views` symlink to it
 * in one rename. Retired items disappear, and manual edits are lost.
 */

const FILE_MODE = 0o600;
const SHOWN_STATUSES = ["active", "provisional", "source-missing"] as const;
const RECENT_SESSIONS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

const KIND_TITLES: Record<ItemKind, string> = {
    decision: "Decisions",
    lesson: "Lessons",
    fact: "Facts",
    open_item: "Open items",
    reference: "References",
    preference: "Preferences",
    working_state: "Working State",
    wiki: "Wiki",
    index: "Project Index",
    note: "Notes",
};

const DURABLE_KINDS: readonly ItemKind[] = ["decision", "lesson", "fact", "reference", "note"];

const READ_ONLY_NOTE =
    "> Read-only view that lune-memory generates from its database. Edits are lost at the next Dreaming pass.";

export interface ProjectionOptions {
    now?: () => number;
}

export interface ProjectionResult {
    /** Name of the generation folder. */
    generation: string;
    /** Absolute path of the generation folder. */
    dir: string;
    /** Number of Markdown files written. */
    files: number;
}

/** File name of an item page, without `.md`. The id keeps names unique. */
export function itemFileName(item: Pick<Item, "id" | "title">): string {
    return `${slugify(item.title)}-${safeSegment(item.id)}`;
}

/** Folder of an item page, relative to a view root. Null for an item that has no own page. */
function itemFolder(item: Item): "notes" | "wiki" | null {
    if (item.kind === "index") return null;
    if (item.scope === "project" && item.kind === "wiki") return "wiki";
    return "notes";
}

function isShown(item: Item): boolean {
    return (SHOWN_STATUSES as readonly string[]).includes(item.status);
}

/** Path of an item page in the current views. Null for a retired item. */
export function itemViewPath(paths: MemoryPaths, item: Item): string | null {
    if (!isShown(item)) return null;
    if (item.scope === "global") {
        return join(globalViewPaths(paths).notes, `${itemFileName(item)}.md`);
    }
    if (!item.projectId) return null;
    const view = projectViewPaths(paths, item.projectId);
    const folder = itemFolder(item);
    if (!folder) return view.index;
    return join(folder === "wiki" ? view.wiki : view.notes, `${itemFileName(item)}.md`);
}

// ---------------------------------------------------------------------------------------------
// Rendering

function statusLabel(item: Item): string {
    const parts: string[] = [];
    if (item.status === "provisional") parts.push("provisional");
    if (item.status === "source-missing") parts.push("source missing");
    if (item.trust !== "user") parts.push(`trust ${item.trust}`);
    return parts.length ? ` (${parts.join(", ")})` : "";
}

function yamlValue(value: string | null): string {
    if (value === null) return "null";
    return /^[A-Za-z0-9._:/@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

/** Link target of an item, relative to the scope root, without `.md`. */
function linkTarget(item: Item): string {
    const folder = itemFolder(item);
    return folder ? `${folder}/${itemFileName(item)}` : "index";
}

function itemLink(item: Item): string {
    return `[[${linkTarget(item)}|${item.title.replace(/[[\]|]/gu, " ")}]]`;
}

/**
 * Rewrite `[[Title]]` and `[[Title|alias]]` in a body to the page of the item with that title in
 * the same scope. Other links stay as they are.
 */
function rewriteLinks(body: string, titles: Map<string, Item>): string {
    return body.replace(
        /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/gu,
        (match, target: string, anchor: string | undefined, alias: string | undefined) => {
            const item = titles.get(target.trim().toLowerCase());
            if (!item) return match;
            return `[[${linkTarget(item)}${anchor ?? ""}|${alias ?? target.trim()}]]`;
        },
    );
}

interface ScopeContext {
    store: Store;
    paths: MemoryPaths;
    /** Project of the scope. Null for Global Memory. */
    projectId: string | null;
    titles: Map<string, Item>;
    byId: Map<string, Item>;
}

function sourceLine(ctx: ScopeContext, source: SourceRef): string {
    if (source.kind === "item") {
        const target = ctx.byId.get(source.itemId);
        if (target) return `- Memory item ${itemLink(target)}`;
        return `- Memory item ${source.itemId} (not in this view)`;
    }
    const session = getSession(ctx.store, source.harness, source.sessionId);
    const event = getEvent(ctx.store, source.harness, source.sessionId, source.eventKey);
    const where = session?.transcriptPath
        ? `${session.transcriptPath}${event?.transcriptLine ? `:${event.transcriptLine}` : ""}`
        : "transcript not available";
    const link =
        session && ctx.projectId && session.projectId === ctx.projectId
            ? ` [[transcripts/${source.harness}/${safeSegment(source.sessionId)}]]`
            : "";
    const missing = event ? "" : " (event missing from the source)";
    return `- ${source.harness} session ${source.sessionId}, event e:${source.eventKey}${missing}: ${where}${link}`;
}

function renderItemPage(ctx: ScopeContext, item: Item): string {
    const lines = [
        "---",
        `id: ${yamlValue(item.id)}`,
        `kind: ${item.kind}`,
        `status: ${item.status}`,
        `trust: ${item.trust}`,
        `scope: ${item.scope}`,
        `project: ${yamlValue(item.projectId)}`,
        `branch: ${yamlValue(item.branch)}`,
        `origin: ${item.origin}`,
        `updated: ${yamlValue(item.updatedAt)}`,
        "---",
        "",
        `# ${item.title}`,
        "",
        READ_ONLY_NOTE,
        "",
    ];
    if (item.status === "provisional") {
        lines.push(
            "This is an agent note that Dreaming has not reviewed yet. Treat it as a claim, not as a fact.",
            "",
        );
    }
    if (item.status === "source-missing") {
        lines.push("The sources of this item are gone. Check it before you rely on it.", "");
    }
    lines.push(rewriteLinks(item.body.trim(), ctx.titles), "");
    if (item.sources.length) {
        lines.push("## Sources", "", ...item.sources.map((source) => sourceLine(ctx, source)), "");
    }
    return lines.join("\n");
}

function listLine(item: Item, withSummary = true): string {
    const summary = withSummary ? `: ${firstSentence(item.body)}` : "";
    return `- ${itemLink(item)}${statusLabel(item)}${summary}`;
}

function sessionLine(session: SessionRow, projectId: string | null): string {
    const time = session.updatedAt ?? session.changedAt;
    const title = session.title ? ` ${session.title.replace(/\s+/gu, " ").slice(0, 80)}` : "";
    const link = projectId
        ? `[[transcripts/${session.harness}/${safeSegment(session.id)}|${session.harness} ${time}]]`
        : `${session.harness} ${time}`;
    const processed =
        session.processedRevision !== null && session.processedRevision >= session.revision
            ? ""
            : " (not yet in memory)";
    return `- ${link}${title}${processed}`;
}

function recentSessions(store: Store, projectId: string): SessionRow[] {
    return store
        .all(
            "SELECT harness, id FROM sessions WHERE project_id = ? ORDER BY COALESCE(updated_at, changed_at) DESC LIMIT ?",
            projectId,
            RECENT_SESSIONS,
        )
        .map((row) => getSession(store, row.harness as SessionRow["harness"], String(row.id)))
        .filter((session): session is SessionRow => session !== null);
}

function sessionCount(store: Store, projectId: string): number {
    const row = store.get("SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?", projectId);
    return Number(row?.n ?? 0);
}

function openBranchNames(store: Store, projectId: string): string[] {
    return store
        .all(
            "SELECT name FROM branches WHERE project_id = ? AND status = 'open' ORDER BY first_seen, name",
            projectId,
        )
        .map((row) => String(row.name));
}

function renderProjectIndex(
    ctx: ScopeContext,
    project: Project,
    items: Item[],
    globalPrefs: Map<string, Item>,
): string {
    const lines = [`# ${project.name}`, "", READ_ONLY_NOTE, ""];
    lines.push(`Project id: ${project.id}`);
    if (project.root) lines.push(`Root: ${project.root}`);
    lines.push("");
    const shown = items.filter(isShown);
    const active = shown.filter((item) => item.status !== "provisional");
    const index = active.filter((item) => item.kind === "index");
    lines.push("## Overview", "");
    if (index.length) {
        for (const item of index) lines.push(rewriteLinks(item.body.trim(), ctx.titles), "");
    } else {
        lines.push("No Project Index yet. The next Dreaming pass writes it.", "");
    }

    const state = active.filter((item) => item.kind === "working_state");
    const branches = openBranchNames(ctx.store, project.id);
    const branchNames = [
        ...new Set([...branches, ...state.map((item) => item.branch ?? "")].filter(Boolean)),
    ];
    const projectWide = state.filter((item) => item.branch === null);
    if (branchNames.length || projectWide.length) {
        lines.push("## Branches", "");
        if (projectWide.length) {
            lines.push("### Project-wide", "", ...projectWide.map((item) => listLine(item)), "");
        }
        for (const name of branchNames) {
            const own = state.filter((item) => item.branch === name);
            lines.push(`### ${name}`, "");
            lines.push(
                ...(own.length ? own.map((item) => listLine(item)) : ["- No Working State yet."]),
            );
            lines.push("");
        }
    }

    const prefs = active.filter((item) => item.kind === "preference");
    if (prefs.length) {
        lines.push("## Preferences", "");
        for (const item of prefs) {
            const exceptions = item.sources
                .map((source) =>
                    source.kind === "item" ? globalPrefs.get(source.itemId) : undefined,
                )
                .filter((pref): pref is Item => pref !== undefined);
            const suffix = exceptions.length
                ? ` Exception to the global preference: ${exceptions.map((pref) => pref.title).join(", ")}.`
                : "";
            lines.push(`${listLine(item)}${suffix}`);
        }
        lines.push("");
    }

    const wiki = active.filter((item) => item.kind === "wiki");
    if (wiki.length) lines.push("## Wiki", "", ...wiki.map((item) => listLine(item)), "");

    const durable = active.filter((item) => DURABLE_KINDS.includes(item.kind));
    if (durable.length) {
        lines.push("## Durable knowledge", "");
        for (const kind of DURABLE_KINDS) {
            const group = durable.filter((item) => item.kind === kind);
            if (group.length)
                lines.push(
                    `### ${KIND_TITLES[kind]}`,
                    "",
                    ...group.map((item) => listLine(item)),
                    "",
                );
        }
    }

    const open = active.filter((item) => item.kind === "open_item");
    if (open.length) lines.push("## Open items", "", ...open.map((item) => listLine(item)), "");

    const provisional = shown.filter((item) => item.status === "provisional");
    if (provisional.length) {
        lines.push(
            "## Agent notes not yet reviewed",
            "",
            ...provisional.map((item) => `${listLine(item)} [${KIND_TITLES[item.kind]}]`),
            "",
        );
    }

    const sessions = recentSessions(ctx.store, project.id);
    lines.push("## Transcripts", "");
    lines.push(
        `Transcripts are evidence, not facts. Folder: ${projectTranscriptDir(ctx.paths, project.id)}`,
        "",
    );
    if (sessions.length) {
        lines.push(...sessions.map((session) => sessionLine(session, project.id)));
        const more = sessionCount(ctx.store, project.id) - sessions.length;
        if (more > 0) lines.push(`- ${more} older sessions. Use transcript_search to find them.`);
        lines.push("");
    }
    return lines.join("\n");
}

function renderGlobalIndex(ctx: ScopeContext, items: Item[], projects: Project[]): string {
    const lines = ["# Global Memory", "", READ_ONLY_NOTE, ""];
    const shown = items.filter(isShown);
    const active = shown.filter((item) => item.status !== "provisional");
    const prefs = active.filter((item) => item.kind === "preference");
    lines.push("## Preferences", "");
    lines.push(...(prefs.length ? prefs.map((item) => listLine(item)) : ["- None yet."]), "");
    const other = active.filter((item) => item.kind !== "preference");
    if (other.length) lines.push("## Knowledge", "", ...other.map((item) => listLine(item)), "");
    const provisional = shown.filter((item) => item.status === "provisional");
    if (provisional.length) {
        lines.push(
            "## Candidate notes not yet reviewed",
            "",
            "Only the global pass can promote these notes.",
            "",
            ...provisional.map((item) => `${listLine(item)} [${KIND_TITLES[item.kind]}]`),
            "",
        );
    }
    if (projects.length) {
        lines.push(
            "## Projects",
            "",
            ...projects.map(
                (project) =>
                    `- [[projects/${safeSegment(project.id)}/index|${project.name.replace(/[[\]|]/gu, " ")}]] ${project.id}`,
            ),
            "",
        );
    }
    return lines.join("\n");
}

function renderRootReadme(projects: Project[], generatedAt: string): string {
    return [
        "# Lune Memory",
        "",
        READ_ONLY_NOTE,
        "",
        `Generated: ${generatedAt}`,
        "",
        "- [[global/index|Global Memory]]",
        ...projects.map(
            (project) =>
                `- [[projects/${safeSegment(project.id)}/index|${project.name.replace(/[[\]|]/gu, " ")}]]`,
        ),
        "",
    ].join("\n");
}

function scopeContext(
    store: Store,
    paths: MemoryPaths,
    projectId: string | null,
    items: Item[],
): ScopeContext {
    const titles = new Map<string, Item>();
    const byId = new Map<string, Item>();
    for (const item of items.filter(isShown)) {
        byId.set(item.id, item);
        if (item.kind === "index") continue;
        const key = item.title.trim().toLowerCase();
        if (!titles.has(key)) titles.set(key, item);
    }
    return { store, paths, projectId, titles, byId };
}

function scopeItems(store: Store, projectId: string | null): Item[] {
    return projectId
        ? listItems(store, { scope: "project", projectId, status: [...SHOWN_STATUSES] })
        : listItems(store, { scope: "global", status: [...SHOWN_STATUSES] });
}

function globalPrefMap(store: Store): Map<string, Item> {
    return new Map(
        listItems(store, { scope: "global", kind: ["preference"], status: ["active"] }).map(
            (item) => [item.id, item],
        ),
    );
}

function linkTranscripts(paths: MemoryPaths, projectRoot: string, projectId: string): void {
    const link = join(projectRoot, "transcripts");
    try {
        lstatSync(link);
        return;
    } catch {
        // No link yet.
    }
    try {
        symlinkSync(
            projectTranscriptDir(paths, projectId),
            link,
            process.platform === "win32" ? "junction" : "dir",
        );
    } catch {
        // A file system without symlinks keeps the absolute transcript paths in the pages.
    }
}

/** Write the views of one scope into `root`. Returns the number of files written. */
function writeScope(
    store: Store,
    paths: MemoryPaths,
    root: string,
    project: Project | null,
    extra: { projects: Project[]; globalPrefs: Map<string, Item> },
): number {
    const items = scopeItems(store, project?.id ?? null);
    const ctx = scopeContext(store, paths, project?.id ?? null, items);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let files = 0;
    for (const item of items.filter(isShown)) {
        const folder = itemFolder(item);
        if (!folder) continue;
        writeFileAtomic(
            join(root, folder, `${itemFileName(item)}.md`),
            renderItemPage(ctx, item),
            FILE_MODE,
        );
        files++;
    }
    const index = project
        ? renderProjectIndex(ctx, project, items, extra.globalPrefs)
        : renderGlobalIndex(ctx, items, extra.projects);
    writeFileAtomic(join(root, "index.md"), index, FILE_MODE);
    files++;
    if (project) linkTranscripts(paths, root, project.id);
    return files;
}

// ---------------------------------------------------------------------------------------------
// Generations

function generationName(now: number): string {
    const stamp = nowIso(now).replace(/[-:.]/gu, "");
    return `g-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Folder that `views` points to now, or null when there are no views yet. */
export function currentGeneration(paths: MemoryPaths): string | null {
    try {
        const stat = lstatSync(paths.views);
        if (!stat.isSymbolicLink()) return null;
        const target = resolvePath(dirname(paths.views), readlinkSync(paths.views));
        return existsSync(target) ? realpathSync(target) : null;
    } catch {
        return null;
    }
}

/** Point `views` at `dir` in one rename. A real `views` folder moves into the generations. */
function swapViews(paths: MemoryPaths, dir: string): void {
    try {
        const stat = lstatSync(paths.views);
        if (!stat.isSymbolicLink()) {
            renameSync(
                paths.views,
                join(paths.generations, `g-legacy-${randomBytes(3).toString("hex")}`),
            );
        }
    } catch {
        // No views yet.
    }
    const temp = `${paths.views}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
    symlinkSync(dir, temp, process.platform === "win32" ? "junction" : "dir");
    try {
        renameSync(temp, paths.views);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}

/** Remove old generations. The newest `keep` folders and the current one stay. */
export function pruneGenerations(paths: MemoryPaths, keep: number): string[] {
    if (!existsSync(paths.generations)) return [];
    const current = currentGeneration(paths);
    const names = readdirSync(paths.generations)
        .filter((name) => name.startsWith("g-"))
        .filter((name) => {
            try {
                return statSync(join(paths.generations, name)).isDirectory();
            } catch {
                return false;
            }
        })
        .sort()
        .reverse();
    const stay = new Set(
        names.filter((name) => !name.startsWith("g-legacy-")).slice(0, Math.max(1, keep)),
    );
    if (current) stay.add(basename(current));
    const removed: string[] = [];
    for (const name of names) {
        if (stay.has(name)) continue;
        rmSync(join(paths.generations, name), { recursive: true, force: true });
        removed.push(name);
    }
    return removed;
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` with the projection lock held. The lock is a file that only one process can create.
 * It keeps a note projection from writing into a generation that a full regeneration replaces.
 * A lock older than one minute belongs to a process that stopped, so it is taken over.
 */
export function withProjectionLock<T>(paths: MemoryPaths, fn: () => T): T {
    const file = join(paths.home, "projection.lock");
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let fd: number | null = null;
    while (fd === null) {
        try {
            fd = openSync(file, "wx", FILE_MODE);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            try {
                if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) {
                    rmSync(file, { force: true });
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() > deadline) {
                throw new Error(`The projection lock ${file} is held by another process`, {
                    cause: error,
                });
            }
            sleepSync(50);
        }
    }
    try {
        writeSync(fd, String(process.pid));
        return fn();
    } finally {
        closeSync(fd);
        rmSync(file, { force: true });
    }
}

/**
 * Write a full new generation from SQLite, swap `views` to it and prune old generations. The
 * Dreaming pass calls it after each commit.
 */
export function regenerateProjection(
    store: Store,
    paths: MemoryPaths,
    config: { generations: number },
    options: ProjectionOptions = {},
): ProjectionResult {
    return withProjectionLock(paths, () => regenerateLocked(store, paths, config, options));
}

function regenerateLocked(
    store: Store,
    paths: MemoryPaths,
    config: { generations: number },
    options: ProjectionOptions,
): ProjectionResult {
    const now = (options.now ?? Date.now)();
    const generation = generationName(now);
    const dir = join(paths.generations, generation);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let files = 0;
    try {
        const projects = listProjects(store);
        const globalPrefs = globalPrefMap(store);
        files += writeScope(store, paths, join(dir, "global"), null, { projects, globalPrefs });
        for (const project of projects) {
            files += writeScope(
                store,
                paths,
                join(dir, "projects", safeSegment(project.id)),
                project,
                { projects, globalPrefs },
            );
        }
        writeFileAtomic(join(dir, "README.md"), renderRootReadme(projects, nowIso(now)), FILE_MODE);
        files++;
        swapViews(paths, dir);
    } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
    }
    pruneGenerations(paths, config.generations);
    return { generation, dir, files };
}

/**
 * Bring one item into the current generation at once, for example a new Agentic Note. The item
 * page is written or removed and the index of its scope is rewritten. Without views, a full
 * regeneration runs.
 */
export function projectItem(
    store: Store,
    paths: MemoryPaths,
    item: Item,
    config: { generations: number },
    options: ProjectionOptions = {},
): void {
    withProjectionLock(paths, () => projectItemLocked(store, paths, item, config, options));
}

function projectItemLocked(
    store: Store,
    paths: MemoryPaths,
    item: Item,
    config: { generations: number },
    options: ProjectionOptions,
): void {
    const current = currentGeneration(paths);
    if (!current) {
        regenerateLocked(store, paths, config, options);
        return;
    }
    const projects = listProjects(store);
    const globalPrefs = globalPrefMap(store);
    const project =
        item.scope === "project" && item.projectId ? getProject(store, item.projectId) : null;
    if (item.scope === "project" && !project) return;
    const root = project
        ? join(current, "projects", safeSegment(project.id))
        : join(current, "global");
    for (const folder of ["notes", "wiki"]) {
        const dir = join(root, folder);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
            if (name.endsWith(`-${safeSegment(item.id)}.md`))
                rmSync(join(dir, name), { force: true });
        }
    }
    const fresh = !existsSync(root);
    writeScope(store, paths, root, project, { projects, globalPrefs });
    if (fresh) {
        writeScope(store, paths, join(current, "global"), null, { projects, globalPrefs });
        writeFileAtomic(
            join(current, "README.md"),
            renderRootReadme(projects, nowIso((options.now ?? Date.now)())),
            FILE_MODE,
        );
    }
}
