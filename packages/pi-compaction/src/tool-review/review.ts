import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ClassifierContext, ClassifierModel, TextContent, Usage } from "@earendil-works/pi-ai";
import {
    estimateTokens,
    type ExtensionContext,
    type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionPolicy } from "../options.ts";
import {
    candidateContext,
    chunkResult,
    collectReviewInput,
    indexTools,
    type ProtectedTool,
    type ResultChunk,
    type ToolPair,
} from "./candidates.ts";
import { isClassifierOverflow, runRequests } from "./classification.ts";

const CHUNK_CHARS = 4_000;

const SAFE_TO_DROP_QUESTION = {
    type: "bool",
    instructions:
        "Estimate whether this fragment of a tool result can be omitted from future model context without removing unique information that is still useful for continuing the current task. Judge the fragment relative to the surrounding task context, tool call, arguments, and recorded outcome. A fragment is safe to drop when its useful information is already reflected elsewhere, has been superseded, is merely transient execution detail, or is no longer relevant to the remaining work. Do not preserve a fragment merely because it could hypothetically be useful later. Use the probability to express uncertainty.",
    criteria: {
        true: "Dropping this fragment would not remove unique actionable information needed to continue the task. Its relevant information is already captured elsewhere, superseded, redundant, transient, or irrelevant.",
        false: "This fragment contains unique information that may materially affect subsequent reasoning or actions, such as unresolved findings, current state, required values, errors that still matter, or evidence not preserved elsewhere.",
    },
} as const;

export type ChunkDecision =
    | {
          readonly chunkId: string;
          readonly probability: number;
          readonly action: "keep" | "drop";
      }
    | {
          readonly chunkId: string;
          readonly action: "keep" | "placeholder";
          readonly reason: "classifier-context-window";
      };

export interface BudgetFallback {
    readonly candidateId: string;
    readonly stage: "chunks";
    readonly action: "placeholder";
    readonly estimatedTokens: number;
}

export interface ToolReviewReport {
    readonly model: string;
    readonly pricingKnown: boolean;
    readonly protectedTools: readonly ProtectedTool[];
    readonly candidateTools: number;
    readonly chunks: readonly ResultChunk[];
    readonly chunkDecisions: readonly ChunkDecision[];
    readonly removedCalls: readonly string[];
    readonly oversizedRequests: number;
    readonly requests: number;
    readonly requestBudget: number;
    readonly budgetFallbacks: readonly BudgetFallback[];
    readonly usage: readonly Usage[];
    /** Serialized native message payload size, including metadata; not summary prompt tokens. */
    readonly charsBefore: number;
    readonly charsAfter: number;
}

export interface ToolReviewProgress {
    readonly stage: "chunks";
    readonly completedBatches: number;
    readonly totalBatches: number;
}

export async function reviewToolHistory(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    policy: CompactionPolicy,
    classifier: ClassifierModel<string>,
    signal: AbortSignal,
    progress: (update: ToolReviewProgress) => void,
): Promise<{
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    report: ToolReviewReport;
}> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(classifier.contextWindow) || classifier.contextWindow <= 0)
        throw new Error("Classifier contextWindow must be a positive integer");
    const budget = Math.floor(classifier.contextWindow * 0.9);
    const { preparation, projection } = collectReviewInput(event, ctx);
    const index = indexTools(
        preparation.messagesToSummarize,
        preparation.turnPrefixMessages,
        projection,
        preparation.firstKeptEntryId,
        policy,
    );
    const chunks = index.pairs.flatMap((pair) => chunkResult(pair, CHUNK_CHARS));
    const contexts = new Map(
        index.pairs.map((pair) => [pair.id, candidateContext(pair, index.locations)]),
    );
    const decisions = new Map<string, ChunkDecision>();
    const fallbacks: BudgetFallback[] = [];
    const pending: { chunkId: string; request: ClassifierContext }[] = [];
    for (const chunk of chunks) {
        signal.throwIfAborted();
        const request: ClassifierContext = {
            state: { ...contexts.get(chunk.toolCallId)!, result: chunk.text },
            questions: { safeToDrop: SAFE_TO_DROP_QUESTION },
        };
        // Pi estimates chat messages; the margin covers classifier protocol framing.
        const estimatedTokens = Math.ceil(
            estimateTokens({ role: "user", content: JSON.stringify(request), timestamp: 0 }) *
                (4 / 3),
        );
        if (estimatedTokens > budget) {
            decisions.set(chunk.id, {
                chunkId: chunk.id,
                action: "placeholder",
                reason: "classifier-context-window",
            });
            fallbacks.push({
                candidateId: chunk.id,
                stage: "chunks",
                action: "placeholder",
                estimatedTokens,
            });
        } else {
            pending.push({ chunkId: chunk.id, request });
        }
    }
    const results = await runRequests(
        pending.map(({ request }) => request),
        (request, requestSignal) =>
            ctx.modelRegistry.classify(classifier, request, {
                signal: requestSignal,
                maxRetries: 0,
            }),
        signal,
        (completedBatches, totalBatches) =>
            progress({ stage: "chunks", completedBatches, totalBatches }),
    );
    let oversizedRequests = 0;
    results.forEach((result, position) => {
        const chunkId = pending[position]!.chunkId;
        if (isClassifierOverflow(result)) {
            oversizedRequests++;
            decisions.set(chunkId, {
                chunkId,
                action: "keep",
                reason: "classifier-context-window",
            });
        } else {
            const answer = result.answers.safeToDrop!;
            if (answer.type !== "bool")
                throw new Error("Classifier returned an invalid safeToDrop answer");
            const probability = answer.probability;
            decisions.set(chunkId, {
                chunkId,
                probability,
                action: probability >= policy.deleteThreshold ? "drop" : "keep",
            });
        }
    });
    signal.throwIfAborted();
    const chunkDecisions = chunks.map((chunk) => decisions.get(chunk.id)!);
    const { removedCalls, ...filtered } = applyDecisions(
        preparation.messagesToSummarize,
        preparation.turnPrefixMessages,
        index.pairs,
        chunks,
        chunkDecisions,
    );
    const report: ToolReviewReport = {
        model: `${classifier.provider}/${classifier.id}`,
        // Pi Registry classifiers always carry catalog pricing.
        pricingKnown: true,
        protectedTools: index.protectedTools,
        candidateTools: index.pairs.length,
        chunks,
        chunkDecisions,
        removedCalls,
        oversizedRequests,
        requests: pending.length,
        requestBudget: budget,
        budgetFallbacks: fallbacks,
        usage: results.flatMap((result) => (result.usage ? [result.usage] : [])),
        charsBefore: JSON.stringify([
            event.preparation.messagesToSummarize,
            event.preparation.turnPrefixMessages,
        ]).length,
        charsAfter: JSON.stringify([filtered.messagesToSummarize, filtered.turnPrefixMessages])
            .length,
    };
    return { ...filtered, report };
}

export function applyDecisions(
    history: readonly AgentMessage[],
    prefix: readonly AgentMessage[],
    pairs: readonly ToolPair[],
    chunks: readonly ResultChunk[],
    chunkDecisions: readonly ChunkDecision[],
): {
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    removedCalls: string[];
} {
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    if (chunkById.size !== chunks.length)
        throw new Error("Duplicate chunk IDs in the decision plan");
    const chunkActions = new Map<string, ChunkDecision>();
    for (const decision of chunkDecisions) {
        const chunk = chunkById.get(decision.chunkId);
        if (!chunk || chunkActions.has(decision.chunkId))
            throw new Error(`Unknown or duplicate chunk decision ${decision.chunkId}`);
        chunkActions.set(decision.chunkId, decision);
    }
    const pairById = new Map(pairs.map((pair) => [pair.id, pair]));
    if (pairById.size !== pairs.length) throw new Error("Duplicate candidate call IDs");
    const regions = { history, prefix } as const;
    const removedCalls: string[] = [];
    const rewritten = new Map<AgentMessage, AgentMessage>();
    const droppedResults = new Set<AgentMessage>();
    const droppedCalls = new Map<AgentMessage, Set<string>>();
    for (const pair of pairs) {
        const callRegion = pair.call.region === "retained" ? undefined : regions[pair.call.region];
        const resultRegion =
            pair.result.region === "retained" ? undefined : regions[pair.result.region];
        if (
            !callRegion ||
            !resultRegion ||
            pair.call.region !== pair.result.region ||
            callRegion[pair.call.index] !== pair.call.message ||
            resultRegion[pair.result.index] !== pair.result.message
        ) {
            throw new Error(`Candidate ${pair.id} no longer belongs to its native summary region`);
        }
        const result = pair.result.message;
        if (result.role !== "toolResult") throw new Error(`Missing result for ${pair.id}`);
        const own = chunks.filter((chunk) => chunk.toolCallId === pair.id);
        for (let blockIndex = 0; blockIndex < result.content.length; blockIndex++) {
            const block = result.content[blockIndex]!;
            if (block.type !== "text") throw new Error(`Non-text candidate ${pair.id}`);
            let cursor = 0;
            for (const chunk of own.filter((chunk) => chunk.blockIndex === blockIndex)) {
                if (
                    !Number.isSafeInteger(chunk.start) ||
                    !Number.isSafeInteger(chunk.end) ||
                    chunk.start !== cursor ||
                    chunk.end <= chunk.start ||
                    chunk.text !== block.text.slice(chunk.start, chunk.end)
                ) {
                    throw new Error(`Chunk ${chunk.id} no longer matches the original result`);
                }
                if (!chunkActions.has(chunk.id))
                    throw new Error(`Missing decision for ${chunk.id}`);
                cursor = chunk.end;
            }
            if (cursor !== block.text.length)
                throw new Error(`Incomplete coverage of ${pair.id} block ${blockIndex}`);
        }
        if (own.some((chunk) => chunk.blockIndex < 0 || chunk.blockIndex >= result.content.length))
            throw new Error(`Invalid block index for ${pair.id}`);
        if (own.length > 0 && own.every((chunk) => chunkActions.get(chunk.id)?.action === "drop")) {
            removedCalls.push(pair.id);
            droppedResults.add(result);
            const ids = droppedCalls.get(pair.call.message) ?? new Set<string>();
            ids.add(pair.id);
            droppedCalls.set(pair.call.message, ids);
            continue;
        }
        if (
            !own.some((chunk) => {
                const action = chunkActions.get(chunk.id)?.action;
                return action === "drop" || action === "placeholder";
            })
        )
            continue;
        const content: TextContent[] = result.content.map((block, blockIndex) => {
            if (block.type !== "text") throw new Error(`Non-text candidate ${pair.id}`);
            let text = "";
            let omittedStart: number | undefined;
            let omittedEnd = 0;
            let omittedAction: "drop" | "placeholder" | undefined;
            const flush = (): void => {
                if (omittedStart === undefined) return;
                const range = `UTF-16 range ${omittedStart}-${omittedEnd} (${omittedEnd - omittedStart} code units)`;
                text +=
                    omittedAction === "placeholder"
                        ? `\n[pi-compaction placeholder for ${range}: classifier context window exceeded; content not classified]\n`
                        : `\n[pi-compaction omitted ${range}]\n`;
                omittedStart = undefined;
                omittedAction = undefined;
            };
            for (const chunk of own.filter((chunk) => chunk.blockIndex === blockIndex)) {
                const action = chunkActions.get(chunk.id)?.action;
                if (action === "drop" || action === "placeholder") {
                    if (omittedAction && omittedAction !== action) flush();
                    omittedAction = action;
                    omittedStart ??= chunk.start;
                    omittedEnd = chunk.end;
                } else {
                    flush();
                    text += chunk.text;
                }
            }
            flush();
            return text === block.text ? block : { ...block, text };
        });
        rewritten.set(result, { ...result, content });
    }
    // Every decision must belong to a completely validated native result, including before whole-call deletion.
    if (chunks.some((chunk) => !pairById.has(chunk.toolCallId)))
        throw new Error("Chunk belongs to an unknown call");
    const transform = (messages: readonly AgentMessage[]): AgentMessage[] =>
        messages.flatMap((message) => {
            if (droppedResults.has(message)) return [];
            const callIds = droppedCalls.get(message);
            if (callIds) {
                if (message.role !== "assistant")
                    throw new Error("Call deletion targets a non-assistant message");
                const content = message.content.filter(
                    (block) => block.type !== "toolCall" || !callIds.has(block.id),
                );
                return content.length === 0 ? [] : [{ ...message, content }];
            }
            return [rewritten.get(message) ?? message];
        });
    return {
        messagesToSummarize: transform(history),
        turnPrefixMessages: transform(prefix),
        removedCalls,
    };
}

function countActions(report: ToolReviewReport, action: ChunkDecision["action"]): number {
    return report.chunkDecisions.filter((decision) => decision.action === action).length;
}

export interface ReviewSummary {
    readonly model: string;
    readonly checked: number;
    readonly removedCalls: number;
    readonly droppedFragments: number;
    readonly placeholders: number;
    readonly unreviewed: number;
    readonly charsBefore: number;
    readonly charsAfter: number;
}

/**
 * Collapses a report into disjoint notice counts. Drops inside fully removed
 * calls belong to the call entry, so surviving-call drops never recount them.
 */
export function summarizeReview(report: ToolReviewReport): ReviewSummary {
    const removed = new Set(report.removedCalls);
    const owners = new Map(report.chunks.map((chunk) => [chunk.id, chunk.toolCallId]));
    let droppedFragments = 0;
    let placeholders = 0;
    let unreviewed = 0;
    for (const decision of report.chunkDecisions) {
        if (decision.action === "placeholder") {
            placeholders++;
        } else if (decision.action === "drop") {
            const owner = owners.get(decision.chunkId);
            if (owner !== undefined && !removed.has(owner)) droppedFragments++;
        } else if ("reason" in decision) {
            unreviewed++;
        }
    }
    return {
        model: report.model,
        checked: report.candidateTools,
        removedCalls: report.removedCalls.length,
        droppedFragments,
        placeholders,
        unreviewed,
        charsBefore: report.charsBefore,
        charsAfter: report.charsAfter,
    };
}

function compactSize(chars: number): string {
    return chars >= 1000 ? `${Math.round(chars / 1000)}k` : `${chars}`;
}

function pluralize(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

export function formatReviewNotice(report: ToolReviewReport): string {
    const summary = summarizeReview(report);
    const head = `◇ Tool review · ${summary.model} · ${pluralize(summary.checked, "call", "calls")} checked`;
    if (summary.checked === 0) return `${head} · ${compactSize(summary.charsAfter)}`;
    const edits: string[] = [];
    if (summary.removedCalls > 0)
        edits.push(`${pluralize(summary.removedCalls, "call", "calls")} deleted`);
    if (summary.droppedFragments > 0)
        edits.push(
            `${pluralize(summary.droppedFragments, "result fragment", "result fragments")} deleted`,
        );
    if (summary.placeholders > 0)
        edits.push(
            `${pluralize(summary.placeholders, "result fragment", "result fragments")} replaced with a placeholder`,
        );
    if (summary.unreviewed > 0)
        edits.push(
            `${pluralize(summary.unreviewed, "result fragment", "result fragments")} kept without review`,
        );
    if (edits.length === 0) edits.push("no change");
    const percent =
        summary.charsBefore > 0
            ? Math.round(((summary.charsBefore - summary.charsAfter) / summary.charsBefore) * 100)
            : 0;
    const size =
        summary.charsBefore === summary.charsAfter || percent <= 0
            ? compactSize(summary.charsAfter)
            : `${compactSize(summary.charsBefore)}→${compactSize(summary.charsAfter)} (-${percent}%)`;
    return `${head}: ${edits.join(" · ")} · ${size}`;
}

/** Persisted checkpoint record; field names are stored in session files. */
export function checkpointRecord(report: ToolReviewReport) {
    return {
        model: report.model,
        pricingKnown: report.pricingKnown,
        candidateTools: report.candidateTools,
        protectedTools: report.protectedTools.length,
        removedChunks: countActions(report, "drop"),
        placeholderChunks: countActions(report, "placeholder"),
        requestBudget: report.requestBudget,
        budgetFallbacks: report.budgetFallbacks,
        removedCalls: report.removedCalls.length,
        oversizedRequests: report.oversizedRequests,
        requests: report.requests,
        charsBefore: report.charsBefore,
        charsAfter: report.charsAfter,
        usage: report.usage,
    };
}
