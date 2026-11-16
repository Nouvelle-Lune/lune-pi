import type { MemoryPaths } from "../core/paths.ts";
import {
    TRUST_RANK,
    type EventRow,
    type Item,
    type ItemKind,
    type SourceRef,
    type Trust,
} from "../core/types.ts";
import { newId, nowIso } from "../core/util.ts";
import { stableL1Size } from "../memory/l1.ts";
import { contentHash } from "../memory/notes.ts";
import type { Store } from "../store/db.ts";
import {
    finishRun,
    getItem,
    getSession,
    listItems,
    putItem,
    recordHistory,
    sourceKey,
    startRun,
} from "../store/rows.ts";
import type { AnalyzerResult, NoteReview } from "./analyzer.ts";
import type { ClosedBranch } from "./branches.ts";
import type { SessionSnapshot } from "./eligibility.ts";
import {
    BRANCH_KINDS,
    EVIDENCE_FREE_KINDS,
    clampTrust,
    eventSource,
    idemKey,
    liveEvents,
    uniqueSources,
} from "./evidence.ts";
import type { Usage } from "./model.ts";
import type { CreateOp, MergeOp, OrganizerOp, RetireOp, UpdateOp } from "./organizer.ts";

/** A commit that would make the stable part of L1 larger than its budget. It rolls back. */
export class BudgetError extends Error {
    readonly lines: number;
    readonly bytes: number;
    readonly branch: string | null;

    constructor(size: { lines: number; bytes: number; branch: string | null }) {
        const where = size.branch ? ` for branch ${size.branch}` : "";
        super(
            `The startup context${where} would be ${size.lines} lines and ${size.bytes} bytes, ` +
                "which is over the budget. Make it shorter: merge or retire items, and keep the " +
                "Project Index and the Working State short.",
        );
        this.name = "BudgetError";
        this.lines = size.lines;
        this.bytes = size.bytes;
        this.branch = size.branch;
    }
}

export interface CommitCounts {
    created: number;
    updated: number;
    retired: number;
    merged: number;
    rejected: number;
    notes: number;
}

export interface CommitResult {
    runId: number;
    counts: CommitCounts;
    warnings: string[];
    /** Items that the commit changed. */
    itemIds: string[];
}

export interface ProjectCommitInput {
    pass: string | null;
    projectId: string;
    trigger: string;
    model: string | null;
    /** Successful Analyzer results. The commit marks their covered events processed. */
    results: AnalyzerResult[];
    ops: OrganizerOp[];
    /** Closed branches that the Organizer saw. The commit retires their leftover Working State. */
    closedBranches: ClosedBranch[];
    usage: Usage;
    warnings: string[];
    now?: number;
}

export function sessionLabel(snapshot: Pick<SessionSnapshot, "session">): string {
    return `${snapshot.session.harness}:${snapshot.session.id}`;
}

function emptyCounts(): CommitCounts {
    return { created: 0, updated: 0, retired: 0, merged: 0, rejected: 0, notes: 0 };
}

/** Rejected operation. The commit records it as a warning and goes on. */
class Rejected extends Error {}

function reject(message: string): never {
    throw new Rejected(message);
}

function sameSources(a: readonly SourceRef[], b: readonly SourceRef[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((source, index) => {
        const other = b[index];
        return other !== undefined && sourceKey(source) === sourceKey(other);
    });
}

function changed(before: Item, after: Item): boolean {
    return (
        before.title !== after.title ||
        before.body !== after.body ||
        before.trust !== after.trust ||
        before.status !== after.status ||
        before.branch !== after.branch ||
        before.general !== after.general ||
        !sameSources(before.sources, after.sources)
    );
}

/** Shared state of one project commit. */
class ProjectCommit {
    readonly counts = emptyCounts();
    readonly warnings: string[] = [];
    readonly itemIds = new Set<string>();
    private readonly store: Store;
    private readonly projectId: string;
    private readonly runId: number;
    private readonly at: string;
    private readonly sessionBranches = new Map<string, string | null>();

    constructor(store: Store, projectId: string, runId: number, now: number) {
        this.store = store;
        this.projectId = projectId;
        this.runId = runId;
        this.at = nowIso(now);
    }

    rememberSession(snapshot: SessionSnapshot): void {
        this.sessionBranches.set(sessionLabel(snapshot), snapshot.session.branch);
    }

    private save(before: Item | null, after: Item): void {
        putItem(this.store, after);
        recordHistory(this.store, this.runId, after.id, before, after);
        this.itemIds.add(after.id);
    }

    private retireItem(item: Item): void {
        if (item.status === "retired") return;
        this.save(item, {
            ...item,
            status: "retired",
            updatedRun: this.runId,
            updatedAt: this.at,
        });
    }

    // -----------------------------------------------------------------------------------------
    // Note reviews

    /** Apply the note reviews of one session. Notes that a complete session left alone are kept. */
    reviewNotes(result: AnalyzerResult, handled: Set<string>): void {
        const reviews = new Map<string, NoteReview>();
        for (const review of result.noteReviews) {
            if (!reviews.has(review.noteId)) reviews.set(review.noteId, review);
        }
        for (const seen of result.snapshot.notes) {
            if (handled.has(seen.id)) continue;
            const review = reviews.get(seen.id);
            if (!review && !result.snapshot.complete) continue;
            handled.add(seen.id);
            const note = getItem(this.store, seen.id);
            if (!note || note.status !== "provisional" || note.origin !== "agent_note") continue;
            if (note.scope !== "project" || note.projectId !== this.projectId) continue;
            if (note.contentHash !== seen.contentHash) {
                this.warnings.push(`Note ${note.id} changed during the pass. It waits for review.`);
                continue;
            }
            this.applyReview(note, review ?? null);
        }
        for (const review of reviews.values()) {
            if (!result.snapshot.notes.some((note) => note.id === review.noteId)) {
                this.warnings.push(
                    `Review of note ${review.noteId} ignored: the session does not review it`,
                );
            }
        }
    }

    private applyReview(note: Item, review: NoteReview | null): void {
        this.counts.notes++;
        if (review?.action === "retract") {
            this.retireItem(note);
            return;
        }
        const sources = uniqueSources([
            ...note.sources,
            ...(review?.events ?? []).map(eventSource),
        ]);
        const title = review?.action === "correct" && review.title ? review.title : note.title;
        const body = review?.action === "correct" && review.body ? review.body : note.body;
        const events = liveEvents(this.store, sources);
        const after: Item = {
            ...note,
            title,
            body,
            contentHash: contentHash(title, body),
            sources,
            status: "active",
            trust: clampTrust(note.trust, events, note.kind),
            updatedRun: this.runId,
            updatedAt: this.at,
        };
        this.save(note, after);
    }

    // -----------------------------------------------------------------------------------------
    // Organizer operations

    apply(op: OrganizerOp): void {
        try {
            if (op.op === "create") this.create(op);
            else if (op.op === "update") this.update(op);
            else if (op.op === "retire") this.retire(op);
            else this.merge(op);
        } catch (error) {
            if (!(error instanceof Rejected)) throw error;
            this.counts.rejected++;
            this.warnings.push(`Rejected ${op.op}: ${error.message}`);
        }
    }

    /** A project item that an operation can change. */
    private target(id: string): Item {
        const item = getItem(this.store, id);
        if (!item || item.scope !== "project" || item.projectId !== this.projectId) {
            reject(`item ${id} is not an item of this project`);
        }
        if (item.status === "provisional") reject(`item ${id} is a provisional note`);
        if (item.status === "retired") reject(`item ${id} is retired`);
        return item;
    }

    /** Event sources of `from` items. They must be items of this project. */
    private fromSources(ids: readonly string[]): SourceRef[] {
        const sources: SourceRef[] = [];
        for (const id of ids) {
            const item = getItem(this.store, id);
            if (!item || item.scope !== "project" || item.projectId !== this.projectId) {
                reject(`from item ${id} is not an item of this project`);
            }
            sources.push(...item.sources.filter((source) => source.kind === "event"));
        }
        return sources;
    }

    /**
     * Item links. A link goes to an item of this project, or to an active global preference,
     * which makes a project preference an exception to it.
     */
    private linkSources(ids: readonly string[], kind: ItemKind, self?: string): SourceRef[] {
        const sources: SourceRef[] = [];
        for (const id of ids) {
            if (id === self) continue;
            const item = getItem(this.store, id);
            if (!item) reject(`link ${id} is not an item`);
            if (item.scope === "global") {
                if (
                    kind !== "preference" ||
                    item.kind !== "preference" ||
                    item.status !== "active"
                ) {
                    reject(`link ${id}: only a project preference can link to a global preference`);
                }
            } else if (item.projectId !== this.projectId) {
                reject(`link ${id} is an item of another project`);
            }
            sources.push({ kind: "item", itemId: id });
        }
        return sources;
    }

    private branchState(name: string): string | null {
        const row = this.store.get(
            "SELECT status FROM branches WHERE project_id = ? AND name = ?",
            this.projectId,
            name,
        );
        return row ? String(row.status) : null;
    }

    /**
     * Branch of a new or changed item. Only Working State and open items belong to a branch.
     * Without a branch from the model, it is the branch of the cited sessions when they agree.
     */
    private resolveBranch(
        kind: ItemKind,
        given: string | null,
        events: readonly EventRow[],
    ): string | null {
        if (!BRANCH_KINDS.includes(kind)) return null;
        let branch = given;
        if (branch === null) {
            const names = new Set<string | null>();
            for (const event of events) {
                const label = `${event.harness}:${event.sessionId}`;
                if (!this.sessionBranches.has(label)) {
                    this.sessionBranches.set(
                        label,
                        getSession(this.store, event.harness, event.sessionId)?.branch ?? null,
                    );
                }
                names.add(this.sessionBranches.get(label) ?? null);
            }
            branch = names.size === 1 ? ([...names][0] ?? null) : null;
        }
        if (branch === null) return null;
        const state = this.branchState(branch);
        if (state && state !== "open") {
            if (kind === "working_state") reject(`branch ${branch} is closed`);
            this.warnings.push(`Open item moved off the closed branch ${branch}`);
            return null;
        }
        return branch;
    }

    private duplicateOf(kind: ItemKind, hash: string, self: string | null): Item | null {
        const row = this.store.get(
            `SELECT id FROM items WHERE scope = 'project' AND project_id = ? AND kind = ?
            AND status IN ('active', 'source-missing') AND content_hash = ? AND id != ?`,
            this.projectId,
            kind,
            hash,
            self ?? "",
        );
        return row ? getItem(this.store, String(row.id)) : null;
    }

    private activeIndex(): Item | null {
        return (
            listItems(this.store, {
                scope: "project",
                projectId: this.projectId,
                kind: ["index"],
                status: ["active", "source-missing"],
            })[0] ?? null
        );
    }

    private create(op: CreateOp): void {
        if (op.kind === "index") {
            const index = this.activeIndex();
            if (index) {
                this.update({
                    op: "update",
                    id: index.id,
                    title: op.title,
                    body: op.body,
                    trust: null,
                    events: op.events,
                    from: op.from,
                    links: op.links,
                });
                return;
            }
        }
        const evidence = uniqueSources([
            ...op.events.map(eventSource),
            ...this.fromSources(op.from),
        ]);
        const events = liveEvents(this.store, evidence);
        if (!events.length && !EVIDENCE_FREE_KINDS.includes(op.kind)) {
            reject(`"${op.title}" has no evidence`);
        }
        const sources = uniqueSources([
            ...events.map(eventSource),
            ...this.linkSources(op.links, op.kind),
        ]);
        const hash = contentHash(op.title, op.body);
        const key = idemKey(op.kind, events, `${this.projectId}|${op.title}`);
        const known = this.store.get(
            "SELECT item_id FROM item_keys WHERE idem_key = ? AND content_hash = ?",
            key,
            hash,
        );
        if (known) reject(`"${op.title}" was extracted before as ${String(known.item_id)}`);
        const duplicate = this.duplicateOf(op.kind, hash, null);
        if (duplicate) reject(`"${op.title}" duplicates ${duplicate.id}`);
        const item: Item = {
            id: newId("i"),
            scope: "project",
            projectId: this.projectId,
            kind: op.kind,
            title: op.title,
            body: op.body,
            branch: this.resolveBranch(op.kind, op.branch, events),
            trust: clampTrust(op.trust, events, op.kind),
            status: "active",
            origin: "dreaming",
            general: op.kind === "preference" && op.general,
            writerHarness: null,
            writerSession: null,
            idemKey: key,
            contentHash: hash,
            createdRun: this.runId,
            updatedRun: this.runId,
            createdAt: this.at,
            updatedAt: this.at,
            sources,
        };
        this.save(null, item);
        this.store.run(
            "INSERT INTO item_keys (idem_key, content_hash, item_id, run_id) VALUES (?, ?, ?, ?)",
            key,
            hash,
            item.id,
            this.runId,
        );
        this.counts.created++;
    }

    private update(op: UpdateOp): void {
        const before = this.target(op.id);
        const sources = uniqueSources([
            ...before.sources,
            ...op.events.map(eventSource),
            ...this.fromSources(op.from),
            ...this.linkSources(op.links, before.kind, before.id),
        ]);
        const events = liveEvents(this.store, sources);
        const free = EVIDENCE_FREE_KINDS.includes(before.kind);
        if (!events.length && !free) reject(`item ${before.id} would have no evidence`);
        const title = op.title ?? before.title;
        const body = op.body ?? before.body;
        const branch =
            op.branch === undefined
                ? before.branch
                : this.resolveBranch(before.kind, op.branch, events);
        const after: Item = {
            ...before,
            title,
            body,
            branch,
            contentHash: contentHash(title, body),
            trust: clampTrust(op.trust ?? before.trust, events, before.kind),
            status:
                before.status === "source-missing" && (events.length || free)
                    ? "active"
                    : before.status,
            sources,
            updatedRun: this.runId,
            updatedAt: this.at,
        };
        if (!changed(before, after)) return;
        const duplicate = this.duplicateOf(after.kind, after.contentHash, after.id);
        if (duplicate) reject(`item ${after.id} would duplicate ${duplicate.id}`);
        this.save(before, after);
        if (op.events.length) {
            this.store.run(
                `INSERT OR IGNORE INTO item_keys (idem_key, content_hash, item_id, run_id)
                VALUES (?, ?, ?, ?)`,
                idemKey(after.kind, liveEvents(this.store, op.events.map(eventSource)), after.id),
                after.contentHash,
                after.id,
                this.runId,
            );
        }
        this.counts.updated++;
    }

    private retire(op: RetireOp): void {
        const item = getItem(this.store, op.id);
        if (item?.status === "retired" && item.projectId === this.projectId) return;
        this.retireItem(this.target(op.id));
        this.counts.retired++;
    }

    private merge(op: MergeOp): void {
        const items = op.ids.map((id) => this.target(id));
        const [keep, ...rest] = items;
        if (!keep || !rest.length) reject("a merge needs two items");
        if (items.some((item) => item.kind !== keep.kind))
            reject("merged items must have one kind");
        if (
            BRANCH_KINDS.includes(keep.kind) &&
            new Set(items.map((item) => item.branch)).size > 1
        ) {
            reject("merged items are on different branches");
        }
        const sources = uniqueSources([
            ...items.flatMap((item) => item.sources),
            ...op.events.map(eventSource),
            ...this.fromSources(op.from),
            ...this.linkSources(op.links, keep.kind, keep.id),
        ]).filter((source) => source.kind !== "item" || !op.ids.includes(source.itemId));
        const events = liveEvents(this.store, sources);
        const free = EVIDENCE_FREE_KINDS.includes(keep.kind);
        if (!events.length && !free) reject("the merged item would have no evidence");
        const claimed = items.reduce<Trust>(
            (best, item) => (TRUST_RANK[item.trust] > TRUST_RANK[best] ? item.trust : best),
            "inference",
        );
        const after: Item = {
            ...keep,
            title: op.title,
            body: op.body,
            contentHash: contentHash(op.title, op.body),
            trust: clampTrust(claimed, events, keep.kind),
            status: "active",
            general: items.some((item) => item.general),
            sources,
            updatedRun: this.runId,
            updatedAt: this.at,
        };
        const duplicate = this.duplicateOf(after.kind, after.contentHash, after.id);
        if (duplicate && !op.ids.includes(duplicate.id)) {
            reject(`the merged item would duplicate ${duplicate.id}`);
        }
        this.save(keep, after);
        for (const item of rest) this.retireItem(item);
        this.counts.merged++;
    }

    // -----------------------------------------------------------------------------------------
    // Closed branches and sessions

    /** Retire the Working State and open items that stay on a closed branch, and mark it handled. */
    closeBranch(branch: ClosedBranch): void {
        const pending = this.store.get(
            `SELECT 1 AS n FROM branches WHERE project_id = ? AND name = ? AND status != 'open'
            AND handled_run IS NULL`,
            this.projectId,
            branch.name,
        );
        if (!pending) return;
        const leftovers = listItems(this.store, {
            scope: "project",
            projectId: this.projectId,
            kind: [...BRANCH_KINDS],
            status: ["active", "source-missing"],
            branch: branch.name,
        });
        for (const item of leftovers) {
            this.retireItem(item);
            this.counts.retired++;
        }
        this.store.run(
            "UPDATE branches SET handled_run = ? WHERE project_id = ? AND name = ?",
            this.runId,
            this.projectId,
            branch.name,
        );
    }
}

/**
 * Mark the events that a snapshot covered as processed. An event that changed after the
 * snapshot keeps its old processed hash, so the next pass sees it again. The revision counts as
 * processed only when the snapshot covered all its events and it did not change.
 */
export function markProcessed(store: Store, snapshot: SessionSnapshot): void {
    const { harness, id } = snapshot.session;
    for (const [key, hash] of snapshot.covered) {
        store.run(
            `UPDATE events SET processed_hash = hash
            WHERE harness = ? AND session_id = ? AND key = ? AND hash = ?`,
            harness,
            id,
            key,
            hash,
        );
    }
    store.run(
        `UPDATE sessions SET attempts = 0, attempt_revision = NULL, last_error = NULL
        WHERE harness = ? AND id = ?`,
        harness,
        id,
    );
    if (snapshot.complete) {
        store.run(
            `UPDATE sessions SET processed_revision = revision
            WHERE harness = ? AND id = ? AND revision = ?`,
            harness,
            id,
            snapshot.revision,
        );
    }
}

/**
 * Validate and commit the Organizer operations of one project in one transaction. A rejected
 * operation becomes a warning. A commit that makes the stable L1 grow over its budget throws a
 * `BudgetError` and changes nothing.
 */
export function commitProject(
    store: Store,
    paths: MemoryPaths,
    input: ProjectCommitInput,
): CommitResult {
    const sessions = input.results.map((result) => sessionLabel(result.snapshot));
    return store.tx(() => {
        const before = stableL1Size(store, paths, input.projectId);
        const runId = startRun(store, {
            pass: input.pass,
            kind: "project",
            projectId: input.projectId,
            trigger: input.trigger,
            model: input.model,
            sessions,
        });
        const commit = new ProjectCommit(store, input.projectId, runId, input.now ?? Date.now());
        commit.warnings.push(...input.warnings);
        const handled = new Set<string>();
        for (const result of input.results) {
            commit.rememberSession(result.snapshot);
            commit.reviewNotes(result, handled);
        }
        for (const op of input.ops) commit.apply(op);
        for (const branch of input.closedBranches) commit.closeBranch(branch);
        for (const result of input.results) markProcessed(store, result.snapshot);
        const after = stableL1Size(store, paths, input.projectId);
        if (!after.fits && (after.lines > before.lines || after.bytes > before.bytes)) {
            throw new BudgetError(after);
        }
        finishRun(store, runId, {
            status: "ok",
            warnings: commit.warnings,
            usage: input.usage,
            sessions,
        });
        return {
            runId,
            counts: commit.counts,
            warnings: commit.warnings,
            itemIds: [...commit.itemIds],
        };
    });
}

export interface FailureInput {
    pass: string | null;
    kind: "project" | "global";
    projectId: string | null;
    trigger: string;
    model: string | null;
    snapshots: SessionSnapshot[];
    error: string;
    usage: Usage;
    warnings?: string[];
}

/**
 * Record a failed run. Each session revision counts one more attempt. A revision that reaches
 * the attempt limit waits for a change of its source.
 */
export function recordFailure(store: Store, input: FailureInput): number {
    const sessions = input.snapshots.map(sessionLabel);
    return store.tx(() => {
        const runId = startRun(store, {
            pass: input.pass,
            kind: input.kind,
            projectId: input.projectId,
            trigger: input.trigger,
            model: input.model,
            sessions,
        });
        finishRun(store, runId, {
            status: "failed",
            error: input.error,
            usage: input.usage,
            warnings: input.warnings ?? [],
            sessions,
        });
        for (const snapshot of input.snapshots) {
            store.run(
                `UPDATE sessions SET
                    attempts = CASE WHEN attempt_revision = ? THEN attempts + 1 ELSE 1 END,
                    attempt_revision = ?, last_error = ?
                WHERE harness = ? AND id = ?`,
                snapshot.revision,
                snapshot.revision,
                input.error,
                snapshot.session.harness,
                snapshot.session.id,
            );
        }
        return runId;
    });
}
