import type { AssistantMessage } from "@earendil-works/pi-ai";

interface SummaryPart {
    title: string;
    body: string;
}

function parseSummaryPart(text: string): SummaryPart | undefined {
    const match = /^\s*\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n(?:\r?\n)?([\s\S]*))?\s*$/.exec(text);
    if (!match) return undefined;
    return { title: match[1]!.trim(), body: (match[2] ?? "").trim() };
}

function parseLatestStreamingSummary(text: string): SummaryPart | undefined {
    const titlePattern = /(?:^|\r?\n)\s*\*\*([^\n*]+?)\*\*[ \t]*(?:\r?\n)?/g;
    let latest: RegExpExecArray | undefined;
    let match: RegExpExecArray | null;
    while ((match = titlePattern.exec(text))) latest = match;
    if (!latest) return parseSummaryPart(text);
    return {
        title: latest[1]!.trim(),
        body: text.slice(latest.index + latest[0].length).trim(),
    };
}

function getLatestOpenAiSummary(signature: string | undefined): SummaryPart | undefined {
    if (!signature) return undefined;
    try {
        const item = JSON.parse(signature) as {
            type?: unknown;
            summary?: Array<{ type?: unknown; text?: unknown }>;
        };
        if (item.type !== "reasoning" || !Array.isArray(item.summary)) return undefined;
        for (let index = item.summary.length - 1; index >= 0; index--) {
            const part = item.summary[index]!;
            if (part.type !== "summary_text" || typeof part.text !== "string") continue;
            const parsed = parseSummaryPart(part.text);
            if (parsed) return parsed;
        }
    } catch {
        // Provider-specific signatures are opaque; their visible text remains authoritative.
    }
    return undefined;
}

export interface ThinkingRun {
    text: string;
    preview: string;
    title?: string;
    start: number;
    end: number;
}

export function thinkingRun(
    message: AssistantMessage,
    start: number,
    activeIndex = -1,
): ThinkingRun {
    const blocks: string[] = [];
    let latest: SummaryPart | undefined;
    const responses = [
        "openai-responses",
        "openai-codex-responses",
        "azure-openai-responses",
    ].includes(message.api);
    let index = start;
    for (; index < message.content.length; index++) {
        const block = message.content[index]!;
        if (block.type !== "thinking") break;
        const text = block.thinking.trim();
        if (!text) continue;
        blocks.push(text);
        if (responses) {
            const live = parseLatestStreamingSummary(text);
            const completed = getLatestOpenAiSummary(block.thinkingSignature);
            // A streaming signature can still describe the previous summary stage.
            latest =
                index === activeIndex
                    ? (live ?? completed ?? latest)
                    : (completed ?? live ?? latest);
        }
    }
    const text = blocks.join("\n\n");
    return { start, end: index - 1, text, preview: latest?.body ?? text, title: latest?.title };
}
