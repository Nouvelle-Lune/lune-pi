import {
    copyToClipboard,
    type ContextUsage,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatTokens } from "../utils/format-tokens.ts";
import { TextPanel, type TextPanelItem, type TextPanelOptions } from "./text-panel.ts";

type Color = Parameters<Theme["fg"]>[0];

export interface ContextCategory {
    label: string;
    content: string;
    tokens: number;
}

type PanelHost = Pick<TextPanelOptions, "theme" | "rows" | "repaint" | "close" | "copy" | "notify">;

// Category colors are semantic Pi tokens; the active palette owns every foreground and background.
const CATEGORY_COLORS = [
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "customMessageLabel",
    "success",
] as const;

function align(left: string, right: string, width: number): string {
    const end = truncateToWidth(right, Math.max(0, width - visibleWidth(left) - 1), "…");
    return left + " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(end))) + end;
}

function metricRows(label: string, value: string, width: number): string[] {
    return visibleWidth(label) + visibleWidth(value) + 1 <= width
        ? [align(label, value, width)]
        : [label, value];
}

function composition(
    usage: ContextUsage,
    categories: readonly ContextCategory[],
    width: number,
    theme: Theme,
): string {
    if (usage.contextWindow <= 0) return theme.fg("dim", "Window size unavailable");
    let previous = 0;
    let cumulative = 0;
    const used = categories
        .map((category, index) => {
            cumulative += category.tokens;
            // This chart shows category estimates; Pi's reported usage remains in the header.
            const end = Math.min(width, Math.round((cumulative / usage.contextWindow) * width));
            const segment = theme.fg(CATEGORY_COLORS[index]!, "█".repeat(end - previous));
            previous = end;
            return segment;
        })
        .join("");
    return used + theme.fg("dim", "░".repeat(width - previous));
}

export function formatContextOverview(
    usage: ContextUsage,
    categories: readonly ContextCategory[],
): string {
    const remaining =
        usage.tokens !== null && usage.contextWindow > 0
            ? Math.max(0, usage.contextWindow - usage.tokens)
            : null;
    return [
        "Context window",
        `Pi context usage: ${usage.tokens === null ? "unknown" : usage.tokens.toLocaleString("en-US")} / ${usage.contextWindow > 0 ? usage.contextWindow.toLocaleString("en-US") : "unknown"} tokens`,
        `Pi context share: ${usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`}`,
        `Remaining: ${remaining === null ? "unknown" : remaining.toLocaleString("en-US")} tokens`,
        "",
        ...categories.map(
            (category) =>
                `${category.label}: ${category.tokens.toLocaleString("en-US")} estimated tokens`,
        ),
    ].join("\n");
}

function renderOverview(
    usage: ContextUsage,
    categories: readonly ContextCategory[],
    width: number,
    theme: Theme,
): string[] {
    const share = (tokens: number) =>
        usage.contextWindow > 0 ? `  ${((tokens / usage.contextWindow) * 100).toFixed(1)}%` : "";
    const lines = [
        "",
        theme.bold(theme.fg("mdHeading", "Context window")),
        theme.fg(
            "dim",
            `${usage.tokens === null ? "?" : formatTokens(usage.tokens)} / ${usage.contextWindow > 0 ? formatTokens(usage.contextWindow) : "?"} tokens · Pi context usage`,
        ),
        "",
        composition(usage, categories, width, theme),
        "",
        ...categories.flatMap((category, index) => {
            const color = CATEGORY_COLORS[index]!;
            return metricRows(
                theme.fg(color, "● ") + theme.fg("text", category.label),
                theme.fg(color, category.tokens.toLocaleString("en-US") + share(category.tokens)),
                width,
            );
        }),
    ];
    return lines.flatMap((line) => wrapTextWithAnsi(line, width));
}

/** Style structural headings without parsing an entire session into a Markdown syntax tree. */
function renderDocument(content: string, width: number, theme: Theme): string[] {
    let code = false;
    const rows: string[] = [""];
    for (const line of content.split("\n")) {
        const fence = line.match(/^```(.*)$/);
        if (fence) {
            if (!code && fence[1])
                rows.push(...wrapTextWithAnsi(theme.fg("dim", fence[1].toUpperCase()), width));
            else rows.push("");
            code = !code;
            continue;
        }
        const heading = !code && line.match(/^#{1,6}\s+(.+)$/);
        const text = heading
            ? theme.bold(theme.fg("mdHeading", heading[1]!))
            : theme.fg("text", line);
        rows.push(...wrapTextWithAnsi(text, width));
    }
    return rows;
}

function renderHeader(usage: ContextUsage, width: number, theme: Theme): string[] {
    const { tokens, contextWindow, percent } = usage;
    const color: Color = percent !== null && percent >= 90 ? "warning" : "accent";
    const title = theme.fg("accent", "◐ ") + theme.bold(theme.fg("text", "LUNE · Context"));
    const amount = `${tokens === null ? "?" : formatTokens(tokens)} / ${contextWindow > 0 ? formatTokens(contextWindow) : "?"} tokens`;
    const remaining =
        tokens !== null && contextWindow > 0 ? Math.max(0, contextWindow - tokens) : null;
    const detail = `${percent === null ? "?" : percent.toFixed(1)}% used · ${remaining === null ? "?" : formatTokens(remaining)} available`;
    const showDetail = width >= 54;
    const meterWidth = Math.max(1, width - (showDetail ? visibleWidth(detail) + 3 : 0));
    const cells =
        percent === null
            ? 0
            : Math.max(0, Math.min(meterWidth, Math.round((percent / 100) * meterWidth)));
    const meter =
        theme.fg(color, "━".repeat(cells)) +
        theme.fg("borderMuted", "━".repeat(meterWidth - cells));
    return [
        align(title, theme.fg("muted", amount), width),
        meter + (showDetail ? "   " + theme.fg("muted", detail) : ""),
        theme.fg(
            "dim",
            `${tokens === null ? "Pi context usage unknown" : "Pi context usage"} · category sizes estimated`,
        ),
    ];
}

export function createContextPanel(
    usage: ContextUsage,
    categories: readonly ContextCategory[],
    host: PanelHost,
): TextPanel {
    const items: TextPanelItem[] = [
        {
            label: "Overview",
            content: formatContextOverview(usage, categories),
            render: (_content, width, theme) => renderOverview(usage, categories, width, theme),
        },
        ...categories.map((category, index) => ({
            label: category.label,
            content: category.content,
            badge: formatTokens(category.tokens),
            color: CATEGORY_COLORS[index]!,
            render: renderDocument,
        })),
    ];
    return new TextPanel({
        ...host,
        title: "LUNE · Context",
        maxHeight: 24,
        items,
        navigationTitle: "Categories · est. tokens",
        header: (width, theme) =>
            renderHeader(usage, width, theme).slice(0, host.rows() < 18 ? 1 : 3),
    });
}

export async function showContextBrowser(
    ctx: Pick<ExtensionContext, "ui">,
    usage: ContextUsage,
    categories: readonly ContextCategory[],
) {
    await ctx.ui.custom<void>(
        (tui, _theme, _keys, done) =>
            createContextPanel(usage, categories, {
                theme: () => ctx.ui.theme,
                rows: () => tui.terminal.rows,
                repaint: () => tui.requestRender(),
                close: () => done(),
                copy: copyToClipboard,
                notify: (message, level) => ctx.ui.notify(message, level),
            }),
        {
            overlay: true,
            overlayOptions: { width: 100, maxHeight: 24, anchor: "center", margin: 2 },
        },
    );
}
