import {
    getCurrentSystemMessage,
    getCurrentTools,
    getSystemMessageText,
} from "@earendil-works/pi-ai";
import {
    estimateTokens,
    type ContextUsage,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
    formatContextOverview,
    showContextBrowser,
    type ContextCategory,
} from "../ui/context-browser.ts";
export { formatTokens } from "../utils/format-tokens.ts";

type PreviewKey =
    | "systemPrompt"
    | "memoryFiles"
    | "skills"
    | "tools"
    | "toolResults"
    | "contextFiles";
export type ContextPart = { label: string; tokens: number };
type ContextBreakdown = { parts: ContextPart[]; previews: Record<PreviewKey, string> };

function previewValue(value: unknown): string {
    if (typeof value === "string") return value;
    const text = JSON.stringify(
        value,
        (_key, entry) =>
            entry?.type === "image" && typeof entry.data === "string"
                ? { ...entry, data: "[image payload omitted]" }
                : entry,
        2,
    );
    return `\`\`\`json\n${text}\n\`\`\``;
}

export function collectContextBreakdown(
    ctx: Pick<ExtensionCommandContext, "sessionManager">,
): ContextBreakdown {
    const projection = ctx.sessionManager.buildSessionProjection();
    const system = getCurrentSystemMessage(projection.messages);
    const tools = getCurrentTools(projection.messages);
    let systemTokens = 0;
    let memoryTokens = 0;
    let skillsTokens = 0;
    let toolDefinitionTokens = 0;
    let systemPrompt = "";
    let memory = "";
    let skills = "";
    if (system) {
        const { project_context, ...withoutMemory } = system.sections ?? {};
        const { skills: skillsSection, ...withoutSkills } = withoutMemory;
        memory = project_context ?? "";
        skills = skillsSection ?? "";
        const prompt = { ...system, toolsAdded: undefined };
        const promptWithoutMemory = { ...prompt, sections: withoutMemory };
        const promptWithoutSkills = { ...prompt, sections: withoutSkills };
        // Differences preserve Pi's rounding across the complete prompt, including full tool declarations.
        toolDefinitionTokens = estimateTokens(system) - estimateTokens(prompt);
        memoryTokens = estimateTokens(prompt) - estimateTokens(promptWithoutMemory);
        skillsTokens = estimateTokens(promptWithoutMemory) - estimateTokens(promptWithoutSkills);
        systemTokens = estimateTokens(promptWithoutSkills);
        systemPrompt = getSystemMessageText(promptWithoutSkills);
    }
    const toolResultPreview: string[] = [];
    const contextPreview: string[] = [];
    let toolResultTokens = 0;
    let contextTokens = 0;
    for (const message of projection.messages) {
        if (message.role === "system") continue;
        if (message.role === "toolResult") {
            toolResultTokens += estimateTokens(message);
            toolResultPreview.push(
                `## Result: ${message.toolName}\n\n${previewValue(message.content)}`,
            );
            continue;
        }
        contextTokens += estimateTokens(message);
        if (message.role === "assistant") {
            for (const block of message.content) {
                if (block.type === "toolCall")
                    contextPreview.push(
                        `## Assistant tool call: ${block.name}\n\n${previewValue(block.arguments)}`,
                    );
                else if (block.type === "text")
                    contextPreview.push(`## Assistant\n\n${block.text}`);
                else if (block.type === "thinking")
                    contextPreview.push(`## Assistant thinking\n\n${block.thinking}`);
            }
        } else if (message.role === "bashExecution") {
            contextPreview.push(
                `## Bash\n\nCommand:\n\n${previewValue(message.command)}\n\nOutput:\n\n${previewValue(message.output)}`,
            );
        } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
            contextPreview.push(`## ${message.role}\n\n${message.summary}`);
        } else {
            contextPreview.push(`## ${message.role}\n\n${previewValue(message.content)}`);
        }
    }
    return {
        parts: [
            { label: "System prompt", tokens: systemTokens },
            { label: "Memory", tokens: memoryTokens },
            { label: "Skills", tokens: skillsTokens },
            { label: "Tool definitions", tokens: toolDefinitionTokens },
            { label: "Tool results", tokens: toolResultTokens },
            { label: "Messages", tokens: contextTokens },
        ],
        previews: {
            systemPrompt: systemPrompt || "No system prompt in the current context.",
            memoryFiles: memory || "No memory files in context.",
            skills: skills || "No skills in context.",
            tools:
                tools
                    .map((tool) => `## Definition: ${tool.name}\n\n${previewValue(tool)}`)
                    .join("\n\n") || "No active tool definitions.",
            toolResults:
                toolResultPreview.join("\n\n") || "No tool results in the current context.",
            contextFiles: contextPreview.join("\n\n") || "No conversation context.",
        },
    };
}

export default function contextUsageExtension(
    pi: ExtensionAPI,
    isEnabled: (ctx: ExtensionCommandContext) => Promise<boolean>,
) {
    pi.registerCommand("context", {
        description: "Inspect context usage, prompts, memory, skills, tools and messages",
        handler: async (_args, ctx) => {
            if (!(await isEnabled(ctx))) {
                ctx.ui.notify("Enable Core theme in /lune-core-settings core-theme", "warning");
                return;
            }
            const breakdown = collectContextBreakdown(ctx);
            const usage = ctx.getContextUsage();
            // Match Dock: unknown usage stays unknown, including the interval after compaction.
            const summary: ContextUsage = {
                tokens: usage?.tokens ?? null,
                contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
                percent: usage?.percent ?? null,
            };
            const keys: PreviewKey[] = [
                "systemPrompt",
                "memoryFiles",
                "skills",
                "tools",
                "toolResults",
                "contextFiles",
            ];
            const categories: ContextCategory[] = breakdown.parts.map((part, index) => ({
                ...part,
                content: breakdown.previews[keys[index]!],
            }));
            if (ctx.mode !== "tui") {
                ctx.ui.notify(formatContextOverview(summary, categories), "info");
                return;
            }
            await showContextBrowser(ctx, summary, categories);
        },
    });
}
