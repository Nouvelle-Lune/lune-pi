import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.ts";
import { normalizeCodeWhitespace, wrapToWidth } from "./diff-text.ts";
import { stabilizeBackgroundResets, type DiffTheme } from "./diff-palette.ts";
import { clampDiffLineToWidth } from "./diff-limits.ts";
import type { DiffMetaEntry } from "./diff-parse.ts";
import type { RenderedRow } from "./diff-layout.ts";
export function formatMetaEntryRows(
    entry: DiffMetaEntry,
    width: number,
    theme: DiffTheme,
    wordWrap: boolean,
): RenderedRow[] {
    const normalized = sanitizeAnsiForThemedOutput(normalizeCodeWhitespace(entry.raw));
    const lines = wordWrap
        ? wrapToWidth(normalized, width, true)
        : [truncateToWidth(normalized, width)];
    const mapColor = (line: string): string => {
        if (entry.kind === "hunk") {
            return stabilizeBackgroundResets(theme.fg("accent", line));
        }
        if (entry.kind === "file") {
            return stabilizeBackgroundResets(theme.fg("muted", line));
        }
        return stabilizeBackgroundResets(theme.fg("toolDiffContext", line));
    };
    return lines.map((line) => ({
        text: mapColor(line),
        hunkIndex: entry.kind === "file" ? null : entry.hunkIndex || null,
    }));
}
export function renderSingleDiffRow(
    text: string,
    color: string,
    width: number,
    theme: DiffTheme,
): string[] {
    if (width <= 0) {
        return [""];
    }
    return [clampDiffLineToWidth(stabilizeBackgroundResets(theme.fg(color, text)), width)];
}
export function renderWriteHeader(
    wasOverwrite: boolean,
    width: number,
    theme: DiffTheme,
    headerLabel?: string,
): string {
    const actionLabel = headerLabel?.trim() || (wasOverwrite ? "overwritten" : "created");
    return stabilizeBackgroundResets(truncateToWidth(theme.fg("dim", actionLabel), width));
}
