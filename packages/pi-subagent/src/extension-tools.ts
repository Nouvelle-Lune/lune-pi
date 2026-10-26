import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { REPORT_TOOL_NAME } from "./run/report-tool.ts";
import { SUBAGENT_TOOL_NAMES } from "./tools/subagent-tools.ts";

/** A tool that one of the parent's user or project extensions registers. */
export interface ExtensionTool {
    name: string;
    description: string;
    /** The file of the extension that registers it; a run that selects the tool loads it. */
    path: string;
}

/**
 * The parent's tools that a run can get by loading the extension that registers them.
 *
 * Names the run has on its own stay Pi's: a parent extension that replaces `bash` does not replace
 * the run's native one. The subagent tools are left out, so runs cannot start runs.
 */
export function listExtensionTools(
    tools: readonly ToolInfo[],
    options: { runTools: ReadonlySet<string>; projectTrusted: boolean },
): ExtensionTool[] {
    return tools.flatMap((tool) => {
        const { path, scope } = tool.sourceInfo;

        if (
            isSyntheticPath(path) ||
            tool.exposure === "hidden" ||
            options.runTools.has(tool.name) ||
            tool.name === REPORT_TOOL_NAME ||
            tool.name.startsWith("mcp__") ||
            (SUBAGENT_TOOL_NAMES as readonly string[]).includes(tool.name) ||
            (scope === "project" && !options.projectTrusted)
        ) {
            return [];
        }

        return [{ name: tool.name, description: tool.description, path }];
    });
}

/** Pi gives tools and extensions without a file a `builtin:<name>` or `<kind:name>` path. */
export function isSyntheticPath(path: string): boolean {
    return path.startsWith("builtin:") || path.startsWith("<");
}
