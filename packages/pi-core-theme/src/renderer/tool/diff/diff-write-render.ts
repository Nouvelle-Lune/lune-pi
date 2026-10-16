import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolDisplayConfig } from "../../../config/config.ts";
import { sanitizeToolResultText } from "../../../utils/tool-result-sanitize.ts";
import { SHOW_MORE } from "../../../ui/style.ts";
import { splitWriteContentLines } from "./diff-text.ts";
import {
    collectDiffStats,
    getLineNumberWidth,
    type DiffLineEntry,
    type DiffStats,
    type ParsedDiffEntry,
} from "./diff-parse.ts";
import {
    buildInlineHighlightMap,
    buildSplitRows,
    type DiffSpan,
    type SplitDiffRow,
} from "./diff-inline.ts";
import { resolveDiffPalette, type DiffTheme } from "./diff-palette.ts";
import {
    createCodeLineHighlighter,
    resolveLanguageFromPath,
    type CodeLineHighlighter,
} from "./diff-highlight.ts";
import {
    canRenderSplitLayout,
    renderCompact,
    renderSplit,
    renderUnified,
    type DiffRenderContext,
    type RenderedRow,
} from "./diff-layout.ts";
import { renderSingleDiffRow, renderWriteHeader } from "./diff-header.ts";
import {
    applyLineLimit,
    clampDiffLineToWidth,
    clampDiffLinesToWidth,
    resolveDiffDisplayLimit,
    resolveDiffProcessBudget,
    resolveWriteCollapsedLimit,
    takeEntriesForLineBudget,
    takeSplitRowsForBudget,
} from "./diff-limits.ts";
import {
    RICH_DIFF_COMPONENT,
    createDiffRenderCache,
    displayConfigCacheKey,
    resolveDiffIndicatorMode,
    resolveLiveDisplayConfig,
    normalizeCollapsedHintLine,
    type DiffRenderOptions,
    type DisplayConfigInput,
} from "./diff-component.ts";
import {
    buildDiffSummaryText,
    normalizeDiffRenderWidth,
    resolveDiffPresentationMode,
    styleDiffSummaryLine,
    type DiffPresentationMode,
} from "./diff-presentation.ts";
type WriteDiffOperationKind = "context" | "remove" | "add";
interface WriteDiffOperation {
    kind: WriteDiffOperationKind;
    content: string;
}
function commonRange(oldLines: string[], newLines: string[]) {
    let start = 0;
    while (
        start < oldLines.length &&
        start < newLines.length &&
        oldLines[start] === newLines[start]
    )
        start++;
    let end = 0;
    while (
        end < oldLines.length - start &&
        end < newLines.length - start &&
        oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]
    )
        end++;
    return { start, end };
}
function buildWriteDiffOperations(oldLines: string[], newLines: string[]): WriteDiffOperation[] {
    const { start, end } = commonRange(oldLines, newLines);
    const old = oldLines.slice(start, oldLines.length - end);
    const next = newLines.slice(start, newLines.length - end);
    // A block replacement is a valid diff when a minimal LCS would monopolize the terminal thread.
    if (old.length * next.length > MAX_WRITE_DIFF_MATRIX_CELLS) {
        return [
            ...oldLines
                .slice(0, start)
                .map((content): WriteDiffOperation => ({ kind: "context", content })),
            ...old.map((content): WriteDiffOperation => ({ kind: "remove", content })),
            ...next.map((content): WriteDiffOperation => ({ kind: "add", content })),
            ...oldLines
                .slice(oldLines.length - end)
                .map((content): WriteDiffOperation => ({ kind: "context", content })),
        ];
    }
    const table = Array.from({ length: old.length + 1 }, () => new Uint32Array(next.length + 1));
    for (let i = 1; i <= old.length; i++)
        for (let j = 1; j <= next.length; j++)
            table[i]![j] =
                old[i - 1] === next[j - 1]
                    ? table[i - 1]![j - 1]! + 1
                    : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    const changes: WriteDiffOperation[] = [];
    let i = old.length;
    let j = next.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && old[i - 1] === next[j - 1]) {
            changes.push({ kind: "context", content: old[--i]! });
            j--;
        } else if (j > 0 && (i === 0 || table[i]![j - 1]! >= table[i - 1]![j]!))
            changes.push({ kind: "add", content: next[--j]! });
        else changes.push({ kind: "remove", content: old[--i]! });
    }
    return [
        ...oldLines
            .slice(0, start)
            .map((content): WriteDiffOperation => ({ kind: "context", content })),
        ...changes.reverse(),
        ...oldLines
            .slice(oldLines.length - end)
            .map((content): WriteDiffOperation => ({ kind: "context", content })),
    ];
}
/** The full-output browser reuses the same bounded diff algorithm without highlighting or preview limits. */
export function writeDiffText(content: string, previousContent: string | undefined): string {
    const before =
        typeof previousContent === "string"
            ? splitWriteContentLines(sanitizeToolResultText(previousContent))
            : [];
    const after = splitWriteContentLines(sanitizeToolResultText(content));
    return buildWriteDiffOperations(before, after)
        .map(
            (operation) =>
                `${operation.kind === "add" ? "+" : operation.kind === "remove" ? "-" : " "}${operation.content}`,
        )
        .join("\n");
}

function buildWriteEntries(lines: string[]): ParsedDiffEntry[] {
    return lines.map((line, index) => ({
        kind: "line",
        lineKind: "add",
        oldLineNumber: null,
        newLineNumber: index + 1,
        fallbackLineNumber: `${index + 1}`,
        content: line,
        raw: `+${line}`,
        hunkIndex: 1,
    }));
}
function buildWriteOverwriteEntries(oldLines: string[], newLines: string[]): ParsedDiffEntry[] {
    const operations = buildWriteDiffOperations(oldLines, newLines);
    const entries: ParsedDiffEntry[] = [];
    let oldLineNumber = 1;
    let newLineNumber = 1;
    for (const operation of operations) {
        if (operation.kind === "context") {
            entries.push({
                kind: "line",
                lineKind: "context",
                oldLineNumber,
                newLineNumber,
                fallbackLineNumber: `${newLineNumber}`,
                content: operation.content,
                raw: ` ${operation.content}`,
                hunkIndex: 1,
            });
            oldLineNumber++;
            newLineNumber++;
            continue;
        }
        if (operation.kind === "remove") {
            entries.push({
                kind: "line",
                lineKind: "remove",
                oldLineNumber,
                newLineNumber: null,
                fallbackLineNumber: `${oldLineNumber}`,
                content: operation.content,
                raw: `-${operation.content}`,
                hunkIndex: 1,
            });
            oldLineNumber++;
            continue;
        }
        entries.push({
            kind: "line",
            lineKind: "add",
            oldLineNumber: null,
            newLineNumber,
            fallbackLineNumber: `${newLineNumber}`,
            content: operation.content,
            raw: `+${operation.content}`,
            hunkIndex: 1,
        });
        newLineNumber++;
    }
    const folded: ParsedDiffEntry[] = [];
    for (let index = 0; index < entries.length; ) {
        const entry = entries[index]!;
        if (entry.kind !== "line" || entry.lineKind !== "context") {
            folded.push(entry);
            index++;
            continue;
        }
        let end = index;
        while (
            end < entries.length &&
            entries[end]!.kind === "line" &&
            (entries[end] as DiffLineEntry).lineKind === "context"
        )
            end++;
        const leading = index > 0 ? Math.min(3, end - index) : 0;
        const trailing = end < entries.length ? Math.min(3, end - index - leading) : 0;
        folded.push(...entries.slice(index, index + leading));
        const hidden = end - index - leading - trailing;
        if (hidden)
            folded.push({ kind: "omission", raw: `… ${hidden} unchanged lines`, hunkIndex: 1 });
        folded.push(...entries.slice(end - trailing, end));
        index = end;
    }
    return folded;
}
interface WriteDiffData {
    entries: ParsedDiffEntry[];
    splitRows: SplitDiffRow[];
    inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>;
    lineNumberWidth: number;
    stats: DiffStats;
    hunkCount: number;
}
const MAX_WRITE_DIFF_MATRIX_CELLS = 200000;
function buildApproximateWriteStats(
    lineCount: number,
    previousLineCount: number,
    hasComparablePrevious: boolean,
): DiffStats {
    const removed = hasComparablePrevious ? previousLineCount : 0;
    const added = lineCount;
    const hasContent = lineCount > 0 || removed > 0;
    return {
        added,
        removed,
        context: 0,
        hunks: hasContent ? 1 : 0,
        files: 1,
        lines: added + removed,
    };
}
function buildWriteDiffData(entries: ParsedDiffEntry[], processBudget: number): WriteDiffData {
    const splitRows = buildSplitRows(entries);
    const inlineHighlights = buildInlineHighlightMap(
        takeSplitRowsForBudget(splitRows, processBudget).rows,
    );
    const lineNumberWidth = getLineNumberWidth(entries);
    const hunkCount = entries.length > 0 ? 1 : 0;
    const stats = collectDiffStats(entries, hunkCount, 1);
    return {
        entries,
        splitRows,
        inlineHighlights,
        lineNumberWidth,
        stats,
        hunkCount,
    };
}
function renderWriteCollapsedHintLine(
    wasOverwrite: boolean,
    width: number,
    theme: DiffTheme,
    hovered: boolean,
    headerLabel?: string,
    stats?: {
        added: number;
        removed: number;
    },
    showDisclosure = true,
): string[] {
    const safeWidth = normalizeDiffRenderWidth(width);
    if (safeWidth === 0) {
        return [""];
    }
    // Without its own disclosure the diff is embedded in a card whose heading already summarizes it.
    if (!showDisclosure) return [];
    const actionLabel = headerLabel?.trim() || (wasOverwrite ? "overwritten" : "created");
    const clickLabel = showDisclosure ? SHOW_MORE : "";
    const counts = stats ? `+${stats.added} -${stats.removed}` : "";
    const summary = stats ? `diff ${counts} · ${actionLabel}` : actionLabel;
    const candidates = [
        ...(showDisclosure ? [`${summary} · ${clickLabel}`] : []),
        summary,
        ...(stats ? [`diff ${counts}`, counts] : []),
        actionLabel,
        "…",
    ];
    let text = candidates[candidates.length - 1] ?? "…";
    for (const candidate of candidates) {
        if (visibleWidth(candidate) <= safeWidth) {
            text = candidate;
            break;
        }
    }
    if (visibleWidth(text) > safeWidth) {
        text = truncateToWidth(text, safeWidth, "");
    }
    const styled = styleDiffSummaryLine(text, stats, clickLabel, theme, hovered);
    return [clampDiffLineToWidth(styled, safeWidth)];
}
export function writeStatsInCollapsedBody(
    expanded: boolean,
    display: Pick<ToolDisplayConfig, "writeDiffCollapsedLines">,
): boolean {
    return !expanded && resolveWriteCollapsedLimit(display) === 0;
}
export function countWriteDiffStats(
    content: string | undefined,
    previousContent: string | undefined,
    fileExistedBeforeWrite: boolean | undefined,
):
    | {
          added: number;
          removed: number;
      }
    | undefined {
    if (typeof content !== "string" || fileExistedBeforeWrite === undefined) return undefined;
    const lines = splitWriteContentLines(sanitizeToolResultText(content));
    if (fileExistedBeforeWrite === false) return { added: lines.length, removed: 0 };
    if (typeof previousContent !== "string") return undefined;
    const previousLines = splitWriteContentLines(sanitizeToolResultText(previousContent));
    if (previousLines.length === 0 || lines.length === 0) {
        return { added: lines.length, removed: previousLines.length };
    }
    let added = 0;
    let removed = 0;
    for (const operation of buildWriteDiffOperations(previousLines, lines)) {
        if (operation.kind === "add") added++;
        else if (operation.kind === "remove") removed++;
    }
    return { added, removed };
}
export function renderWriteDiffResult(
    content: string | undefined,
    options: DiffRenderOptions,
    config: DisplayConfigInput,
    theme: DiffTheme,
    fallbackText: string,
): Component {
    const safeFallbackText = sanitizeToolResultText(fallbackText);
    if (typeof content !== "string") {
        if (!safeFallbackText.trim()) {
            return new Text(theme.fg("muted", "write completed"), 0, 0);
        }
        return new Text(theme.fg("toolOutput", safeFallbackText), 0, 0);
    }
    const filePath = options.filePath?.trim() || "(unknown path)";
    const lines = splitWriteContentLines(sanitizeToolResultText(content));
    const previousLines =
        typeof options.previousContent === "string"
            ? splitWriteContentLines(sanitizeToolResultText(options.previousContent))
            : [];
    const hasComparablePrevious =
        options.fileExistedBeforeWrite === true && typeof options.previousContent === "string";
    const approximateStats = buildApproximateWriteStats(
        lines.length,
        previousLines.length,
        hasComparablePrevious,
    );
    const palette = resolveDiffPalette(theme);
    const containerBgAnsi = undefined;
    const language = resolveLanguageFromPath(filePath);
    const cache = createDiffRenderCache();
    let highlightLine: CodeLineHighlighter | undefined;
    let detailedData: WriteDiffData | undefined;
    function getDetailedData(processBudget: number): WriteDiffData {
        if (detailedData) {
            return detailedData;
        }
        const entries = hasComparablePrevious
            ? buildWriteOverwriteEntries(previousLines, lines)
            : buildWriteEntries(lines);
        detailedData = buildWriteDiffData(entries, processBudget);
        highlightLine = createCodeLineHighlighter(
            language,
            theme,
            takeEntriesForLineBudget(entries, processBudget).entries,
            () => {
                cache.invalidate();
                options.invalidate?.();
            },
        );
        return detailedData;
    }
    return {
        [RICH_DIFF_COMPONENT]: true,
        isCollapsedHintLine(plainLine: string): boolean {
            const hint = cache.getHintLine();
            return hint !== undefined && normalizeCollapsedHintLine(plainLine) === hint;
        },
        bodyShowsStats(): boolean {
            return writeStatsInCollapsedBody(options.expanded, resolveLiveDisplayConfig(config));
        },
        render(width: number): string[] {
            const live = resolveLiveDisplayConfig(config);
            const wordWrap = live.diffWordWrap;
            const indicatorMode = resolveDiffIndicatorMode(live);
            const configKey = displayConfigCacheKey(live);
            const safeWidth = normalizeDiffRenderWidth(width);
            const resolvedMode = resolveDiffPresentationMode(
                live,
                safeWidth,
                canRenderSplitLayout(safeWidth),
            );
            const mode: DiffPresentationMode = hasComparablePrevious
                ? resolvedMode
                : resolvedMode === "split"
                  ? "unified"
                  : resolvedMode;
            const hovered = options.isHovered?.() ?? false;
            const cached = cache.get(safeWidth, options.expanded, mode, configKey, hovered);
            if (cached) {
                return cached;
            }
            const writeCollapsedLimit = resolveWriteCollapsedLimit(live);
            const statsOnlyCollapsed = !options.expanded && writeCollapsedLimit === 0;
            if (statsOnlyCollapsed) {
                const hintLines = renderWriteCollapsedHintLine(
                    options.fileExistedBeforeWrite === true,
                    safeWidth,
                    theme,
                    hovered,
                    options.headerLabel,
                    countWriteDiffStats(
                        content,
                        options.previousContent,
                        options.fileExistedBeforeWrite,
                    ),
                    options.showDisclosure !== false,
                );
                return cache.set(
                    safeWidth,
                    options.expanded,
                    mode,
                    configKey,
                    hovered,
                    clampDiffLinesToWidth(hintLines, safeWidth),
                    normalizeCollapsedHintLine(hintLines[0]),
                );
            }
            const header = renderWriteHeader(
                options.fileExistedBeforeWrite === true,
                safeWidth,
                theme,
                options.headerLabel,
            );
            if (mode === "summary") {
                const summaryRows =
                    approximateStats.lines === 0
                        ? [header]
                        : [
                              header,
                              ...renderSingleDiffRow(
                                  buildDiffSummaryText(approximateStats, safeWidth),
                                  "toolOutput",
                                  safeWidth,
                                  theme,
                              ),
                          ];
                return cache.set(
                    safeWidth,
                    options.expanded,
                    mode,
                    configKey,
                    hovered,
                    clampDiffLinesToWidth(summaryRows, safeWidth),
                );
            }
            const displayLimit = resolveDiffDisplayLimit(
                options.expanded,
                writeCollapsedLimit,
                live.expandedPreviewMaxLines,
            );
            const processBudget = resolveDiffProcessBudget(displayLimit, wordWrap);
            const data = getDetailedData(processBudget);
            const entryBudget = takeEntriesForLineBudget(data.entries, processBudget);
            const splitBudget = takeSplitRowsForBudget(data.splitRows, processBudget);
            const inlineHighlights =
                splitBudget.processedRows < splitBudget.totalRows
                    ? buildInlineHighlightMap(splitBudget.rows)
                    : data.inlineHighlights;
            const renderCtx: DiffRenderContext = {
                width: safeWidth,
                theme,
                inlineHighlights,
                palette,
                highlightLine: highlightLine!,
                containerBgAnsi,
                wordWrap,
                indicatorMode,
                showHashlineAnchors: false,
            };
            const bodyRows: RenderedRow[] =
                entryBudget.entries.length === 0
                    ? [{ text: theme.fg("muted", "(empty file)"), hunkIndex: null }]
                    : mode === "split"
                      ? renderSplit(splitBudget.rows, renderCtx, data.lineNumberWidth)
                      : mode === "compact"
                        ? renderCompact(entryBudget.entries, renderCtx)
                        : renderUnified(entryBudget.entries, renderCtx, data.lineNumberWidth);
            const unprocessedLogicalRows =
                mode === "split"
                    ? Math.max(0, splitBudget.totalRows - splitBudget.processedRows)
                    : Math.max(0, entryBudget.totalLineEntries - entryBudget.processedLineEntries);
            const bodyWithLimit = applyLineLimit(
                bodyRows,
                safeWidth,
                options.expanded,
                writeCollapsedLimit,
                data.hunkCount,
                theme,
                unprocessedLogicalRows,
                hovered,
                live.expandedPreviewMaxLines,
                options.showDisclosure !== false,
            );
            const finalLines = clampDiffLinesToWidth([header, ...bodyWithLimit.lines], safeWidth);
            return cache.set(
                safeWidth,
                options.expanded,
                mode,
                configKey,
                hovered,
                finalLines,
                normalizeCollapsedHintLine(bodyWithLimit.hintLine),
            );
        },
        invalidate: cache.invalidate,
    } as Component;
}
