import type { StreamFn } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, contentText, lazyStream, type Usage } from "@earendil-works/pi-ai";
import {
    compact,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionBeforeCompactEvent,
    type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import type { ModelReference } from "@lune_99/pi-lune-extensions-core/panel";
import { validateOptions, type ConfigurationProvider } from "./options.ts";
import { resolveClassifier } from "./tool-review/classification.ts";
import {
    checkpointRecord,
    reviewToolHistory,
    type ToolReviewProgress,
    type ToolReviewReport,
} from "./tool-review/review.ts";

export const COMPACTION_POLICY_VERSION = "lune-jev-v5";

export type CompactionStage =
    | "preparing"
    | "chunks"
    | "summarizing"
    | "awaiting-commit"
    | "complete"
    | "failed"
    | "cancelled";

export interface CompactionRun {
    readonly id: number;
    readonly sessionId: string;
    readonly leafId: string | null;
    readonly reason: SessionBeforeCompactEvent["reason"];
    summaryModel?: ModelReference;
    policyVersion?: string;
    readonly startedAt: number;
    stage: CompactionStage;
    completedBatches: number;
    totalBatches: number;
    finishedAt?: number;
    error?: Error;
    jev?: ToolReviewReport;
    summaryUsage?: Usage;
    summary?: string;
}

/** What a presentation layer sees of a reviewed run; the report is shared, not copied. */
export interface CompactionRunUpdate {
    readonly runId: number;
    readonly stage: CompactionStage;
    /** `provider/id`, known once the classifier is resolved. */
    readonly reviewModel?: string;
    readonly candidateTools?: number;
    readonly protectedTools?: number;
    readonly completedBatches: number;
    readonly totalBatches: number;
    readonly jev?: Readonly<ToolReviewReport>;
    readonly error?: string;
}

/** Receives every visible change of a reviewed run, and `undefined` when its notice no longer applies. */
export type CompactionRunListener = (
    update: CompactionRunUpdate | undefined,
    ctx: ExtensionContext,
) => void;

export interface CompactionControllerOptions {
    readonly onRunChange?: CompactionRunListener;
}

/** Route summaries through Pi's registry and reject any split response that did not finish normally. */
export function createSummaryStream(
    ctx: ExtensionContext,
    signal: AbortSignal,
    assertActive: () => void,
): StreamFn {
    return (model, context, options) => {
        assertActive();
        signal.throwIfAborted();
        // Pi owns routing, authentication, output limits and error-event construction.
        // Validate each split-turn response before native compact can combine it with another summary.
        return lazyStream(model, async () => {
            const response = await ctx.modelRegistry
                .streamSimple(model, context, { ...options, signal, maxRetries: 0 })
                .result();
            assertActive();
            signal.throwIfAborted();
            if (response.stopReason !== "stop")
                throw new Error(
                    `Summary ${response.stopReason}: ${response.errorMessage ?? "generation did not finish normally"}`,
                );
            if (!contentText(response.content).trim())
                throw new Error("Summary returned empty text");
            // Native compact rejects tool calls and writes the checkpoint through Pi's session lifecycle.
            return (async function* () {
                yield { type: "done" as const, reason: "stop" as const, message: response };
            })();
        });
    };
}

/** Owns every compaction run of one extension instance: its abort controller, generation and commit tracking. */
export class CompactionController {
    private generation = 0;
    private sequence = 0;
    private active: AbortController | undefined;
    private run: CompactionRun | undefined;
    private readonly unregister: (() => void)[] = [];
    private readonly getConfiguration: ConfigurationProvider;
    private readonly onRunChange: CompactionRunListener | undefined;

    constructor(
        pi: ExtensionAPI,
        getConfiguration: ConfigurationProvider,
        options: CompactionControllerOptions = {},
    ) {
        this.getConfiguration = getConfiguration;
        this.onRunChange = options.onRunChange;
        const retire = (ctx: ExtensionContext): void => {
            this.invalidate();
            this.publish(ctx, undefined);
        };
        this.unregister.push(
            pi.on("session_before_compact", (event, ctx) => this.beforeCompact(event, ctx)),
            pi.on("session_start", (_event, ctx) => {
                retire(ctx);
                this.run = undefined;
            }),
            pi.on("session_shutdown", (_event, ctx) => retire(ctx)),
            pi.on("session_before_switch", (_event, ctx) => retire(ctx)),
            pi.on("session_before_fork", (_event, ctx) => retire(ctx)),
            pi.on("session_before_tree", (_event, ctx) => retire(ctx)),
            pi.on("session_compact", (event, ctx) => {
                const run = this.awaitingCommit(ctx);
                if (!run) return;
                const details = event.compactionEntry.details as
                    | { luneCompaction?: { runId?: number } }
                    | undefined;
                if (
                    details?.luneCompaction?.runId !== run.id ||
                    event.compactionEntry.summary !== run.summary
                ) {
                    run.stage = "failed";
                    run.error = new Error(
                        "Another compaction handler replaced the generated checkpoint",
                    );
                    this.report(ctx, run.error);
                } else {
                    run.stage = "complete";
                }
                run.finishedAt = Date.now();
                if (run.jev) this.publish(ctx, run);
            }),
            pi.on("session_compact_failed", (event, ctx) => {
                const run = this.awaitingCommit(ctx);
                if (!run) return;
                run.stage = event.aborted ? "cancelled" : "failed";
                run.finishedAt = Date.now();
                if (!event.aborted) {
                    run.error = new Error(
                        event.errorMessage ?? "Pi failed to commit the generated checkpoint",
                    );
                    this.report(ctx, run.error);
                }
                if (run.jev) this.publish(ctx, run);
            }),
        );
    }

    getRun(): Readonly<CompactionRun> | undefined {
        if (!this.run) return undefined;
        // Inspection must not let a future UI mutate private model choices or decision/cost records.
        const { error, ...data } = this.run;
        const snapshot = structuredClone(data);
        return Object.freeze(error === undefined ? snapshot : { ...snapshot, error });
    }

    private awaitingCommit(ctx: ExtensionContext): CompactionRun | undefined {
        const run = this.run;
        return run?.stage === "awaiting-commit" &&
            run.sessionId === ctx.sessionManager.getSessionId()
            ? run
            : undefined;
    }

    private invalidate(): void {
        this.generation++;
        this.active?.abort(new DOMException("Compaction session was retired", "AbortError"));
        if (this.run?.stage === "awaiting-commit") {
            this.run.stage = "cancelled";
            this.run.finishedAt = Date.now();
        }
    }

    private publish(
        ctx: ExtensionContext,
        run: CompactionRun | undefined,
        progress?: { readonly reviewModel: string; readonly review?: ToolReviewProgress },
    ): void {
        if (!this.onRunChange) return;
        const update: CompactionRunUpdate | undefined = run && {
            runId: run.id,
            stage: run.stage,
            reviewModel: run.jev?.model ?? progress?.reviewModel,
            candidateTools: run.jev?.candidateTools ?? progress?.review?.candidateTools,
            protectedTools: run.jev?.protectedTools.length ?? progress?.review?.protectedTools,
            completedBatches: run.completedBatches,
            totalBatches: run.totalBatches,
            jev: run.jev,
            error: run.error?.message,
        };
        try {
            this.onRunChange(update, ctx);
        } catch (listenerError) {
            // Presentation must never fail or retry a compaction.
            console.warn("[pi-compaction] Run listener failed", listenerError);
        }
    }

    private report(ctx: ExtensionContext, error: Error): void {
        // Error reporting must not turn a cancel result into a swallowed hook exception.
        console.error("[pi-compaction]", error);
        if (ctx.hasUI) {
            try {
                ctx.ui.notify(`Lune compaction failed: ${error.message}`, "error");
            } catch (notificationError) {
                console.error("[pi-compaction] Error notification failed", notificationError);
            }
        }
    }

    async beforeCompact(
        event: SessionBeforeCompactEvent,
        ctx: ExtensionContext,
    ): Promise<SessionBeforeCompactResult> {
        if (this.active || this.run?.stage === "awaiting-commit") {
            this.report(ctx, new Error("A Lune compaction operation is already active"));
            return { cancel: true };
        }
        const generation = this.generation;
        const cancel = new AbortController();
        this.active = cancel;
        const run: CompactionRun = {
            id: ++this.sequence,
            sessionId: ctx.sessionManager.getSessionId(),
            leafId: ctx.sessionManager.getLeafId(),
            reason: event.reason,
            startedAt: Date.now(),
            stage: "preparing",
            completedBatches: 0,
            totalBatches: 0,
        };
        const previousRun = this.run;
        this.run = run;
        let reviewing = false;
        const signal = AbortSignal.any([event.signal, cancel.signal]);
        const assertActive = (): void => {
            signal.throwIfAborted();
            if (
                generation !== this.generation ||
                ctx.sessionManager.getSessionId() !== run.sessionId ||
                ctx.sessionManager.getLeafId() !== run.leafId
            ) {
                cancel.abort(
                    new DOMException("Compaction session changed before commit", "AbortError"),
                );
                signal.throwIfAborted();
            }
        };
        try {
            assertActive();
            // Freeze resolved configuration before any request so a split turn cannot mix settings.
            const configuration = structuredClone(await this.getConfiguration(ctx));
            assertActive();
            if (configuration === null) {
                // Disabling interception is a configured mode, never a response to failure.
                this.run = previousRun;
                this.publish(ctx, undefined);
                return {};
            }
            validateOptions(configuration);
            run.summaryModel = configuration.summaryModel;
            run.policyVersion = COMPACTION_POLICY_VERSION;
            const model = ctx.modelRegistry.find(
                configuration.summaryModel.provider,
                configuration.summaryModel.id,
            );
            if (!model)
                throw new Error(
                    `Summary model ${configuration.summaryModel.provider}/${configuration.summaryModel.id} is not registered`,
                );
            const thinkingLevel = clampThinkingLevel(model, configuration.summaryThinkingLevel);
            // Native compact reads preparation without mutating it; only the review replaces these message arrays.
            const preparation = { ...event.preparation };
            if (configuration.jev.enabled) {
                reviewing = true;
                this.publish(ctx, run);
                const classifier = await resolveClassifier(configuration.jev.model, ctx, signal);
                assertActive();
                const reviewModel = `${classifier.provider}/${classifier.id}`;
                this.publish(ctx, run, { reviewModel });
                const reviewed = await reviewToolHistory(
                    event,
                    ctx,
                    configuration.policy,
                    classifier,
                    configuration.jev.concurrency,
                    signal,
                    (update) => {
                        assertActive();
                        run.stage = update.stage;
                        run.completedBatches = update.completedBatches;
                        run.totalBatches = update.totalBatches;
                        this.publish(ctx, run, { reviewModel, review: update });
                    },
                );
                assertActive();
                preparation.messagesToSummarize = reviewed.messagesToSummarize;
                preparation.turnPrefixMessages = reviewed.turnPrefixMessages;
                run.jev = reviewed.report;
            } else {
                // A notice from an earlier review would describe a checkpoint this run replaces.
                this.publish(ctx, undefined);
            }
            assertActive();
            run.stage = "summarizing";
            if (run.jev) this.publish(ctx, run);
            const result = await compact(
                preparation,
                model,
                undefined,
                undefined,
                event.customInstructions,
                signal,
                thinkingLevel,
                createSummaryStream(ctx, signal, assertActive),
            );
            assertActive();
            run.summaryUsage = result.usage;
            run.summary = result.summary;
            run.stage = "awaiting-commit";
            const details = result.details as { readFiles: string[]; modifiedFiles: string[] };
            return {
                compaction: {
                    ...result,
                    details: {
                        ...details,
                        luneCompaction: {
                            runId: run.id,
                            policyVersion: COMPACTION_POLICY_VERSION,
                            summaryModel: configuration.summaryModel,
                            summaryThinkingLevel: thinkingLevel,
                            reason: event.reason,
                            jev: run.jev ? checkpointRecord(run.jev) : { enabled: false },
                        },
                    },
                },
            };
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            const cancelled =
                signal.aborted || generation !== this.generation || failure.name === "AbortError";
            run.stage = cancelled ? "cancelled" : "failed";
            run.finishedAt = Date.now();
            if (!cancelled) {
                run.error = failure;
                this.report(ctx, failure);
            }
            // A retired session already cleared its notice; its context must not draw a new one.
            if (reviewing && generation === this.generation) this.publish(ctx, run);
            return { cancel: true };
        } finally {
            if (this.active === cancel) this.active = undefined;
        }
    }

    dispose(): void {
        this.invalidate();
        for (const unregister of this.unregister.splice(0)) unregister();
    }
}
