import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
    renderEditDiffResult,
    renderWriteDiffResult,
    type DisplayConfigInput,
} from "./diff-renderer.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../../../config/config.ts";
import type { WriteExecutionMetadataStore, WriteExecutionMeta } from "./write-execution.ts";
import { countEditDiffStats } from "./diff-edit-render.ts";
import { countWriteDiffStats, writeDiffText } from "./diff-write-render.ts";
import { normalizeCollapsedHintLine } from "./diff-component.ts";
import { fullResultText, resultText } from "../output.ts";

type DiffStats = ReturnType<typeof countEditDiffStats>;
// Every collapsed row re-asks whenever its cache misses, and a write diff is a full line LCS.
// Streaming may mutate a reused details object, so entries are checked against the diff inputs.
const statsByDetails = new WeakMap<object, { inputs: unknown[]; stats: DiffStats }>();
function cachedStats(details: object, inputs: unknown[], count: () => DiffStats): DiffStats {
    const cached = statsByDetails.get(details);
    if (
        cached?.inputs.length === inputs.length &&
        cached.inputs.every((value, index) => value === inputs[index])
    )
        return cached.stats;
    const stats = count();
    statsByDetails.set(details, { inputs, stats });
    return stats;
}

export function richDiffSummary(
    theme: Theme,
    name: string,
    args: Record<string, unknown>,
    details: unknown,
): string {
    if (!details || typeof details !== "object") return "";
    const metadata =
        "luneThemeWrite" in details
            ? (details.luneThemeWrite as WriteExecutionMeta | undefined)
            : undefined;
    const content = typeof args.content === "string" ? args.content : undefined;
    const stats =
        name === "edit"
            ? cachedStats(details, [name, (details as { diff?: unknown }).diff], () =>
                  countEditDiffStats(details),
              )
            : name === "write" && metadata
              ? cachedStats(
                    details,
                    [name, content, metadata.previousContent, metadata.fileExistedBeforeWrite],
                    () =>
                        countWriteDiffStats(
                            content,
                            metadata.previousContent,
                            metadata.fileExistedBeforeWrite,
                        ),
                )
              : undefined;
    if (!stats) return "";
    const counts = `${theme.fg("toolDiffAdded", `+${stats.added}`)} ${theme.fg("toolDiffRemoved", `-${stats.removed}`)}`;
    return metadata && !metadata.fileExistedBeforeWrite
        ? `${theme.fg("dim", "new file ·")} ${counts}`
        : counts;
}

type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type ResultContext = Pick<
    Parameters<NonNullable<ToolRenderers["renderCall"]>>[2],
    "toolCallId" | "expanded" | "isError" | "invalidate"
> & { args: Record<string, unknown> };
interface ResultOptions {
    expanded: boolean;
    isPartial?: boolean;
    isError?: boolean;
    isHovered?: () => boolean;
}

export function diffHiddenRow(component: Component, lines: readonly string[]): number {
    const diff = component as Component & { isCollapsedHintLine?(line: string): boolean };
    if (!diff.isCollapsedHintLine) return -1;
    const hidden = lines.findIndex((line) =>
        diff.isCollapsedHintLine!(normalizeCollapsedHintLine(line) ?? ""),
    );
    if (hidden >= 0) return hidden;
    // Folded write context is still available in the full diff, even without a line-budget overflow.
    return lines.some((line) =>
        /^… \d+ unchanged lines$/.test(normalizeCollapsedHintLine(line) ?? ""),
    )
        ? lines.length
        : -1;
}

export function fullToolOutput(
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
    store: WriteExecutionMetadataStore,
    id: string,
): string | Promise<string> {
    const text = resultText(result);
    if (name === "edit") {
        const details = result.details as { diff?: string } | undefined;
        return details?.diff ? `${text}\n\n${details.diff}` : text;
    }
    if (name !== "write" || typeof args.content !== "string") return fullResultText(result);
    const details = result.details as { luneThemeWrite?: WriteExecutionMeta } | undefined;
    const metadata = details?.luneThemeWrite ?? store.get(id);
    if (
        !metadata ||
        metadata.diffUnavailableReason ||
        (metadata.fileExistedBeforeWrite && typeof metadata.previousContent !== "string")
    )
        return text;
    return `${text}\n\n${writeDiffText(args.content, metadata.previousContent)}`;
}

export function renderRichToolResult(
    toolName: string,
    result: ToolResult,
    options: ResultOptions,
    theme: Theme,
    context: ResultContext,
    writeMetadata: WriteExecutionMetadataStore,
    displayConfig: DisplayConfigInput = DEFAULT_TOOL_DISPLAY_CONFIG,
): Component | undefined {
    if (options.isPartial || options.isError || context.isError) return undefined;
    const path = context.args.file_path ?? context.args.path;
    const shared = {
        expanded: options.expanded,
        showDisclosure: false,
        filePath: typeof path === "string" ? path : undefined,
        isHovered: options.isHovered,
        invalidate: context.invalidate,
    };
    if (toolName === "edit")
        return renderEditDiffResult(
            result.details,
            shared,
            displayConfig,
            theme,
            resultText(result),
        );
    if (toolName !== "write") return undefined;
    const details = result.details as { luneThemeWrite?: WriteExecutionMeta } | undefined;
    const metadata = details?.luneThemeWrite ?? writeMetadata.get(context.toolCallId);
    // External writers and older transcripts have no trustworthy preimage.
    if (!metadata) return undefined;
    if (metadata.diffUnavailableReason)
        return {
            render: (width) => [
                truncateToWidth(
                    theme.fg("warning", `diff unavailable: ${metadata.diffUnavailableReason}`),
                    Math.max(0, width),
                    "",
                ),
            ],
            invalidate() {},
        };
    return renderWriteDiffResult(
        typeof context.args.content === "string" ? context.args.content : undefined,
        {
            ...shared,
            previousContent: metadata.previousContent,
            fileExistedBeforeWrite: metadata.fileExistedBeforeWrite,
        },
        displayConfig,
        theme,
        resultText(result),
    );
}
export {
    DEFAULT_TOOL_DISPLAY_CONFIG,
    type ToolDisplayConfig,
    type DiffViewMode,
    type DiffIndicatorMode,
} from "../../../config/config.ts";
export type { DisplayConfigInput } from "./diff-renderer.ts";
export { WriteExecutionMetadataStore } from "./write-execution.ts";
