import { readFile } from "node:fs/promises";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import { linkText } from "../../utils/links.ts";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";

type ToolResult = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
export function resultText(result: ToolResult): string {
    return result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}
// Links are added after sanitizing, which strips every escape, and before wrapping, which
// carries an open link onto the next row.
export function outputPreview(
    text: string,
    width: number,
    limit: number,
    running: boolean,
    cwd: string,
) {
    const budget = Math.min(64_000, Math.max(1024, Math.max(1, width) * limit * 4));
    const source = running ? text.slice(-budget) : text.slice(0, budget);
    const rows = wrapTextWithAnsi(
        linkText(sanitizeToolResultText(source), cwd),
        Math.max(1, width),
    );
    return {
        lines: limit <= 0 ? [] : running ? rows.slice(-limit) : rows.slice(0, limit),
        hidden: text.length > source.length || rows.length > limit,
    };
}
export function fullOutputPath(result: ToolResult): string | undefined {
    const details = result.details as { fullOutputPath?: unknown } | undefined;
    return typeof details?.fullOutputPath === "string" && details.fullOutputPath.trim()
        ? details.fullOutputPath
        : undefined;
}
/** Native bash and codemode may archive output before returning their own truncated preview. */
export function fullResultText(result: ToolResult): string | Promise<string> {
    const path = fullOutputPath(result);
    return path ? readFile(path, "utf8") : resultText(result);
}
