import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CompactionRunListener, CompactionRunUpdate } from "../compaction-controller.ts";
import type { ProtectedTool } from "../tool-review/candidates.ts";
import { summarizeReview, type ToolReviewReport } from "../tool-review/review.ts";

/** Widget key of the progress row and custom type of the saved result entry. */
export const REVIEW_NOTICE_WIDGET = "lune-compaction-review";
export const REVIEW_ENTRY_TYPE = "lune-compaction-review";

/** Below this width an expanded entry collapses to one row; at or above it, the result row joins the call row. */
export const COMPACT_NOTICE_WIDTH = 48;
/** At or above this width an expanded entry gives calls and results their own rows. */
export const FULL_NOTICE_WIDTH = 72;

const TITLE = "Tool review";

export type ProtectedCategory = "recent" | "error" | "not-permitted" | "nested" | "media" | "other";

const PROTECTED_CATEGORIES: readonly (readonly [ProtectedCategory, readonly string[]])[] = [
    ["recent", ["retained-region"]],
    ["error", ["error-result"]],
    ["not-permitted", ["tool-not-deletable"]],
    ["nested", ["incomplete-nested-calls", "nested-tool-not-deletable", "nested-call-failed"]],
    ["media", ["non-text-result"]],
];
const CATEGORY_ORDER: readonly ProtectedCategory[] = [
    ...PROTECTED_CATEGORIES.map(([category]) => category),
    "other",
];
const CATEGORY_LABELS: Record<ProtectedCategory, string> = {
    recent: "recent",
    error: "error",
    "not-permitted": "not permitted",
    nested: "nested",
    media: "media",
    other: "other",
};

/** Saved in a custom session entry; field names are stored in session files. */
export interface ToolReviewRecord {
    readonly version: 1;
    readonly model: string;
    readonly candidateTools: number;
    readonly protectedTools: number;
    /** Each protected call counts once, under its first matching category; largest first. */
    readonly protectedReasons: readonly {
        readonly category: ProtectedCategory;
        readonly count: number;
    }[];
    readonly removedCalls: number;
    /** Drops in calls that survive; drops inside removed calls belong to the call count. */
    readonly droppedFragments: number;
    readonly placeholders: number;
    readonly unreviewed: number;
    readonly charsBefore: number;
    /** After the per-result truncation cap, before any classifier decision. */
    readonly charsAfterTruncation: number;
    readonly charsAfter: number;
}

function protectedReasons(tools: readonly ProtectedTool[]): ToolReviewRecord["protectedReasons"] {
    const counts = new Map<ProtectedCategory, number>();
    for (const tool of tools) {
        const category =
            PROTECTED_CATEGORIES.find(([, reasons]) =>
                reasons.some((reason) => tool.reasons.includes(reason)),
            )?.[0] ?? "other";
        counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    // Array.prototype.sort is stable, so equal counts keep the category priority order.
    return CATEGORY_ORDER.flatMap((category) => {
        const count = counts.get(category);
        return count ? [{ category, count }] : [];
    }).sort((left, right) => right.count - left.count);
}

export function toolReviewRecord(report: Readonly<ToolReviewReport>): ToolReviewRecord {
    const summary = summarizeReview(report);
    return {
        version: 1,
        model: report.model,
        candidateTools: report.candidateTools,
        protectedTools: report.protectedTools.length,
        protectedReasons: protectedReasons(report.protectedTools),
        removedCalls: summary.removedCalls,
        droppedFragments: summary.droppedFragments,
        placeholders: summary.placeholders,
        unreviewed: summary.unreviewed,
        charsBefore: report.charsBefore,
        charsAfterTruncation: report.charsAfterTruncation,
        charsAfter: report.charsAfter,
    };
}

const COUNT_FIELDS = [
    "candidateTools",
    "protectedTools",
    "removedCalls",
    "droppedFragments",
    "placeholders",
    "unreviewed",
    "charsBefore",
    "charsAfterTruncation",
    "charsAfter",
] as const satisfies readonly (keyof ToolReviewRecord)[];

function isCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Session files can be edited by hand or written by another version; render only what was validated. */
export function parseToolReviewRecord(data: unknown): ToolReviewRecord {
    const record = data as Partial<Record<keyof ToolReviewRecord, unknown>> | null;
    if (
        typeof record !== "object" ||
        record === null ||
        record.version !== 1 ||
        typeof record.model !== "string" ||
        !COUNT_FIELDS.every((field) => isCount(record[field])) ||
        !Array.isArray(record.protectedReasons) ||
        !record.protectedReasons.every(
            (entry: unknown) =>
                typeof entry === "object" &&
                entry !== null &&
                CATEGORY_ORDER.includes((entry as { category: ProtectedCategory }).category) &&
                isCount((entry as { count: unknown }).count),
        )
    ) {
        throw new Error("Malformed tool review record");
    }
    return record as ToolReviewRecord;
}

export type ReviewProgressState = "preparing" | "reviewing" | "summarizing";

export interface ReviewProgressView {
    readonly state: ReviewProgressState;
    /** Known once the review has indexed the summarized history. */
    readonly calls?: { readonly total: number; readonly reviewed: number };
    readonly batches?: { readonly completed: number; readonly total: number };
    /** Known once every classifier decision is applied. */
    readonly result?: ToolReviewRecord;
}

const PROGRESS_STATES: Partial<Record<CompactionRunUpdate["stage"], ReviewProgressState>> = {
    preparing: "preparing",
    chunks: "reviewing",
    summarizing: "summarizing",
    "awaiting-commit": "summarizing",
};

/** Undefined once the run has settled: a running notice never outlives its compaction. */
export function reviewProgressView(update: CompactionRunUpdate): ReviewProgressView | undefined {
    const state = PROGRESS_STATES[update.stage];
    if (!state) return undefined;
    return {
        state,
        ...(update.candidateTools === undefined || update.protectedTools === undefined
            ? {}
            : {
                  calls: {
                      total: update.candidateTools + update.protectedTools,
                      reviewed: update.candidateTools,
                  },
              }),
        ...(state === "reviewing"
            ? { batches: { completed: update.completedBatches, total: update.totalBatches } }
            : {}),
        ...(update.jev ? { result: toolReviewRecord(update.jev) } : {}),
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

function leads(glyph: string, theme: Theme): readonly string[] {
    const marker = theme.fg("accent", glyph);
    return [`${marker} ${TITLE}`, marker];
}

/** `−3 calls · −13 fragments · 989k → 515k`, with the edits outranking the size. */
function resultParts(record: ToolReviewRecord): Part[] {
    const edits: Part[] = [];
    if (record.removedCalls > 0)
        edits.push({ text: `−${count(record.removedCalls, "call")}`, rank: 9 });
    if (record.droppedFragments > 0)
        edits.push({ text: `−${count(record.droppedFragments, "fragment")}`, rank: 8 });
    if (record.placeholders > 0)
        edits.push({ text: count(record.placeholders, "placeholder"), rank: 5 });
    if (record.unreviewed > 0)
        edits.push({ text: `${record.unreviewed} kept unreviewed`, rank: 5 });
    if (edits.length === 0) edits.push({ text: "nothing removed", rank: 9 });
    return [
        ...edits,
        { text: `${size(record.charsBefore)} → ${size(record.charsAfter)}`, rank: 6 },
    ];
}

/** One row that keeps the editor in place: preparing, request progress, then the edits while the summary runs. */
export function reviewProgressLine(view: ReviewProgressView, width: number, theme: Theme): string {
    if (width < 1) return "";
    const muted = (text: string): string => theme.fg("muted", text);
    const parts: Part[] = [];
    if (view.state !== "reviewing") parts.push({ text: muted(view.state), rank: 7 });
    if (view.state === "summarizing" && view.result) parts.push(...resultParts(view.result));
    else if (view.calls)
        parts.push(
            { text: muted(count(view.calls.total, "call")), rank: 2 },
            { text: muted(`${view.calls.reviewed} in review`), rank: 4 },
        );
    if (view.batches)
        parts.push({
            text: muted(`${view.batches.completed}/${view.batches.total} requests`),
            rank: 6,
        });
    return fitRow({ leads: leads("◐", theme), parts }, width, muted(" · ")) ?? "";
}

/**
 * The saved result under Pi's compaction summary. Collapsed it is one row of edits and size;
 * expanded it adds the classifier, the call counts and the truncation/classifier split.
 */
export function reviewEntryLines(
    record: ToolReviewRecord,
    width: number,
    theme: Theme,
    expanded: boolean,
): string[] {
    if (width < 1) return [];
    const muted = (text: string): string => theme.fg("muted", text);
    const separator = muted(" · ");
    const lead = leads("◇", theme);
    const result = resultParts(record);
    if (!expanded) return [fitRow({ leads: lead, parts: result }, width, separator) ?? ""];
    const calls: Part[] = [
        { text: muted(count(record.candidateTools + record.protectedTools, "call")), rank: 2 },
        { text: muted(`${record.candidateTools} reviewed`), rank: 4 },
        { text: muted(`${record.protectedTools} protected`), rank: 3 },
    ];
    if (record.protectedReasons.length > 0)
        calls.push({
            text: muted(
                `(${record.protectedReasons.map((reason) => `${reason.count} ${CATEGORY_LABELS[reason.category]}`).join(" · ")})`,
            ),
            rank: 1,
            attached: true,
        });
    const split: Part[] = [
        {
            text: muted(`truncation ${saved(record.charsBefore - record.charsAfterTruncation)}`),
            rank: 3,
        },
        {
            text: muted(`classifier ${saved(record.charsAfterTruncation - record.charsAfter)}`),
            rank: 4,
        },
    ];
    const head: Row = { leads: lead, parts: [{ text: muted(record.model), rank: 0 }] };
    const rows: Row[] =
        width < COMPACT_NOTICE_WIDTH
            ? [{ leads: lead, parts: [...result, ...split, ...calls] }]
            : width < FULL_NOTICE_WIDTH
              ? [head, { leads: ["  "], parts: [...result, ...split, ...calls] }]
              : [
                    head,
                    { leads: ["  "], parts: calls },
                    { leads: ["  "], parts: [...result, ...split] },
                ];
    return rows.flatMap((row) => fitRow(row, width, separator) ?? []);
}

/** Pi adds no padding around custom entries; one column lines the entry up with Pi's own notices. */
const ENTRY_PADDING = " ";

class ReviewEntryComponent implements Component {
    private readonly record: ToolReviewRecord;
    private readonly theme: Theme;
    private readonly expanded: boolean;

    constructor(record: ToolReviewRecord, theme: Theme, expanded: boolean) {
        this.record = record;
        this.theme = theme;
        this.expanded = expanded;
    }

    render(width: number): string[] {
        return reviewEntryLines(
            this.record,
            width - ENTRY_PADDING.length,
            this.theme,
            this.expanded,
        ).map((line) => ENTRY_PADDING + line);
    }

    invalidate(): void {}
}

class ReviewProgressComponent implements Component {
    private view: ReviewProgressView;
    private broken = false;
    private readonly theme: () => Theme;
    private readonly onRenderError: (error: unknown) => void;
    private readonly onDispose: () => void;

    constructor(
        view: ReviewProgressView,
        theme: () => Theme,
        onRenderError: (error: unknown) => void,
        onDispose: () => void,
    ) {
        this.view = view;
        this.theme = theme;
        this.onRenderError = onRenderError;
        this.onDispose = onDispose;
    }

    setView(view: ReviewProgressView): void {
        this.view = view;
    }

    render(width: number): string[] {
        if (this.broken) return [];
        try {
            return [reviewProgressLine(this.view, width, this.theme())];
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

/** RPC has no width to measure against; 80 keeps the row inside a typical client pane. */
const RPC_NOTICE_WIDTH = 80;

/** RPC renders the string form of a widget, so nothing resolves a theme. */
const unstyledTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

/**
 * Shows review progress above the editor only while a compaction runs, then saves the result
 * as a transcript entry under Pi's compaction summary, where it scrolls away with the conversation.
 */
export function createReviewNotice(pi: ExtensionAPI): CompactionRunListener {
    // Pi passes its live theme, so colors follow a theme switch when the entry is rebuilt.
    pi.registerEntryRenderer(REVIEW_ENTRY_TYPE, (entry, options, theme) => {
        return new ReviewEntryComponent(parseToolReviewRecord(entry.data), theme, options.expanded);
    });
    let mounted: { component: ReviewProgressComponent; requestRender: () => void } | undefined;
    let shown = false;
    const showProgress = (view: ReviewProgressView | undefined, ctx: ExtensionContext): void => {
        // RPC ignores widget factories but renders string lines, so send the same row as text.
        if (ctx.mode === "rpc") {
            ctx.ui.setWidget(
                REVIEW_NOTICE_WIDGET,
                view ? [reviewProgressLine(view, RPC_NOTICE_WIDTH, unstyledTheme)] : undefined,
                { placement: "aboveEditor" },
            );
            return;
        }
        if (!view) {
            if (shown) ctx.ui.setWidget(REVIEW_NOTICE_WIDGET, undefined);
            shown = false;
            mounted = undefined;
            return;
        }
        shown = true;
        if (mounted) {
            mounted.component.setView(view);
            mounted.requestRender();
            return;
        }
        ctx.ui.setWidget(
            REVIEW_NOTICE_WIDGET,
            (tui, theme) => {
                const component = new ReviewProgressComponent(
                    view,
                    () => theme,
                    (error) => {
                        console.error("[pi-compaction] Review progress failed to render", error);
                        // Pi is mid-render; replacing a widget now would edit the tree it is drawing.
                        queueMicrotask(() => {
                            if (mounted?.component !== component) return;
                            try {
                                ctx.ui.setWidget(REVIEW_NOTICE_WIDGET, undefined);
                            } catch (clearError) {
                                console.error(
                                    "[pi-compaction] Review progress cleanup failed",
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
    return (update, ctx) => {
        if (!ctx.hasUI) return;
        showProgress(update && reviewProgressView(update), ctx);
        if (update?.stage === "complete" && update.jev) {
            // Appending inside session_compact puts the entry right after the checkpoint, before
            // any queued prompt. Pi's rebuild then draws it after the retained messages, directly
            // above the live summary; a deferred append could land after a queued prompt instead.
            pi.appendEntry(REVIEW_ENTRY_TYPE, toolReviewRecord(update.jev));
        }
    };
}
