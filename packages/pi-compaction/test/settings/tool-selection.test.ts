import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
    stripTerminalSequences,
    visibleWidth,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";
import { openSettingsPanel } from "@lune_99/pi-lune-extensions-core/panel/tui";
import { registerSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
import { createCompactionSection } from "../../src/settings/section.ts";
import { withCompactionSettings } from "../harness/settings-host.ts";

type Tools = ReturnType<ExtensionAPI["getAllTools"]>;
function tool(name: string, source = "builtin:read", namespace?: string): Tools[number] {
    return {
        name,
        description: `Description for ${name}`,
        parameters: Type.Object({}),
        exposure: "direct",
        annotations: { readOnlyHint: true },
        sourceInfo: {
            path: source,
            source: source.startsWith("builtin:") ? "builtin" : "extension-package",
            scope: "user",
            origin: "top-level",
        },
        ...(namespace ? { namespace: { name: namespace } } : {}),
    };
}

class PanelUi {
    panel!: Component & { dispose?: () => void };
    private waiters = new Set<() => void>();
    async custom(
        factory: (tui: TUI, theme: Theme, bindings: unknown, done: () => void) => Component,
    ) {
        await new Promise<void>((resolve) => {
            this.panel = factory(
                {
                    requestRender: () => {
                        for (const check of [...this.waiters]) check();
                    },
                } as unknown as TUI,
                { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme,
                {},
                resolve,
            );
        });
    }
    text(width = 150) {
        return this.panel.render(width).map(stripTerminalSequences).join("\n");
    }
    press(key: string) {
        this.panel.handleInput!(key);
    }
    ready() {
        const ready = () => !this.text().includes("Saving / loading");
        if (ready()) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const check = () => {
                if (ready()) {
                    this.waiters.delete(check);
                    resolve();
                }
            };
            this.waiters.add(check);
        });
    }
}

test(
    "tool submenu saves explicit choices, preserves unavailable entries and discovers new tools unchecked",
    { timeout: 5000 },
    async () => {
        // Tool choices keep unavailable saved names and only add a newly selected registered tool.
        await withCompactionSettings("lune-tools-", async (settings, environment) => {
            await settings.set("policy", {
                deleteThreshold: 0.1,
                deletableTools: ["read", "temporarily_missing"],
            });
            let tools: Tools = [
                tool("read"),
                tool("github_search", "builtin:mcp", "mcp__github"),
                tool("new_extension_tool", "/extension.ts"),
            ];
            const ui = new PanelUi();
            const ctx = { ui, mode: "tui", hasUI: true } as unknown as ExtensionContext;
            const section = createCompactionSection(settings, () => tools);
            const release = registerSettingsSection(ui, section);
            const opening = openSettingsPanel(ctx, { section: "compaction" });
            try {
                for (let i = 0; i < 7; i++) ui.press("\x1b[B");
                ui.press("\r");
                assert.match(ui.text(), /✓ read \[Pi\]/);
                assert.match(ui.text(), / {2}github_search \[MCP · github\]/);
                assert.match(ui.text(), /✓ temporarily_missing \[Unavailable\]/);
                for (const width of [24, 80])
                    assert.ok(ui.panel.render(width).every((line) => visibleWidth(line) <= width));
                ui.press("\x1b[B");
                ui.press(" ");
                assert.match(ui.text(), /✓ github_search/);
                assert.deepEqual(settings.get("policy").deletableTools, [
                    "read",
                    "temporarily_missing",
                ]);
                ui.press("\r");
                await ui.ready();
                assert.deepEqual(settings.get("policy"), {
                    deleteThreshold: 0.1,
                    deletableTools: ["read", "temporarily_missing", "github_search"],
                });
                const stored = JSON.parse(
                    await readFile(environment.settingsPath("global"), "utf8"),
                );
                assert.deepEqual(stored.policy, settings.get("policy"));

                tools = [
                    tool("github_search", "builtin:mcp", "mcp__github"),
                    tool("added_later", "/extension.ts"),
                ];
                ui.press("\r");
                assert.match(ui.text(), / {2}added_later/);
                assert.match(ui.text(), /✓ read \[Unavailable\]/);
                ui.press(" ");
                ui.press("\x1b");
                assert.ok(
                    settings.get("policy").deletableTools.includes("github_search"),
                    "Escape must discard draft changes",
                );
                ui.press("\r");
                ui.press("temporarily_missing");
                ui.press(" ");
                ui.press("\r");
                await ui.ready();
                assert.deepEqual(settings.get("policy").deletableTools, ["read", "github_search"]);
                ui.press("\x1b");
                await opening;
            } finally {
                ui.panel.dispose?.();
                release();
            }
        });
    },
);

test("policy controls read and write the selected scope without erasing the other policy field", async () => {
    // Nested settings edits preserve sibling values while applying scope-specific inheritance.
    await withCompactionSettings("lune-tool-scope-", async (settings) => {
        await settings.set("policy", { deleteThreshold: 0.1, deletableTools: ["global_tool"] });
        await settings.set(
            "policy",
            { deleteThreshold: 0.2, deletableTools: ["project_tool"] },
            { scope: "project" },
        );
        const section = createCompactionSection(settings, () => []);
        const tools = section.fields.find(({ id }) => id === '["policy","deletableTools"]')!;
        const choices = await tools.choiceSource!.load({
            ...tools.choiceContext!({} as ExtensionContext, "global"),
            signal: new AbortController().signal,
        });
        assert.deepEqual(
            choices.map(({ value }) => value),
            ["global_tool"],
        );
        await tools.set(["global_tool", "extra_tool"], "global");
        assert.deepEqual(settings.inspect("policy").globalValue, {
            deleteThreshold: 0.1,
            deletableTools: ["global_tool", "extra_tool"],
        });
        assert.deepEqual(settings.get("policy"), {
            deleteThreshold: 0.2,
            deletableTools: ["project_tool"],
        });
        await section.fields
            .find(({ id }) => id === '["policy","deleteThreshold"]')!
            .set(0.15, "project");
        assert.deepEqual(settings.get("policy"), {
            deleteThreshold: 0.15,
            deletableTools: ["project_tool"],
        });
        await section.fields
            .find(({ id }) => id === '["policy","deleteThreshold"]')!
            .reset("project");
        assert.deepEqual(settings.get("policy"), {
            deleteThreshold: 0.1,
            deletableTools: ["project_tool"],
        });
        await tools.reset("project");
        assert.equal(settings.inspect("policy").projectValue, undefined);
        assert.deepEqual(settings.get("policy"), {
            deleteThreshold: 0.1,
            deletableTools: ["global_tool", "extra_tool"],
        });
    });
});

test(
    "fresh tool settings preselect the expanded defaults and leave unrelated tools unchecked",
    { timeout: 5000 },
    async () => {
        // Default permissions cover the established safe tool list and leave unconfigured tools off.
        await withCompactionSettings("lune-default-tools-", async (settings) => {
            const defaults = [
                "read",
                "grep",
                "find",
                "ls",
                "codemode",
                "bash",
                "edit",
                "powershell",
                "tool_search",
            ];
            const ui = new PanelUi();
            const ctx = { ui, mode: "tui", hasUI: true } as unknown as ExtensionContext;
            const section = createCompactionSection(settings, () => [
                ...defaults.map((name) => tool(name)),
                tool("custom_tool"),
            ]);
            const release = registerSettingsSection(ui, section);
            const opening = openSettingsPanel(ctx, { section: "compaction" });
            try {
                for (let index = 0; index < 7; index++) ui.press("\x1b[B");
                ui.press("\r");
                for (const name of defaults) {
                    assert.ok(
                        ui.text().includes("✓ " + name + " [Pi]"),
                        name + " must be selected by default",
                    );
                    ui.press("\x1b[B");
                }
                assert.ok(ui.text().includes("  custom_tool [Pi]"));
                assert.deepEqual(settings.get("policy").deletableTools, defaults);
                ui.press("\x1b");
                ui.press("\x1b");
                await opening;
            } finally {
                ui.panel.dispose?.();
                release();
            }
        });
    },
);
