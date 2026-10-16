import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { EditToolDetails } from "@earendil-works/pi-coding-agent";
import { sanitizeToolResultText } from "../../../utils/tool-result-sanitize.ts";
import { SHOW_MORE } from "../../../ui/style.ts";
import {
    getLineNumberWidth,
    parseDiff,
    type ParsedDiff,
    type ParsedDiffEntry,
} from "./diff-parse.ts";
import { buildInlineHighlightMap, buildSplitRows } from "./diff-inline.ts";
import { resolveDiffPalette, type DiffTheme } from "./diff-palette.ts";
import { createCodeLineHighlighter, resolveLanguageFromPath } from "./diff-highlight.ts";
import {
    canRenderSplitLayout,
    renderCompact,
    renderSplit,
    renderUnified,
    type DiffRenderContext,
} from "./diff-layout.ts";
import { renderSingleDiffRow } from "./diff-header.ts";
import {
    applyLineLimit,
    clampDiffLineToWidth,
    clampDiffLinesToWidth,
    resolveDiffDisplayLimit,
    resolveDiffProcessBudget,
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
} from "./diff-presentation.ts";
function safeGetDiff(details: unknown): string {
    if (!details || typeof details !== "object") {
        return "";
    }
    const typed = details as Partial<EditToolDetails>;
    return typeof typed.diff === "string" ? typed.diff : "";
}
function omitTerminalOmissions(entries: ParsedDiffEntry[]): ParsedDiffEntry[] {
    let lastLineIndex = -1;
    for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index]?.kind === "line") {
            lastLineIndex = index;
            break;
        }
    }
    return entries.filter((entry, index) => entry.kind !== "omission" || index < lastLineIndex);
}
export function countEditDiffStats(details: unknown):
    | {
          added: number;
          removed: number;
      }
    | undefined {
    const diffText = sanitizeToolResultText(safeGetDiff(details));
    if (!diffText.trim()) return undefined;
    try {
        const parsed = parseDiff(diffText);
        return { added: parsed.stats.added, removed: parsed.stats.removed };
    } catch {
        return undefined;
    }
}
function renderEditCollapsedSummaryLine(
    stats: ParsedDiff["stats"],
    width: number,
    theme: DiffTheme,
    hovered: boolean,
): string {
    const counts = `+${stats.added} -${stats.removed}`;
    const hint = SHOW_MORE;
    const candidates = [
        `diff ${counts} · ${hint}`,
        `${counts} · ${hint}`,
        `diff ${counts}`,
        counts,
        "diff",
        "…",
    ];
    const text = candidates.find((candidate) => visibleWidth(candidate) <= width) ?? "";
    return clampDiffLineToWidth(styleDiffSummaryLine(text, stats, hint, theme, hovered), width);
}
export function renderEditDiffResult(
    details: unknown,
    options: DiffRenderOptions,
    config: DisplayConfigInput,
    theme: DiffTheme,
    fallbackText: string,
): Component {
    const diffText = sanitizeToolResultText(safeGetDiff(details));
    const safeFallbackText = sanitizeToolResultText(fallbackText);
    if (!diffText.trim()) {
        if (!safeFallbackText.trim()) {
            return new Text(theme.fg("muted", "edit completed (no diff payload)"), 0, 0);
        }
        return new Text(theme.fg("toolOutput", safeFallbackText), 0, 0);
    }
    let parsed: ParsedDiff;
    try {
        parsed = parseDiff(diffText);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Text(theme.fg("warning", `unable to render diff: ${message}`), 0, 0);
    }
    const renderEntries = omitTerminalOmissions(parsed.entries);
    if (renderEntries.length === 0) {
        return new Text(theme.fg("muted", "no diff data"), 0, 0);
    }
    const palette = resolveDiffPalette(theme);
    const containerBgAnsi = undefined;
    const language = resolveLanguageFromPath(options.filePath);
    const cache = createDiffRenderCache();
    function buildDetailedData(processBudget: number) {
        const showHashlineAnchors =
            options.expanded === true &&
            renderEntries.some((entry) => entry.kind === "line" && !!entry.hashlineAnchorContent);
        return {
            splitRows: buildSplitRows(renderEntries),
            showHashlineAnchors,
            lineNumberWidth: getLineNumberWidth(renderEntries, showHashlineAnchors),
            highlightLine: createCodeLineHighlighter(
                language,
                theme,
                takeEntriesForLineBudget(renderEntries, processBudget).entries,
                () => {
                    cache.invalidate();
                    options.invalidate?.();
                },
            ),
        };
    }
    let detailedData: ReturnType<typeof buildDetailedData> | undefined;
    return {
        [RICH_DIFF_COMPONENT]: true,
        isCollapsedHintLine(plainLine: string): boolean {
            const hint = cache.getHintLine();
            return hint !== undefined && normalizeCollapsedHintLine(plainLine) === hint;
        },
        bodyShowsStats(): boolean {
            return true;
        },
        render(width: number): string[] {
            const live = resolveLiveDisplayConfig(config);
            const wordWrap = live.diffWordWrap;
            const indicatorMode = resolveDiffIndicatorMode(live);
            const configKey = displayConfigCacheKey(live);
            const safeWidth = normalizeDiffRenderWidth(width);
            const mode = resolveDiffPresentationMode(
                live,
                safeWidth,
                canRenderSplitLayout(safeWidth),
            );
            const hovered = options.isHovered?.() ?? false;
            const cached = cache.get(safeWidth, options.expanded, mode, configKey, hovered);
            if (cached) {
                return cached;
            }
            if (!options.expanded && live.editDiffCollapsedLines === 0) {
                // Without its own disclosure the diff is embedded in a card whose heading already summarizes it.
                if (options.showDisclosure === false)
                    return cache.set(safeWidth, options.expanded, mode, configKey, hovered, []);
                const summary = renderEditCollapsedSummaryLine(
                    parsed.stats,
                    safeWidth,
                    theme,
                    hovered,
                );
                return cache.set(
                    safeWidth,
                    options.expanded,
                    mode,
                    configKey,
                    hovered,
                    [summary],
                    normalizeCollapsedHintLine(summary),
                );
            }
            if (mode === "summary") {
                return cache.set(
                    safeWidth,
                    options.expanded,
                    mode,
                    configKey,
                    hovered,
                    clampDiffLinesToWidth(
                        renderSingleDiffRow(
                            buildDiffSummaryText(parsed.stats, safeWidth),
                            "toolOutput",
                            safeWidth,
                            theme,
                        ),
                        safeWidth,
                    ),
                );
            }
            const displayLimit = resolveDiffDisplayLimit(
                options.expanded,
                live.editDiffCollapsedLines,
                live.expandedPreviewMaxLines,
            );
            const processBudget = resolveDiffProcessBudget(displayLimit, wordWrap);
            const { splitRows, showHashlineAnchors, lineNumberWidth, highlightLine } =
                (detailedData ??= buildDetailedData(processBudget));
            const entryBudget = takeEntriesForLineBudget(renderEntries, processBudget);
            const splitBudget = takeSplitRowsForBudget(splitRows, processBudget);
            const inlineHighlights = buildInlineHighlightMap(splitBudget.rows);
            const renderCtx: DiffRenderContext = {
                width: safeWidth,
                theme,
                inlineHighlights,
                palette,
                highlightLine,
                containerBgAnsi,
                wordWrap,
                indicatorMode,
                showHashlineAnchors,
            };
            const bodyRows =
                mode === "split"
                    ? renderSplit(splitBudget.rows, renderCtx, lineNumberWidth)
                    : mode === "compact"
                      ? renderCompact(entryBudget.entries, renderCtx)
                      : renderUnified(entryBudget.entries, renderCtx, lineNumberWidth);
            const unprocessedLogicalRows =
                mode === "split"
                    ? Math.max(0, splitBudget.totalRows - splitBudget.processedRows)
                    : Math.max(0, entryBudget.totalLineEntries - entryBudget.processedLineEntries);
            const bodyWithLimit = applyLineLimit(
                bodyRows,
                safeWidth,
                options.expanded,
                live.editDiffCollapsedLines,
                parsed.stats.hunks,
                theme,
                unprocessedLogicalRows,
                hovered,
                live.expandedPreviewMaxLines,
                options.showDisclosure !== false,
            );
            // Change counts live on the card heading; the body is only the diff itself.
            const clampedLines = clampDiffLinesToWidth(bodyWithLimit.lines, safeWidth);
            return cache.set(
                safeWidth,
                options.expanded,
                mode,
                configKey,
                hovered,
                clampedLines,
                normalizeCollapsedHintLine(bodyWithLimit.hintLine),
            );
        },
        invalidate: cache.invalidate,
    } as Component;
}
