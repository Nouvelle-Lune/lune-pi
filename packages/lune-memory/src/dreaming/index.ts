import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { MemoryConfig } from "../core/config.ts";
import type { MemoryPaths } from "../core/paths.ts";
import type { Item } from "../core/types.ts";
import { errorMessage, mapLimit, newId, takePidLock } from "../core/util.ts";
import { openBranches, stableL1Size } from "../memory/l1.ts";
import { regenerateProjection } from "../memory/projection.ts";
import type { Store } from "../store/db.ts";
import { getProject, listItems } from "../store/rows.ts";
import { analyzeSessions, type AnalyzerInput, type AnalyzerResult } from "./analyzer.ts";
import {
    pendingClosedBranches,
    projectsWithBranches,
    refreshBranches,
    type ClosedBranch,
} from "./branches.ts";
import {
    BudgetError,
    commitProject,
    recordFailure,
    sessionLabel,
    type CommitCounts,
} from "./commit.ts";
import { findEligible, markTrivial, type SessionSnapshot } from "./eligibility.ts";
import { addPins, pinItemSources, type EventPins } from "./evidence.ts";
import { globalWork, runGlobalPass, type GlobalPassResult } from "./global.ts";
import {
    addUsage,
    createDreamingModel,
    emptyUsage,
    type DreamingModel,
    type Usage,
} from "./model.ts";
import { organizeProject, type OrganizerInput, type OrganizerOp } from "./organizer.ts";

export type DreamEventType =
    | "pass_started"
    | "session_analyzed"
    | "project_committed"
    | "project_failed"
    | "global_finished"
    | "projection_written"
    | "pass_finished";

/** Runtime event of a pass. The daemon sends these over SSE. */
export interface DreamEvent {
    type: DreamEventType;
    pass: string;
    data: Record<string, unknown>;
}

export interface DreamOptions {
    /** Why the pass runs, for example `scan`, `manual` or `cli`. */
    trigger: string;
    /** Manual trigger: ignore the idle threshold and the attempt limit. */
    force?: boolean;
    /** Only sessions of this project. Null means sessions outside any project. */
    projectId?: string | null;
    /** Only these sessions, as `harness:id`. */
    sessions?: string[];
    now?: number;
    signal?: AbortSignal;
    /** Model to use instead of the configured one. Tests give a faux model. */
    model?: DreamingModel;
    /** Model registry for the configured model. Tests give a registry with the faux provider. */
    models?: Models;
    onEvent?: (event: DreamEvent) => void;
}

export interface ProjectPassResult {
    projectId: string;
    status: "ok" | "failed";
    runId: number;
    sessions: string[];
    counts: CommitCounts | null;
    summary: string;
    warnings: string[];
    error: string | null;
}

export type PassStatus = "ok" | "partial" | "failed" | "idle" | "busy" | "no-model";

export interface PassSummary {
    pass: string;
    trigger: string;
    status: PassStatus;
    startedAt: string;
    finishedAt: string;
    /** True when the pass called the model at least once. */
    called: boolean;
    eligible: number;
    deferred: number;
    waiting: number;
    stopped: number;
    trivial: number;
    /** Sessions whose Analyzer failed. */
    failedSessions: string[];
    projects: ProjectPassResult[];
    global: GlobalPassResult | null;
    closedBranches: string[];
    projection: string | null;
    usage: Usage;
    warnings: string[];
    errors: string[];
}

/** Statuses of item lists that the Organizer sees. */
const ORGANIZER_STATUSES = ["active", "provisional", "source-missing"] as const;

/** Error for a pass that another process runs now. */
export class DreamingBusyError extends Error {
    constructor(holder: number | null) {
        super(`Another Dreaming pass runs now${holder ? ` (process ${holder})` : ""}`);
        this.name = "DreamingBusyError";
    }
}

/**
 * Take the Dreaming lock. Only one pass runs at a time across the daemon and the CLI. A lock
 * whose process stopped is taken over. It returns the release function.
 */
export function takeDreamLock(paths: MemoryPaths): () => void {
    const lock = takePidLock(join(paths.home, "dream.lock"));
    if ("holder" in lock) throw new DreamingBusyError(lock.holder);
    return lock.release;
}

function newSummary(pass: string, trigger: string): PassSummary {
    const startedAt = new Date().toISOString();
    return {
        pass,
        trigger,
        status: "idle",
        startedAt,
        finishedAt: startedAt,
        called: false,
        eligible: 0,
        deferred: 0,
        waiting: 0,
        stopped: 0,
        trivial: 0,
        failedSessions: [],
        projects: [],
        global: null,
        closedBranches: [],
        projection: null,
        usage: emptyUsage(),
        warnings: [],
        errors: [],
    };
}

interface ProjectWork {
    projectId: string;
    results: AnalyzerResult[];
    closed: ClosedBranch[];
    /** Items of the closed branches. The Organizer can keep what is still useful. */
    closedItems: Map<string, Item[]>;
}

function needsOrganizer(work: ProjectWork): boolean {
    if (work.results.length) return true;
    return [...work.closedItems.values()].some((items) => items.length > 0);
}

/**
 * Run one Dreaming pass (§5). It refreshes branch states, finds eligible session revisions,
 * runs the Analyzers in parallel, the Organizer of each project, the global pass, and then
 * regenerates the Markdown projection. A pass with no eligible work makes no model call.
 * It never throws for a session or project failure: those are recorded as failed runs.
 */
export async function runDreamingPass(
    store: Store,
    paths: MemoryPaths,
    config: MemoryConfig,
    options: DreamOptions,
): Promise<PassSummary> {
    const pass = newId("p");
    const summary = newSummary(pass, options.trigger);
    const emit = (type: DreamEventType, data: Record<string, unknown> = {}): void => {
        try {
            options.onEvent?.({ type, pass, data });
        } catch {
            // A listener failure must not stop the pass.
        }
    };
    let release: () => void;
    try {
        release = takeDreamLock(paths);
    } catch (error) {
        summary.status = "busy";
        summary.errors.push(errorMessage(error));
        return summary;
    }
    try {
        emit("pass_started", { trigger: options.trigger, force: options.force === true });
        await runLocked(store, paths, config, options, summary, emit);
    } catch (error) {
        summary.errors.push(errorMessage(error));
        summary.status = "failed";
    } finally {
        release();
        summary.finishedAt = new Date().toISOString();
        emit("pass_finished", { status: summary.status, errors: summary.errors.length });
    }
    return summary;
}

async function runLocked(
    store: Store,
    paths: MemoryPaths,
    config: MemoryConfig,
    options: DreamOptions,
    summary: PassSummary,
    emit: (type: DreamEventType, data?: Record<string, unknown>) => void,
): Promise<void> {
    const now = options.now ?? Date.now();
    const { pass, trigger } = summary;

    for (const projectId of projectsWithBranches(store)) {
        if (options.projectId !== undefined && options.projectId !== projectId) continue;
        try {
            const refreshed = refreshBranches(store, projectId, now);
            summary.closedBranches.push(...refreshed.closed.map((name) => `${projectId}:${name}`));
        } catch (error) {
            summary.warnings.push(`Branch check of ${projectId} failed: ${errorMessage(error)}`);
        }
    }

    const found = findEligible(store, config.dreaming, {
        now,
        ...(options.force ? { force: true } : {}),
        ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
        ...(options.sessions ? { sessions: options.sessions } : {}),
    });
    summary.eligible = found.eligible.length;
    summary.deferred = found.deferred;
    summary.waiting = found.waiting;
    summary.stopped = found.stopped;
    summary.trivial = markTrivial(store, found.trivial);

    const work = new Map<string, ProjectWork>();
    const projectWork = (projectId: string): ProjectWork => {
        let entry = work.get(projectId);
        if (!entry) {
            entry = { projectId, results: [], closed: [], closedItems: new Map() };
            work.set(projectId, entry);
        }
        return entry;
    };
    const branchProjects =
        options.projectId === undefined
            ? projectsWithBranches(store)
            : options.projectId
              ? [options.projectId]
              : [];
    for (const projectId of branchProjects) {
        const closed = pendingClosedBranches(store, projectId);
        if (!closed.length) continue;
        const entry = projectWork(projectId);
        entry.closed = closed;
        for (const branch of closed) {
            entry.closedItems.set(
                branch.name,
                listItems(store, {
                    scope: "project",
                    projectId,
                    branch: branch.name,
                    status: ["active", "provisional"],
                }),
            );
        }
    }

    const needModel =
        found.eligible.length > 0 ||
        [...work.values()].some(needsOrganizer) ||
        globalWork(store, []).model;
    let model: DreamingModel | null = options.model ?? null;
    if (needModel && !model) {
        if (!config.dreaming.model) {
            summary.status = "no-model";
            summary.errors.push(
                "Dreaming has work but no model is configured. Set dreaming.model in the settings.",
            );
        } else {
            try {
                model = createDreamingModel(config.dreaming, paths, {
                    ...(options.models ? { models: options.models } : {}),
                });
            } catch (error) {
                summary.status = "no-model";
                summary.errors.push(errorMessage(error));
            }
        }
    }

    const itemProjects = new Set([
        ...work.keys(),
        ...found.eligible.flatMap((snapshot) => (snapshot.projectId ? [snapshot.projectId] : [])),
    ]);
    const itemPins = new Map<string, string | null>();
    for (const snapshot of found.eligible) addPins(itemPins, snapshot.itemPins);
    addPins(
        itemPins,
        pinItemSources(store, [
            ...listItems(store, { scope: "global", status: [...ORGANIZER_STATUSES] }),
            ...[...itemProjects].flatMap((projectId) =>
                listItems(store, {
                    scope: "project",
                    projectId,
                    status: [...ORGANIZER_STATUSES],
                }),
            ),
            ...found.eligible.flatMap((snapshot) => [...snapshot.notes, ...snapshot.earlier]),
        ]),
    );

    // Without a model, only closed branches with nothing left on them can close.
    const results: AnalyzerResult[] = [];
    if (model && found.eligible.length) {
        const inputs = found.eligible.map((snapshot) => analyzerInput(store, snapshot));
        results.push(
            ...(await analyzeSessions(model, inputs, config.dreaming.concurrency, options.signal)),
        );
        summary.called = true;
    }
    const modelRef = model?.ref ?? null;
    const globalResults: AnalyzerResult[] = [];
    for (const result of results) {
        addUsage(summary.usage, result.usage);
        const label = sessionLabel(result.snapshot);
        emit("session_analyzed", { session: label, ok: !result.error });
        if (result.error) {
            summary.failedSessions.push(label);
            recordFailure(store, {
                pass,
                kind: result.snapshot.projectId ? "project" : "global",
                projectId: result.snapshot.projectId,
                trigger,
                model: modelRef,
                snapshots: [result.snapshot],
                error: `Analyzer: ${result.error}`,
                usage: result.usage,
                warnings: result.warnings,
            });
            continue;
        }
        if (result.snapshot.projectId) {
            projectWork(result.snapshot.projectId).results.push(result);
            const notes = result.snapshot.notes.filter((note) => note.scope === "global");
            if (notes.length) {
                globalResults.push({
                    ...result,
                    snapshot: {
                        ...result.snapshot,
                        notes,
                        review: new Set(),
                        reviewOverflow: false,
                    },
                    candidates: result.candidates.filter(
                        (candidate) => candidate.kind === "preference" && candidate.general,
                    ),
                    unsupported: [],
                    noteReviews: result.noteReviews.filter((review) =>
                        notes.some((note) => note.id === review.noteId),
                    ),
                });
            }
        } else globalResults.push(result);
    }

    const projects = [...work.values()].filter((entry) => model || !needsOrganizer(entry));
    const outcomes = await mapLimit(projects, config.dreaming.concurrency, (entry) =>
        runProject(store, paths, model, entry, {
            pass,
            trigger,
            now,
            signal: options.signal,
            itemPins,
        }),
    );
    for (const outcome of outcomes) {
        summary.projects.push(outcome.result);
        if (outcome.called) summary.called = true;
        addUsage(summary.usage, outcome.usage);
        emit(outcome.result.status === "ok" ? "project_committed" : "project_failed", {
            projectId: outcome.result.projectId,
            runId: outcome.result.runId,
            sessions: outcome.result.sessions,
            counts: outcome.result.counts,
            error: outcome.result.error,
        });
    }

    if (model || !globalWork(store, globalResults).model) {
        const global = await runGlobalPass(store, paths, model, {
            pass,
            trigger,
            results: globalResults,
            itemPins,
            now,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (global.status !== "skipped") {
            summary.global = global;
            if (global.called) summary.called = true;
            addUsage(summary.usage, global.usage);
            emit("global_finished", {
                status: global.status,
                runId: global.runId,
                counts: global.counts,
                error: global.error,
            });
        }
    }

    const committed =
        summary.projects.some((entry) => entry.status === "ok") || summary.global?.status === "ok";
    if (committed) {
        try {
            const projection = regenerateProjection(store, paths, config);
            summary.projection = projection.generation;
            emit("projection_written", {
                generation: projection.generation,
                files: projection.files,
            });
        } catch (error) {
            summary.errors.push(`Projection failed: ${errorMessage(error)}`);
        }
    }

    const failures =
        summary.failedSessions.length +
        summary.projects.filter((entry) => entry.status === "failed").length +
        (summary.global?.status === "failed" ? 1 : 0);
    if (summary.status === "no-model") return;
    if (failures === 0 && !summary.errors.length) {
        summary.status = committed || summary.trivial ? "ok" : "idle";
    } else {
        summary.status = committed ? "partial" : "failed";
    }
}

function analyzerInput(store: Store, snapshot: SessionSnapshot): AnalyzerInput {
    if (!snapshot.projectId) return { snapshot, projectName: null, projectItems: [] };
    return {
        snapshot,
        projectName: getProject(store, snapshot.projectId)?.name ?? null,
        projectItems: listItems(store, {
            scope: "project",
            projectId: snapshot.projectId,
            status: [...ORGANIZER_STATUSES],
        }),
    };
}

interface ProjectOutcome {
    result: ProjectPassResult;
    called: boolean;
    /** Organizer usage only. The pass summary already counts the analyzer usage. */
    usage: Usage;
}

interface ProjectContext {
    pass: string;
    trigger: string;
    now: number;
    signal: AbortSignal | undefined;
    itemPins: EventPins;
}

/** Organize and commit one project. A failure is recorded as a failed run, not thrown. */
async function runProject(
    store: Store,
    paths: MemoryPaths,
    model: DreamingModel | null,
    work: ProjectWork,
    context: ProjectContext,
): Promise<ProjectOutcome> {
    const sessions = work.results.map((result) => sessionLabel(result.snapshot));
    // The run row records the analyzer and Organizer usage of its sessions.
    const usage = emptyUsage();
    const organizerUsage = emptyUsage();
    const result: ProjectPassResult = {
        projectId: work.projectId,
        status: "failed",
        runId: 0,
        sessions,
        counts: null,
        summary: "",
        warnings: [],
        error: null,
    };
    for (const entry of work.results) addUsage(usage, entry.usage);
    let called = false;
    try {
        const project = getProject(store, work.projectId);
        if (!project) throw new Error(`Project ${work.projectId} does not exist`);
        let feedback: string | undefined;
        for (let attempt = 0; ; attempt++) {
            let ops: OrganizerOp[] = [];
            const itemPins = new Map(context.itemPins);
            const warnings = work.results.flatMap((entry) => entry.warnings);
            if (needsOrganizer(work)) {
                if (!model) throw new Error("The Organizer needs a model, and none is configured");
                const input: OrganizerInput = {
                    projectId: project.id,
                    projectName: project.name,
                    results: work.results,
                    items: listItems(store, {
                        scope: "project",
                        projectId: project.id,
                        status: [...ORGANIZER_STATUSES],
                    }),
                    globals: listItems(store, {
                        scope: "global",
                        kind: ["preference"],
                        status: ["active"],
                    }),
                    openBranches: openBranches(store, project.id),
                    closedBranches: work.closed.map((branch) => ({
                        ...branch,
                        items: work.closedItems.get(branch.name) ?? [],
                    })),
                    l1: stableL1Size(store, paths, project.id),
                    ...(feedback ? { feedback } : {}),
                };
                // The model judges these items with their evidence as it is now.
                addPins(
                    itemPins,
                    pinItemSources(store, [
                        ...input.items,
                        ...input.globals,
                        ...input.closedBranches.flatMap((branch) => branch.items),
                    ]),
                );
                called = true;
                const plan = await organizeProject(model, input, context.signal);
                addUsage(usage, plan.usage);
                addUsage(organizerUsage, plan.usage);
                warnings.push(...plan.warnings);
                result.summary = plan.summary;
                if (plan.error) throw new Error(`Organizer: ${plan.error}`);
                ops = plan.ops;
            }
            try {
                const committed = commitProject(store, paths, {
                    pass: context.pass,
                    projectId: project.id,
                    trigger: context.trigger,
                    model: model?.ref ?? null,
                    results: work.results,
                    ops,
                    closedBranches: work.closed,
                    usage,
                    warnings,
                    itemPins,
                    now: context.now,
                });
                result.status = "ok";
                result.runId = committed.runId;
                result.counts = committed.counts;
                result.warnings = committed.warnings;
                return { result, called, usage: organizerUsage };
            } catch (error) {
                if (!(error instanceof BudgetError) || attempt > 0 || !needsOrganizer(work)) {
                    throw error;
                }
                feedback = error.message;
            }
        }
    } catch (error) {
        result.error = errorMessage(error);
        result.runId = recordFailure(store, {
            pass: context.pass,
            kind: "project",
            projectId: work.projectId,
            trigger: context.trigger,
            model: model?.ref ?? null,
            snapshots: work.results.map((entry) => entry.snapshot),
            error: result.error,
            usage,
            warnings: result.warnings,
        });
        return { result, called, usage: organizerUsage };
    }
}
