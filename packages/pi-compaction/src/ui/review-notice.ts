import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CompactionRunListener, CompactionRunUpdate } from "../compaction-controller.ts";
import type { ProtectedTool } from "../tool-review/candidates.ts";
import { summarizeReview } from "../tool-review/review.ts";

export const REVIEW_NOTICE_WIDGET = "lune-compaction-review";

/** Below this width the notice collapses to one row; at or above it, three rows are reserved. */
export const COMPACT_NOTICE_WIDTH = 48;

export type ReviewNoticeState =
    | "preparing"
    | "reviewing"
    | "summarizing"
    | "complete"
    | "failed"
    | "cancelled";

export interface ReviewNoticeView {
    readonly state: ReviewNoticeState;
    readonly model?: string;
    /** Known once the review has indexed the summarized history. */
    readonly calls?: {
        readonly total: number;
        readonly reviewed: number;
        readonly protected: number;
    };
    /** Each protected call counts once, under its first matching label. */
    readonly protectedReasons: readonly { readonly label: string; readonly count: number }[];
    /** Known once every classifier decision is applied. */
    readonly outcome?: {
        readonly removedCalls: number;
        readonly fragments: number;
        readonly placeholders: number;
        readonly unreviewed: number;
        readonly chars: {
            readonly before: number;
            readonly after: number;
            /** Saved by the per-result truncation cap. */
            readonly truncation: number;
            /** Saved by classifier decisions on the capped input. */
            readonly classifier: number;
        };
    };
    readonly batches?: { readonly completed: number; readonly total: number };
    readonly error?: string;
}

const STAGE_STATES = {
    preparing: "preparing",
    chunks: "reviewing",
    summarizing: "summarizing",
    "awaiting-commit": "summarizing",
    complete: "complete",
    failed: "failed",
    cancelled: "cancelled",
} as const satisfies Record<CompactionRunUpdate["stage"], ReviewNoticeState>;

const REASON_LABELS: readonly (readonly [label: string, reasons: readonly string[]])[] = [
    ["recent", ["retained-region"]],
    ["error", ["error-result"]],
    ["not permitted", ["tool-not-deletable"]],
    ["nested", ["incomplete-nested-calls", "nested-tool-not-deletable", "nested-call-failed"]],
    ["media", ["non-text-result"]],
];

function protectedReasons(tools: readonly ProtectedTool[]): ReviewNoticeView["protectedReasons"] {
    const counts = new Map<string, number>();
    for (const tool of tools) {
        const label =
            REASON_LABELS.find(([, reasons]) =>
                reasons.some((reason) => tool.reasons.includes(reason)),
            )?.[0] ?? "other";
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    // Array.prototype.sort is stable, so equal counts keep the label priority order.
    return [...REASON_LABELS.map(([label]) => label), "other"]
        .flatMap((label) => {
            const count = counts.get(label);
            return count ? [{ label, count }] : [];
        })
        .sort((left, right) => right.count - left.count);
}

export function reviewNoticeView(update: CompactionRunUpdate): ReviewNoticeView {
    const state = STAGE_STATES[update.stage];
    const report = update.jev;
    const summary = report && summarizeReview(report);
    return {
        state,
        ...(update.reviewModel === undefined ? {} : { model: update.reviewModel }),
        ...(update.candidateTools === undefined || update.protectedTools === undefined
            ? {}
            : {
                  calls: {
                      total: update.candidateTools + update.protectedTools,
                      reviewed: update.candidateTools,
                      protected: update.protectedTools,
                  },
              }),
        protectedReasons: report ? protectedReasons(report.protectedTools) : [],
        ...(report && summary
            ? {
                  outcome: {
                      removedCalls: summary.removedCalls,
                      fragments: summary.droppedFragments,
                      placeholders: summary.placeholders,
                      unreviewed: summary.unreviewed,
                      chars: {
                          before: report.charsBefore,
                          after: report.charsAfter,
                          truncation: report.charsBefore - report.charsAfterTruncation,
                          classifier: report.charsAfterTruncation - report.charsAfter,
                      },
                  },
              }
            : {}),
        ...(state === "reviewing"
            ? { batches: { completed: update.completedBatches, total: update.totalBatches } }
            : {}),
        ...(update.error === undefined ? {} : { error: update.error.replace(/\s+/g, " ").trim() }),
    };
}

/** A part of a row; lower ranks give way first, and an attached part follows its anchor with a space. */
interface Part {
    readonly text: string;
    readonly rank: number;
    readonly attached?: boolean;
}

interface Row {
    /** Complete variants from richest to shortest, tried after every part has given way. */
    readonly leads: readonly string[];
    readonly parts: readonly Part[];
}

function compose(lead: string, parts: readonly Part[], separator: string): string {
    return parts.reduce(
        (line, part, index) =>
            line + (part.attached ? " " : index === 0 && !lead.trim() ? "" : separator) + part.text,
        lead,
    );
}

/** The richest complete row that fits, never a cut one; undefined when an indented row has nothing left. */
function fitRow(row: Row, width: number, separator: string): string | undefined {
    const kept = [...row.parts];
    for (;;) {
        const line = compose(row.leads[0]!, kept, separator);
        if (visibleWidth(line) <= width)
            return kept.length > 0 || row.leads[0]!.trim() ? line : undefined;
        if (kept.length === 0) break;
        let lowest = 0;
        for (let index = 1; index < kept.length; index++)
            if (kept[index]!.rank <= kept[lowest]!.rank) lowest = index;
        let end = lowest + 1;
        while (kept[end]?.attached) end++;
        kept.splice(lowest, end - lowest);
    }
    return row.leads.slice(1).find((lead) => lead.trim() && visibleWidth(lead) <= width);
}

function size(chars: number): string {
    if (chars >= 999_500) return `${(chars / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    return chars >= 1000 ? `${Math.round(chars / 1000)}k` : `${chars}`;
}

function saved(chars: number): string {
    return chars > 0 ? `−${size(chars)}` : chars < 0 ? `+${size(-chars)}` : "±0";
}

function count(value: number, singular: string, plural = `${singular}s`): string {
    return `${value} ${value === 1 ? singular : plural}`;
}

function header(view: ReviewNoticeView, theme: Theme): Row {
    const reviewed = view.outcome !== undefined;
    if (view.state === "failed" || view.state === "cancelled") {
        const color = view.state === "failed" ? "error" : "warning";
        const glyph = view.state === "failed" ? "✖" : "⚠";
        const title =
            view.state === "failed"
                ? reviewed
                    ? "Compaction failed"
                    : "Jev failed"
                : reviewed
                  ? "Compaction cancelled"
                  : "Jev review cancelled";
        const consequence =
            view.state === "failed" && !reviewed ? "compaction cancelled" : "no checkpoint written";
        return {
            leads: [
                theme.fg(color, `${glyph} ${title}`),
                theme.fg(color, `${glyph} ${view.state === "failed" ? "Failed" : "Cancelled"}`),
                theme.fg(color, glyph),
            ],
            parts: [
                ...(view.error ? [{ text: theme.fg(color, view.error), rank: 1 }] : []),
                { text: theme.fg("muted", consequence), rank: 2 },
            ],
        };
    }
    const glyph = theme.fg("accent", view.state === "complete" ? "◇" : "◐");
    const stage =
        view.state === "preparing" || view.state === "summarizing"
            ? [{ text: theme.fg("muted", view.state), rank: 7 }]
            : [];
    return {
        leads: [`${glyph} Jev review`, `${glyph} Jev`, glyph],
        parts: [
            ...stage,
            ...(view.model ? [{ text: theme.fg("muted", view.model), rank: 0 }] : []),
        ],
    };
}

function callParts(view: ReviewNoticeView, theme: Theme): Part[] {
    const muted = (text: string): string => theme.fg("muted", text);
    const parts: Part[] = [];
    if (view.calls) {
        parts.push(
            { text: muted(count(view.calls.total, "call")), rank: 2 },
            {
                text: muted(
                    `${view.calls.reviewed} ${view.state === "reviewing" ? "in review" : "reviewed"}`,
                ),
                rank: 4,
            },
            { text: muted(`${view.calls.protected} protected`), rank: 3 },
        );
        if (view.protectedReasons.length > 0)
            parts.push({
                text: muted(
                    `(${view.protectedReasons.map(({ label, count }) => `${count} ${label}`).join(" · ")})`,
                ),
                rank: 1,
                attached: true,
            });
    }
    if (view.batches)
        parts.push({
            text: muted(`${view.batches.completed}/${view.batches.total} requests`),
            rank: 6,
        });
    return parts;
}

function outcomeParts(view: ReviewNoticeView, theme: Theme): Part[] {
    const outcome = view.outcome;
    if (!outcome) return [];
    const edits: Part[] = [];
    if (outcome.removedCalls > 0)
        edits.push({ text: `−${count(outcome.removedCalls, "call")}`, rank: 9 });
    if (outcome.fragments > 0)
        edits.push({ text: `−${count(outcome.fragments, "fragment")}`, rank: 8 });
    if (outcome.placeholders > 0)
        edits.push({ text: count(outcome.placeholders, "placeholder"), rank: 5 });
    if (outcome.unreviewed > 0)
        edits.push({ text: `${outcome.unreviewed} kept unreviewed`, rank: 5 });
    if (edits.length === 0) edits.push({ text: "nothing removed", rank: 9 });
    const muted = (text: string): string => theme.fg("muted", text);
    return [
        ...edits,
        { text: `${size(outcome.chars.before)} → ${size(outcome.chars.after)}`, rank: 6 },
        { text: muted(`truncation ${saved(outcome.chars.truncation)}`), rank: 3 },
        { text: muted(`classifier ${saved(outcome.chars.classifier)}`), rank: 4 },
    ];
}

/**
 * Always the same rows for a given width: one below COMPACT_NOTICE_WIDTH, three at or
 * above it. Rows whose content is not known yet stay blank, so the editor never moves
 * while the review reports progress.
 */
export function reviewNoticeLines(view: ReviewNoticeView, width: number, theme: Theme): string[] {
    if (width < 1) return [];
    const separator = theme.fg("muted", " · ");
    const head = header(view, theme);
    const calls = callParts(view, theme);
    const outcome = outcomeParts(view, theme);
    // Without a checkpoint, review counts would describe edits that never reached the session.
    const settled = view.state === "failed" || view.state === "cancelled";
    const compact = width < COMPACT_NOTICE_WIDTH;
    const rows: Row[] = settled
        ? [head]
        : compact
          ? [{ leads: head.leads, parts: [...head.parts, ...outcome, ...calls] }]
          : [head, { leads: ["  "], parts: calls }, { leads: ["  "], parts: outcome }];
    const lines = rows.map((row) => fitRow(row, width, separator) ?? "");
    while (lines.length < (compact ? 1 : 3)) lines.push("");
    return lines;
}

class ReviewNoticeComponent implements Component {
    private view: ReviewNoticeView;
    private broken = false;
    private readonly theme: () => Theme;
    private readonly onRenderError: (error: unknown) => void;
    private readonly onDispose: () => void;

    constructor(
        view: ReviewNoticeView,
        theme: () => Theme,
        onRenderError: (error: unknown) => void,
        onDispose: () => void,
    ) {
        this.view = view;
        this.theme = theme;
        this.onRenderError = onRenderError;
        this.onDispose = onDispose;
    }

    setView(view: ReviewNoticeView): void {
        this.view = view;
    }

    render(width: number): string[] {
        if (this.broken) return [];
        try {
            return reviewNoticeLines(this.view, width, this.theme());
        } catch (error) {
            this.broken = true;
            this.onRenderError(error);
            return [];
        }
    }

    invalidate(): void {}

    dispose(): void {
        this.onDispose();
    }
}

/** RPC has no width to measure against; 80 keeps all three rows inside a typical client pane. */
const RPC_NOTICE_WIDTH = 80;

/** RPC renders the string form of a widget, so nothing resolves a theme. */
const unstyledTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

/** Pins the latest review above the editor, outside the transcript that Pi rebuilds after a compaction. */
export function createReviewNotice(): CompactionRunListener {
    let mounted: { component: ReviewNoticeComponent; requestRender: () => void } | undefined;
    let shown = false;
    return (update, ctx) => {
        if (!ctx.hasUI) return;
        // RPC ignores widget factories but renders string lines, so send the same notice as text.
        if (ctx.mode === "rpc") {
            ctx.ui.setWidget(
                REVIEW_NOTICE_WIDGET,
                update
                    ? reviewNoticeLines(reviewNoticeView(update), RPC_NOTICE_WIDTH, unstyledTheme)
                    : undefined,
                { placement: "aboveEditor" },
            );
            return;
        }
        if (!update) {
            if (shown) ctx.ui.setWidget(REVIEW_NOTICE_WIDGET, undefined);
            shown = false;
            mounted = undefined;
            return;
        }
        const view = reviewNoticeView(update);
        shown = true;
        if (mounted) {
            mounted.component.setView(view);
            mounted.requestRender();
            return;
        }
        ctx.ui.setWidget(
            REVIEW_NOTICE_WIDGET,
            (tui, theme) => {
                const component = new ReviewNoticeComponent(
                    view,
                    // Pi passes its live theme, so colors follow a theme switch at the next render.
                    () => theme,
                    (error) => {
                        console.error("[pi-compaction] Review notice failed to render", error);
                        // Pi is mid-render; replacing a widget now would edit the tree it is drawing.
                        queueMicrotask(() => {
                            if (mounted?.component !== component) return;
                            try {
                                ctx.ui.setWidget(REVIEW_NOTICE_WIDGET, undefined);
                            } catch (clearError) {
                                console.error(
                                    "[pi-compaction] Review notice cleanup failed",
                                    clearError,
                                );
                            }
                        });
                    },
                    () => {
                        if (mounted?.component === component) mounted = undefined;
                    },
                );
                mounted = { component, requestRender: () => tui.requestRender() };
                return component;
            },
            { placement: "aboveEditor" },
        );
    };
}
