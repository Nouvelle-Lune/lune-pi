import type { ExtensionAPI, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { render as renderMermaid, sourceBox } from "grok-mermaid";

const diagrams = new Map<string, ReturnType<typeof renderMermaid> | undefined>();
const MAX_DIAGRAMS = 48;
const MAX_DIAGRAM_CHARACTERS = 32_000;
const dialects: Record<string, string> = {
    statediagram: "stateDiagram",
    "statediagram-v2": "stateDiagram-v2",
    classdiagram: "classDiagram",
    "classdiagram-v2": "classDiagram",
    erdiagram: "erDiagram",
    sequencediagram: "sequenceDiagram",
};
const admonitions: Record<string, string> = {
    NOTE: "◆",
    TIP: "✦",
    IMPORTANT: "!",
    WARNING: "!",
    CAUTION: "!",
};
const protectedInline = /(`+).*?\1|!?\[[^\]]*\]\([^\n]*?\)|<https?:\/\/[^>]+>/g;
const urlPattern = /https?:\/\/[^\s<>"'`|，。；：！？、」』】（）【】《》『』「」]+/g;
function trimUrl(value: string) {
    let url = value.replace(/[.,;:!?}"']+$/, "");
    for (const [open, close] of [
        ["(", ")"],
        ["[", "]"],
    ] as const) {
        while (url.endsWith(close) && url.split(close).length > url.split(open).length)
            url = url.slice(0, -1);
    }
    return url;
}
function prose(value: string): string {
    const convert = (text: string) => {
        text = text.replace(/[①-⑳]/g, (character) => `(${character.codePointAt(0)! - 0x2460 + 1})`);
        text = text.replace(urlPattern, (value) => {
            const url = trimUrl(value);
            return url ? `[${url}](${url})${value.slice(url.length)}` : value;
        });
        return text;
    };
    let start = 0;
    const parts: string[] = [];
    for (const match of value.matchAll(protectedInline)) {
        parts.push(convert(value.slice(start, match.index)), match[0]);
        start = match.index + match[0].length;
    }
    parts.push(convert(value.slice(start)));
    return parts.join("");
}
function codeSpan(line: string): string {
    const content = line || "\u00a0";
    const length = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
    const fence = "`".repeat(length + 1);
    const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
    return `${fence}${padding}${content}${padding}${fence}`;
}
function diagram(source: string, width: number): string[] {
    let art = diagrams.get(source);
    if (source.length > MAX_DIAGRAM_CHARACTERS)
        return ["```", ...sourceBox(source, Math.max(8, width - 2)).plain, "```"];
    if (!diagrams.has(source)) {
        try {
            art = renderMermaid(source);
        } catch {
            art = undefined;
        }
        diagrams.set(source, art);
        if (diagrams.size > MAX_DIAGRAMS) diagrams.delete(diagrams.keys().next().value!);
    }
    if (!art) return ["```", ...sourceBox(source, Math.max(8, width - 2)).plain, "```"];
    if (art.width > width)
        return ["```", ...sourceBox(source, Math.max(8, width - 2)).plain, "```"];
    return [art.plain.map(codeSpan).join("  \n")];
}
export function clearMarkdownCache() {
    diagrams.clear();
}

/** Code, existing links and streaming-incomplete structures must never be rewritten as prose. */
export const transformMarkdown: MarkdownTransformer = (markdown, context) => {
    if (context.messageType === "assistant-thinking") return markdown;
    const lines = markdown.split("\n");
    const output: string[] = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const fence = /^( {0,3}(?:>[ \t]?)*)(`{3,}|~{3,})\s*([^\s]*)[^\n]*$/.exec(line);
        if (fence) {
            const prefix = fence[1]!;
            const marker = fence[2]!;
            const label = fence[3]!;
            const closing = new RegExp(
                `^${prefix.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}${marker[0]}{${marker.length},}\\s*$`,
            );
            let end = index + 1;
            while (end < lines.length && !closing.test(lines[end]!)) end++;
            const closed = end < lines.length;
            if (closed && dialects[label.toLowerCase()] && !context.isStreaming) {
                const source = lines
                    .slice(index + 1, end)
                    .map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry))
                    .join("\n");
                const typed = `${dialects[label.toLowerCase()]}\n${source}`;
                output.push(
                    ...diagram(typed, context.availableWidth ?? 80).map((entry) => prefix + entry),
                );
            } else output.push(...lines.slice(index, closed ? end + 1 : lines.length));
            index = closed ? end : lines.length;
            continue;
        }
        if (context.isStreaming) {
            output.push(line);
            continue;
        }
        const alert = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(line);
        if (alert) {
            const name = alert[1]!.toUpperCase();
            output.push(
                `> **${admonitions[name]} ${name}**${alert[2] ? ` ${prose(alert[2])}` : ""}`,
            );
        } else output.push(prose(line));
    }
    return output.join("\n");
};

export default function markdownEnhance(pi: ExtensionAPI, isEnabled: () => boolean) {
    pi.registerMarkdownTransformer((markdown, context) =>
        isEnabled() ? transformMarkdown(markdown, context) : markdown,
    );
}
