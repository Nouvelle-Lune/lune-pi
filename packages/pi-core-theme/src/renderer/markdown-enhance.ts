import type { ExtensionAPI, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { render as renderMermaid, sourceBox } from "grok-mermaid";
import { fileHref, hyperlinksEnabled, replaceLinks } from "../utils/links.ts";

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
const linkTarget = (text: string, href: string) =>
    href.startsWith("file:") ? `[${text}](<${href}>)` : `[${text}](${href})`;
/**
 * Code and existing links keep their text. With OSC 8 links, a code span that names an existing
 * path becomes its link text, and a link to a local path gets a file URL that terminals can open.
 */
function linkProtected(segment: string, cwd: string | undefined): string {
    if (cwd === undefined) return segment;
    const code = /^(`+)(.*?)\1$/.exec(segment)?.[2]?.trim();
    if (code !== undefined) {
        // Only code with a slash or a file extension costs a file-system check.
        const href = /\/|\.[A-Za-z\d]+(?::[\d:-]+|#.*)?$/.test(code) && fileHref(code, cwd);
        return href ? `[${segment}](<${href}>)` : segment;
    }
    const link = /^(\[[^\]]*\]\()<?([^\s<>()]+)>?((?:\s[^)]*)?\))$/.exec(segment);
    // `name:<digits>` is a path location such as `README.md:12`, not a URL scheme.
    if (!link || /^[a-z][a-z\d+.-]*:(?!\d)/i.test(link[2]!)) return segment;
    const href = fileHref(link[2]!, cwd);
    return href ? `${link[1]}<${href}>${link[3]}` : segment;
}
function prose(value: string, cwd: string | undefined): string {
    const convert = (text: string) => {
        text = text.replace(/[①-⑳]/g, (character) => `(${character.codePointAt(0)! - 0x2460 + 1})`);
        return replaceLinks(text, cwd, linkTarget);
    };
    let start = 0;
    const parts: string[] = [];
    for (const match of value.matchAll(protectedInline)) {
        parts.push(convert(value.slice(start, match.index)), linkProtected(match[0], cwd));
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
    // Paths resolve from Pi's working directory, like its native tools.
    const cwd = hyperlinksEnabled() ? process.cwd() : undefined;
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
                `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${marker[0]}{${marker.length},}\\s*$`,
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
                `> **${admonitions[name]} ${name}**${alert[2] ? ` ${prose(alert[2], cwd)}` : ""}`,
            );
        } else output.push(prose(line, cwd));
    }
    return output.join("\n");
};

export default function markdownEnhance(pi: ExtensionAPI, isEnabled: () => boolean) {
    pi.registerMarkdownTransformer((markdown, context) =>
        isEnabled() ? transformMarkdown(markdown, context) : markdown,
    );
}
