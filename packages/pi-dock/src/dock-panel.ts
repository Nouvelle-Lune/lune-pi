import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { LuneDockSnapshot } from "@lune_99/pi-lune-extensions-core/dock";
import { getDockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";
import { defineSettingsPanel } from "@lune_99/pi-lune-extensions-core/panel";
import { DockFooter } from "./dock-footer.ts";
import { dockSettings, type DockSettings } from "./dock-settings.ts";
import type { DockStatus } from "./dock-status.ts";

const line = (text: string): Component => ({
    render: (width) => [truncateToWidth(text, width)],
    invalidate() {},
});

/** Preview cells are fixed samples: a preview is passive and must not read live plugin state. */
const sampleEntries = [
    {
        id: "shell",
        snapshot: {
            base: line("○ Shell"),
            detail: line("○ Shell · 2 running"),
            full: line("○ Shell · 2 running · latest: npm test · 14s"),
        } satisfies LuneDockSnapshot,
    },
    {
        id: "ask",
        snapshot: {
            base: line("○ Ask"),
            detail: line("○ Ask · 1 pending request"),
            full: line("○ Ask · 1 pending request · API design"),
        } satisfies LuneDockSnapshot,
    },
];

const sampleStatus: DockStatus = {
    cwd: "~/projects/lune",
    branch: "main",
    sessionName: undefined,
    model: { provider: "anthropic", id: "claude-opus-5-5", thinking: "max" },
    showProvider: true,
    tokenSpeed: { tokensPerSecond: 48.2, generating: false },
    usage: {
        input: 28_000,
        output: 5_600,
        cacheRead: 187_000,
        cacheWrite: 0,
        cost: 0.008,
        cacheHitRate: 98.9,
    },
    context: { tokens: 27_400, percent: 2.7, window: 1_000_000 },
    autoCompact: true,
    extensionStatuses: [],
};

/** Draws the candidate settings with the real renderer, focused so key hints and selection show. */
function dockPreview({ values, theme }: { values: DockSettings; theme: Theme }): Component {
    const footer = new DockFooter();
    const layout = {
        style: values.style,
        showModel: values.showModel,
        showWorkspace: values.showWorkspace,
        showUsage: values.showUsage,
    };
    return {
        render: (width) =>
            footer.render(width, theme, {
                entries: sampleEntries,
                status: values.style === "classic" ? undefined : sampleStatus,
                selectedId: "shell",
                mode: values.displayMode,
                layout,
            }),
        invalidate() {},
    };
}

export const dockPanel = defineSettingsPanel(dockSettings, {
    id: "dock",
    label: "Dock",
    fields: (field) => [
        field("enabled", {
            label: "Dock",
            description:
                "Off removes the dock and restores Pi's footer and each plugin's own status bar.",
            preview: dockPreview,
        }),
        field("style", {
            label: "Style",
            description:
                "How the dock is framed. Every style except classic replaces Pi's footer with the model, directory and usage rows.",
            choices: [
                { value: "ruled", label: "ruled", description: "Rules between the rows" },
                { value: "boxed", label: "boxed", description: "A rounded box around all rows" },
                { value: "compact", label: "compact", description: "Two rows, no frame" },
                {
                    value: "minimal",
                    label: "minimal",
                    description: "One row: cells, model, context",
                },
                {
                    value: "classic",
                    label: "classic",
                    description: "Cells only; Pi's footer stays",
                },
            ],
            preview: dockPreview,
        }),
        field("displayMode", {
            label: "Presentation",
            description: "Horizontal information density of each plugin cell.",
            choices: [
                { value: "base", label: "base", description: "Identity only" },
                { value: "detail", label: "detail", description: "Identity and a summary" },
                {
                    value: "full",
                    label: "full",
                    description: "Identity, summary and the latest item",
                },
            ],
            preview: dockPreview,
        }),
        field("showModel", {
            label: "Show model",
            description:
                "Provider, model, thinking level and response token speed beside the cells.",
            preview: dockPreview,
        }),
        field("showWorkspace", {
            label: "Show directory",
            description: "Working directory and git branch. Not drawn by minimal or classic.",
            preview: dockPreview,
        }),
        field("showUsage", {
            label: "Show usage",
            description:
                "Token, cache and cost counters with context use. Minimal keeps only context use; classic draws none.",
            preview: dockPreview,
        }),
        field("hidden", {
            label: "Hidden plugins",
            description: "Plugins left out of the dock. They keep running and stay registered.",
            formatValue: (value) => (value.length > 0 ? value.join(", ") : "none"),
            choiceSource: {
                multiple: true,
                emptyMessage: "No plugin has registered with the dock",
                load: ({ context }) =>
                    getDockRegistry()
                        .getContributions(context.ui)
                        .map(({ id }) => ({ value: id, label: id })),
            },
        }),
        field("order", {
            label: "Plugin order",
            description:
                'JSON object of plugin id to position, e.g. {"ask-question": 1}. Smaller positions come first; plugins without one count as 0.',
            editor: "json",
            formatValue: (value) => {
                const entries = Object.entries(value);
                return entries.length > 0
                    ? entries.map(([id, position]) => `${id}=${position}`).join(", ")
                    : "registration order";
            },
        }),
    ],
});
