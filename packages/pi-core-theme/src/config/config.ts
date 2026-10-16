import type { Static } from "typebox";
import { Value } from "typebox/value";
import { themeSchema } from "../settings.ts";

export type Config = Static<typeof themeSchema>;
export type CompactStyleMode = Config["mode"];
export type DiffViewMode = Config["diffViewMode"];
export type DiffIndicatorMode = Config["diffIndicatorMode"];
export type ToolDisplayConfig = Pick<
    Config,
    | "diffViewMode"
    | "diffIndicatorMode"
    | "diffSplitMinWidth"
    | "editDiffCollapsedLines"
    | "writeDiffCollapsedLines"
    | "diffWordWrap"
    | "expandedPreviewMaxLines"
>;

export const DEFAULT_CONFIG = Value.Default(themeSchema, {}) as Config;
export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = getToolDisplayConfig(DEFAULT_CONFIG);

// Pi owns one interactive transcript per process; only its active TUI session may publish values.
export const config: Config = { ...DEFAULT_CONFIG, mode: "off" };
let revision = 0;
export const configRevision = () => revision;
export function setConfig(next: Config): void {
    Object.assign(config, next);
    revision++;
}
export function getToolDisplayConfig(source: Config = config): ToolDisplayConfig {
    return {
        diffViewMode: source.diffViewMode,
        diffIndicatorMode: source.diffIndicatorMode,
        diffSplitMinWidth: source.diffSplitMinWidth,
        editDiffCollapsedLines: source.editDiffCollapsedLines,
        writeDiffCollapsedLines: source.writeDiffCollapsedLines,
        diffWordWrap: source.diffWordWrap,
        expandedPreviewMaxLines: source.expandedPreviewMaxLines,
    };
}
