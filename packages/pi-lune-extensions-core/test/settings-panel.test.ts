import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test, type TestContext } from "node:test";
import { Type } from "typebox";
import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {
    stripTerminalSequences,
    truncateToWidth,
    visibleWidth,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";
import luneCore from "../src/extension.ts";
import { isolateExternalSessions } from "./harness/session-fixtures.ts";
import { defineSettings, assertSettingsSchema } from "../src/settings/index.ts";
import { acquireSettings } from "../src/settings/advanced.ts";
import { createSettingsSandbox } from "../src/testing/index.ts";
import type { SettingsBackend } from "../src/settings/backend.ts";
import {
    defineSettingsPanel,
    modelChoices,
    type SettingsPanelField,
    type SettingsSection,
} from "../src/panel/index.ts";
import { openSettingsPanel } from "../src/panel/tui.ts";
import {
    createSettingsPanelRegistry,
    getSettingsPanelRegistry,
    registerSettingsSection,
    createSettingsSection,
    createDefinedSettingsSection,
} from "../src/panel/host.ts";

const keys = {
    enter: "\r",
    escape: "\x1b",
    down: "\x1b[B",
    tab: "\t",
    scope: "\x07",
    reset: "\x12",
    saveReload: "\x13",
    removedReload: "\x0c",
    backspace: "\x7f",
    end: "\x1b[F",
    left: "\x1b[D",
    right: "\x1b[C",
};
const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

class PanelUi {
    panel: (Component & { dispose?: () => void; focused?: boolean }) | undefined;
    renders = 0;
    private readonly renderWaiters = new Set<() => void>();
    readonly tui = {
        requestRender: () => {
            this.renders++;
            for (const check of [...this.renderWaiters]) check();
        },
    } as unknown as TUI;

    async custom(
        factory: (tui: TUI, theme: Theme, keybindings: unknown, done: () => void) => Component,
    ): Promise<void> {
        await new Promise<void>((resolve) => {
            this.panel = factory(this.tui, theme, {}, resolve);
            this.panel.focused = true;
        });
    }

    text(width = 100): string {
        return this.panel!.render(width).map(stripTerminalSequences).join("\n");
    }

    waitFor(condition: () => boolean): Promise<void> {
        if (condition()) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const check = () => {
                if (!condition()) return;
                this.renderWaiters.delete(check);
                resolve();
            };
            this.renderWaiters.add(check);
        });
    }

    press(key: string): void {
        this.panel!.handleInput!(key);
    }
    async save(key = keys.enter): Promise<void> {
        this.press(key);
        await this.waitFor(() => !this.text().includes("Saving / loading"));
    }
}

function schema() {
    return Type.Object({
        enabled: Type.Boolean({ default: true }),
        density: Type.Union([Type.Literal("base"), Type.Literal("full")], {
            default: "base",
        }),
        count: Type.Integer({ default: 1, minimum: 0 }),
        caption: Type.Union([Type.String(), Type.Null()], { default: "default" }),
    });
}

async function fixture(t: TestContext, options: { projectTrusted?: boolean } = {}) {
    const projectTrusted = options.projectTrusted ?? true;
    const sandbox = await createSettingsSandbox({ prefix: "lune-panel-" });
    const root = path.dirname(sandbox.agentDir);
    const ui = new PanelUi();
    const ctx = {
        mode: "tui",
        hasUI: true,
        cwd: sandbox.cwd,
        ui,
        isProjectTrusted: () => projectTrusted,
    } as unknown as ExtensionContext;
    const definition = defineSettings({ id: "sample", schema: schema() });
    const settingsPath = (scope: "global" | "project") => sandbox.settingsFile(definition, scope);
    const lease = await sandbox.acquire(definition, { projectTrusted });
    const manager = lease.settings;
    let previewsCreated = 0;
    let previewsDisposed = 0;
    const section = createSettingsSection(manager, {
        label: "Sample",
        fields: {
            count: {
                label: "Count",
                description: "Number of visible sample items.",
                presentation: true,
                preview: ({ value, values, scope }) => {
                    previewsCreated++;
                    return {
                        render: (width) => [
                            truncateToWidth(
                                `Sample ${value} / ${values.density} / ${scope}`,
                                width,
                            ),
                        ],
                        invalidate() {},
                        dispose() {
                            previewsDisposed++;
                        },
                    };
                },
            },
            caption: {
                preview: ({ value }) => ({
                    render: () => [JSON.stringify(value)],
                    invalidate() {},
                }),
            },
        },
    });
    const releases: Array<() => void | Promise<void>> = [registerSettingsSection(ui, section)];
    t.after(async () => {
        ui.panel?.dispose?.();
        for (const release of releases) await release();
        await sandbox.dispose();
    });
    return {
        manager,
        ctx,
        ui,
        section,
        releases,
        root,
        sandbox,
        settingsPath,
        previews: () => ({ created: previewsCreated, disposed: previewsDisposed }),
    };
}

// Fixtures scope real persistence through PI_CODING_AGENT_DIR and remain serial in this process.
describe("unified settings panel", { concurrency: false, timeout: 10000 }, () => {
    test("pins Core before string-ordered labels and resolves equal labels by ID regardless of registration order", async (t) => {
        const { ctx, ui, section, releases } = await fixture(t);
        releases[0]!();
        const declarations = [
            { id: "lowercase", label: "alpha" },
            { id: "tie-z", label: "Shared" },
            { id: "core", label: "Core" },
            { id: "accented", label: "Éclair" },
            { id: "first", label: "Alpha" },
            { id: "tie-a", label: "Shared" },
        ];
        const expectedTabs = "Core / Alpha / Shared / Shared / alpha / Éclair";
        const expectedIds = ["core", "first", "tie-a", "tie-z", "lowercase", "accented"];
        for (const order of [declarations, [...declarations].reverse()]) {
            const unregister = order.map(({ id, label }) =>
                registerSettingsSection(ui, {
                    ...section,
                    id,
                    label,
                    fields: [{ ...section.fields[0]!, label: `Setting for ${id}` }],
                }),
            );
            releases.push(...unregister);
            const opening = openSettingsPanel(ctx);
            const actualTabs = ui.panel!.render(200)[2];
            assert.equal(actualTabs, expectedTabs);
            for (const id of expectedIds) {
                assert.match(ui.text(), new RegExp(`Setting for ${id}\\s`));
                ui.press(keys.tab);
            }
            ui.press(keys.escape);
            await opening;
            for (const release of unregister) release();
        }
    });

    test("registration and re-registration reorder tabs without replacing the active section or its input candidate", async (t) => {
        const { manager, ctx, ui, section, releases } = await fixture(t);
        const opening = openSettingsPanel(ctx, { section: "sample" });
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.enter);
        ui.press(keys.end);
        ui.press(keys.backspace);
        ui.press("7");
        const alpha = {
            ...section,
            id: "alpha",
            label: "Alpha",
            fields: [section.fields[0]!],
        };
        const releaseAlpha = registerSettingsSection(ui, alpha);
        releases.push(releaseAlpha);
        releases.push(
            registerSettingsSection(ui, {
                ...section,
                id: "zulu",
                label: "Zulu",
                fields: [section.fields[0]!],
            }),
        );
        const expected = "Alpha / Sample / Zulu";
        let actual = ui.panel!.render(200)[2];
        assert.equal(actual, expected);
        assert.equal(ui.panel!.render(200)[1], "Count · global");
        releaseAlpha();
        releases.push(registerSettingsSection(ui, alpha));
        actual = ui.panel!.render(200)[2];
        assert.equal(actual, expected);
        assert.equal(ui.panel!.render(200)[1], "Count · global");
        await ui.save();
        assert.equal(manager.get("count"), 7);
        ui.press(keys.escape);
        await opening;
    });

    test("Core startup mounts an empty first-position placeholder and shutdown removes only Core", async (t) => {
        const { ctx, ui, releases, settingsPath, root } = await fixture(t);
        isolateExternalSessions(t, root);
        // Core startup also installs session mentions, which register an editor autocomplete provider.
        Object.assign(ui, { addAutocompleteProvider: () => {} });
        const context = { ...ctx, sessionManager: SessionManager.inMemory(ctx.cwd) };
        type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
        const handlers = new Map<string, Set<Handler>>();
        const commands = new Map<
            string,
            { handler(args: string, ctx: ExtensionContext): Promise<void> }
        >();
        const emit = async (name: string) => {
            for (const handler of [...(handlers.get(name) ?? [])])
                await handler({ type: name }, context);
        };
        releases.push(() => emit("session_shutdown"));
        await luneCore({
            on(name: string, handler: Handler) {
                const listeners = handlers.get(name) ?? new Set<Handler>();
                handlers.set(name, listeners);
                listeners.add(handler);
                return () => listeners.delete(handler);
            },
            registerCommand: (
                name: string,
                definition: { handler(args: string, ctx: ExtensionContext): Promise<void> },
            ) => commands.set(name, definition),
        } as unknown as ExtensionAPI);
        const registry = getSettingsPanelRegistry();
        const expectedBeforeStartup = ["sample"];
        const actualBeforeStartup = registry.getSections(ui).map(({ id }) => id);
        assert.deepEqual(actualBeforeStartup, expectedBeforeStartup);
        await emit("session_start");
        const expectedCore = [{ id: "core", label: "Core", fields: 0 }];
        const actualCore = registry
            .getSections(ui)
            .filter(({ id }) => id === "core")
            .map(({ id, label, fields }) => ({ id, label, fields: fields.length }));
        assert.deepEqual(actualCore, expectedCore);
        const opening = commands.get("lune-core-settings")!.handler("", context);
        const expectedTabs = "Core / Sample";
        const actualTabs = ui.panel!.render(200)[2];
        assert.equal(actualTabs, expectedTabs);
        assert.match(ui.text(), /No settings are available in this section yet/);
        await ui.save(keys.saveReload);
        await assert.rejects(readFile(settingsPath("global"), "utf8"), { code: "ENOENT" });
        ui.press(keys.tab);
        assert.match(ui.text(), /enabled/);
        ui.press(keys.escape);
        await opening;
        await emit("session_shutdown");
        const expectedAfterShutdown = ["sample"];
        const actualAfterShutdown = registry.getSections(ui).map(({ id }) => id);
        assert.deepEqual(actualAfterShutdown, expectedAfterShutdown);
        assert.equal(handlers.get("session_start")?.size, 0);
        assert.equal(handlers.get("session_shutdown")?.size, 0);
    });

    test("custom backend leases expose selected fields in order while callbacks see all scoped values", async (t) => {
        // The selected row keeps its formatted value while the removed status row stays absent.
        const { manager, ctx, ui, releases } = await fixture(t);
        releases[0]!();
        await manager.set("enabled", false, { scope: "project" });
        const customSchema = schema();
        assertSettingsSchema(customSchema);
        const backend: SettingsBackend<ReturnType<typeof schema>> = {
            id: "custom",
            settingSchema: customSchema,
            inspect: (key) => manager.inspect(key),
            set: (key, value, options) => manager.set(key, value, options),
            reset: (key, options) => manager.reset(key, options),
            subscribe: (listener) => manager.subscribe(listener),
            reload: () => manager.reload(),
        };
        const lease = await acquireSettings(
            defineSettings<ReturnType<typeof schema>>({
                id: "custom",
                schema: customSchema,
                backend: () => ({ backend, release: () => undefined }),
            }),
            { cwd: ctx.cwd, projectTrusted: true },
        );
        t.after(() => lease.release());
        const section = createSettingsSection(lease.settings, {
            label: "Custom",
            fieldOrder: ["density", "count"],
            fields: {
                density: { editor: "select" },
                count: {
                    formatValue: (value, { values }) => `${value} / enabled=${values.enabled}`,
                },
            },
        });
        assert.deepEqual(
            section.fields.map(({ id }) => id),
            ["density", "count"],
        );
        releases.push(registerSettingsSection(ui, section));
        const opening = openSettingsPanel(ctx, { section: "custom", scope: "project" });
        assert.match(ui.text(), /1 \/ enabled=false/);
        assert.doesNotMatch(ui.text(), /Effective:|Source:/);
        ui.press(keys.enter);
        ui.press(keys.down);
        assert.equal(manager.get("density"), "base");
        ui.press(keys.escape);
        assert.equal(manager.get("density"), "base");
        ui.press(keys.enter);
        ui.press(keys.down);
        await ui.save();
        assert.equal(manager.get("density"), "full");
        ui.press(keys.escape);
        await opening;
    });

    test("JSON editors override inferred enum cycling and previews do not select the editor", async (t) => {
        const { manager, ctx, ui, releases } = await fixture(t);
        releases[0]!();
        const section = createSettingsSection(manager, {
            label: "Explicit editors",
            fieldOrder: ["density", "enabled"],
            fields: {
                density: { editor: "json" },
                enabled: {
                    preview: ({ value }) => ({
                        render: () => [`Enabled preview: ${value}`],
                        invalidate() {},
                    }),
                },
            },
        });
        releases.push(registerSettingsSection(ui, section));
        const opening = openSettingsPanel(ctx);
        ui.press(keys.enter);
        ui.press(keys.end);
        for (let index = 0; index < '"base"'.length; index++) ui.press(keys.backspace);
        ui.press('"full"');
        await ui.save();
        assert.equal(manager.get("density"), "full");
        ui.press(keys.down);
        await ui.save();
        assert.equal(manager.get("enabled"), false);
        assert.match(ui.text(), /Enabled preview: false/);
        assert.doesNotMatch(ui.text(), /Unsaved/);
        ui.press(keys.escape);
        await opening;
    });

    for (const editor of ["json", "select"] as const) {
        test(`${editor} candidates close after committed notification errors and reload failures`, async (t) => {
            const { manager, ctx, ui, releases } = await fixture(t);
            releases[0]!();
            let notifications = 0;
            const unsubscribe = manager.subscribe(() => {
                notifications++;
                throw new Error("consumer failed");
            });
            t.after(unsubscribe);
            const section = createSettingsSection(manager, {
                label: "Partial failure",
                fieldOrder: ["count"],
                fields: {
                    count: {
                        editor,
                        choices: [
                            { value: 1, label: "One" },
                            { value: 4, label: "Four" },
                        ],
                    },
                },
            });
            releases.push(
                registerSettingsSection(ui, {
                    ...section,
                    reload: async () => {
                        throw new Error("read unavailable");
                    },
                }),
            );
            const opening = openSettingsPanel(ctx);
            ui.press(keys.enter);
            if (editor === "select") ui.press(keys.down);
            else {
                ui.press(keys.end);
                ui.press(keys.backspace);
                ui.press("4");
            }
            await ui.save(keys.saveReload);
            assert.equal(manager.get("count"), 4);
            assert.match(ui.text(), /Saved; Settings change listeners failed/);
            assert.match(ui.text(200), /Saved, but reload failed: read unavailable/);
            assert.doesNotMatch(ui.text(), /Type to search|Enter to save|Unsaved/);
            await ui.save(keys.saveReload);
            assert.equal(notifications, 1);
            ui.press(keys.escape);
            await opening;
        });
    }

    test("disabled cycle choices and invalid dynamic choices never reach persistence", async (t) => {
        const { manager, ctx, ui, releases } = await fixture(t);
        releases[0]!();
        const section = createSettingsSection(manager, {
            label: "Validation",
            fieldOrder: ["enabled", "count"],
            fields: {
                enabled: {
                    choices: [
                        { value: true, label: "On" },
                        { value: false, label: "Off", disabled: "Required by policy" },
                    ],
                },
                count: { choiceSource: { load: () => [{ value: -1, label: "Invalid" }] } },
            },
        });
        let writes = 0;
        releases.push(
            registerSettingsSection(ui, {
                ...section,
                fields: section.fields.map((field) => ({
                    ...field,
                    set: async () => {
                        writes++;
                    },
                })),
            }),
        );
        const opening = openSettingsPanel(ctx);
        await ui.save();
        assert.match(ui.text(), /Required by policy/);
        ui.press(keys.down);
        ui.press(keys.enter);
        await ui.save();
        assert.match(ui.text(), /Invalid dynamic choice for setting "count"/);
        assert.equal(writes, 0);
        ui.press(keys.escape);
        ui.press(keys.escape);
        await opening;
    });

    test("binds boolean and literal controls to a leased settings view", async (t) => {
        // The low-level panel consumes the settings view without acquiring or releasing its lease.
        const { manager, ctx, ui, settingsPath } = await fixture(t);
        const opening = openSettingsPanel(ctx);
        assert.match(ui.text(), /Lune settings · global/);
        await ui.save();
        assert.equal(manager.get("enabled"), false);
        ui.press(keys.down);
        await ui.save();
        assert.equal(manager.get("density"), "full");
        const stored = JSON.parse(await readFile(settingsPath("global"), "utf8"));
        assert.deepEqual(stored, { enabled: false, density: "full" });
        ui.press(keys.escape);
        await opening;
    });

    test("writes the chosen scope and reset restores global inheritance", async (t) => {
        // Reset preserves backend inheritance state while the panel no longer renders source metadata.
        const { manager, ctx, ui } = await fixture(t);
        await manager.set("enabled", false);
        const opening = openSettingsPanel(ctx);
        ui.press(keys.scope);
        await ui.save();
        assert.equal(manager.inspect("enabled").projectValue, true);
        assert.equal(manager.inspect("enabled").globalValue, false);
        assert.equal(manager.get("enabled"), true);
        ui.press(keys.scope);
        assert.match(ui.text(), /Project overrides global/);
        await ui.save();
        assert.equal(manager.get("enabled"), true);
        ui.press(keys.scope);
        await ui.save(keys.reset);
        assert.equal(manager.inspect("enabled").projectValue, undefined);
        assert.equal(manager.inspect("enabled").source, "global");
        assert.doesNotMatch(ui.text(), /Effective:|Source:/);
        ui.press(keys.escape);
        await opening;
    });

    test("previews an unsaved numeric candidate and persists only after Enter", async (t) => {
        // Preview rendering observes a candidate without committing it until confirmation.
        const { manager, ctx, ui, settingsPath } = await fixture(t);
        const opening = openSettingsPanel(ctx);
        ui.press(keys.down);
        ui.press(keys.down);
        assert.match(ui.text(), /Sample 1 \/ base \/ global/);
        ui.press(keys.enter);
        ui.press(keys.end);
        ui.press(keys.backspace);
        ui.press("4");
        assert.match(ui.text(), /Preview · Unsaved/);
        assert.match(ui.text(), /Sample 4 \/ base \/ global/);
        assert.equal(manager.get("count"), 1);
        await assert.rejects(readFile(settingsPath("global")), {
            code: "ENOENT",
        });
        await ui.save();
        assert.equal(manager.get("count"), 4);
        assert.doesNotMatch(ui.text(), /Unsaved/);
        ui.press(keys.escape);
        await opening;
    });

    test("previews highlighted presentation choices before saving and supports cancellation", async (t) => {
        // A highlighted choice updates only the preview until Enter commits it.
        const { manager, ctx, ui, releases, settingsPath } = await fixture(t);
        releases[0]!();
        releases.push(
            registerSettingsSection(
                ui,
                createSettingsSection(manager, {
                    label: "Sample",
                    fields: {
                        density: {
                            label: "Density",
                            editor: "select",
                            presentation: true,
                            preview: ({ value }) => ({
                                render: (width) => [
                                    truncateToWidth(`Density style: ${value}`, width),
                                ],
                                invalidate() {},
                            }),
                        },
                    },
                }),
            ),
        );
        const opening = openSettingsPanel(ctx);
        ui.press(keys.down);
        ui.press(keys.enter);
        ui.press(keys.down);
        assert.match(ui.text(), /Density style: full/);
        assert.match(ui.text(), /Preview · Unsaved/);
        assert.equal(manager.get("density"), "base");
        await assert.rejects(readFile(settingsPath("global")), {
            code: "ENOENT",
        });
        ui.press(keys.escape);
        assert.match(ui.text(), /Density style: base/);
        assert.equal(manager.get("density"), "base");
        ui.press(keys.enter);
        ui.press(keys.down);
        await ui.save();
        assert.equal(manager.get("density"), "full");
        assert.doesNotMatch(ui.text(), /Unsaved/);
        ui.press(keys.escape);
        await opening;
    });

    test("keeps choice editors inside the panel frame with and without previews", async (t) => {
        // Choice screens reuse the panel shell and their own help row without drawing a nested menu.
        const { manager, ctx, ui, releases } = await fixture(t);
        releases[0]!();
        releases.push(
            registerSettingsSection(
                ui,
                createSettingsSection(manager, {
                    label: "Sample",
                    fieldOrder: ["density", "count"],
                    fields: {
                        density: {
                            label: "Density",
                            editor: "select",
                            choices: [
                                { value: "base", label: "Base" },
                                { value: "full", label: "Full" },
                            ],
                        },
                        count: {
                            label: "Count",
                            editor: "select",
                            choices: [
                                { value: 1, label: "One" },
                                { value: 4, label: "Four" },
                            ],
                            preview: ({ value }) => ({
                                render: (width) => [
                                    truncateToWidth(`Count preview: ${value}`, width),
                                ],
                                invalidate() {},
                            }),
                        },
                    },
                }),
            ),
        );
        const opening = openSettingsPanel(ctx);
        const width = 100;
        const rule = "─".repeat(width);
        const assertPanelFrame = (lines: string[]) => {
            assert.equal(lines[0], rule);
            assert.equal(lines[2], "Sample");
            assert.equal(lines[3], rule);
            assert.equal(lines.at(-1), rule);
            assert.equal(lines.filter((line) => line === rule).length, 4);
        };

        const mainPanel = ui.panel!.render(width).map(stripTerminalSequences);
        assertPanelFrame(mainPanel);
        assert.match(mainPanel.at(-2) ?? "", /↑↓ select · Enter change/);
        assert.match(mainPanel.at(-2) ?? "", /Tab\/←→ section/);

        ui.press(keys.enter);
        const plainChoices = ui.panel!.render(width).map(stripTerminalSequences);
        assertPanelFrame(plainChoices);
        assert.match(plainChoices[1] ?? "", /Density · global/);
        assert.match(plainChoices.at(-2) ?? "", /Type to search.*Enter save/);
        assert.doesNotMatch(plainChoices.at(-2) ?? "", /section|Ctrl\+G scope|Ctrl\+R reset/);

        ui.press(keys.escape);
        ui.press(keys.down);
        ui.press(keys.enter);
        const previewChoices = ui.panel!.render(width).map(stripTerminalSequences);
        assertPanelFrame(previewChoices);
        assert.match(previewChoices[1] ?? "", /Count · global/);
        assert.match(previewChoices.at(-2) ?? "", /Type to search.*Enter save/);
        ui.press(keys.down);
        assert.match(ui.text(), /Count preview: 4/);

        ui.press(keys.escape);
        ui.press(keys.escape);
        await opening;
    });

    test("reserves one description row and still wraps longer descriptions", async (t) => {
        // Missing and single-line descriptions keep equal height while longer text remains readable.
        const { manager, ctx, ui, releases } = await fixture(t);
        releases[0]!();
        releases.push(
            registerSettingsSection(
                ui,
                createSettingsSection(manager, {
                    label: "Descriptions",
                    fieldOrder: ["density", "enabled", "count"],
                    fields: {
                        density: { label: "No description" },
                        enabled: {
                            label: "Short description",
                            description: "A single descriptive line.",
                        },
                        count: {
                            label: "Long description",
                            description:
                                "A longer explanation wraps over multiple terminal rows and ends with the word visible.",
                        },
                    },
                }),
            ),
        );
        const opening = openSettingsPanel(ctx);
        const width = 40;
        const withoutDescription = ui.panel!.render(width).map(stripTerminalSequences);
        ui.press(keys.down);
        const singleLineDescription = ui.panel!.render(width).map(stripTerminalSequences);
        assert.ok(
            singleLineDescription.some((line) => line.includes("A single descriptive line.")),
        );
        assert.equal(singleLineDescription.length, withoutDescription.length);

        ui.press(keys.down);
        const longDescription = ui.panel!.render(width).map(stripTerminalSequences);
        assert.ok(longDescription.length > singleLineDescription.length);
        assert.ok(longDescription.some((line) => line.includes("A longer explanation")));
        assert.ok(longDescription.some((line) => line.includes("visible.")));

        ui.press(keys.escape);
        await opening;
    });

    test("rejects invalid numeric input and Escape discards the candidate", async (t) => {
        const { manager, ctx, ui } = await fixture(t);
        const opening = openSettingsPanel(ctx);
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.enter);
        ui.press(keys.end);
        ui.press(keys.backspace);
        ui.press("-2");
        ui.press(keys.enter);
        assert.match(ui.text(), /Invalid value for Count/);
        assert.equal(manager.get("count"), 1);
        ui.press(keys.escape);
        assert.match(ui.text(), /Sample 1 \/ base \/ global/);
        assert.doesNotMatch(ui.text(), /Invalid/);
        ui.press(keys.escape);
        await opening;
    });

    test("shows persisted null instead of substituting a schema default", async (t) => {
        // Persisted null remains visible in the field row without an effective/source status line.
        const { manager, ctx, ui } = await fixture(t);
        await manager.set("caption", null);
        const opening = openSettingsPanel(ctx);
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.down);
        assert.match(ui.text(), /caption\s+null/);
        assert.doesNotMatch(ui.text(), /Effective:|Source:/);
        ui.press(keys.enter);
        await ui.save();
        assert.equal(manager.get("caption"), null);
        ui.press(keys.escape);
        await opening;
    });

    test("prefills union string input with valid JSON and saves it unchanged", async (t) => {
        const { manager, ctx, ui } = await fixture(t);
        const opening = openSettingsPanel(ctx);
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.enter);
        await ui.save();
        assert.doesNotMatch(ui.text(), /Invalid|Unexpected token/);
        assert.equal(manager.get("caption"), "default");
        ui.press(keys.escape);
        await opening;
    });

    test("keeps saved values after I/O failure and remains usable", async (t) => {
        const { manager, ctx, ui, root } = await fixture(t);
        await rm(path.join(root, "agent"), { recursive: true });
        await writeFile(path.join(root, "agent"), "blocked");
        const opening = openSettingsPanel(ctx);
        await ui.save();
        assert.equal(manager.get("enabled"), true);
        assert.match(ui.text(), /ENOTDIR|EEXIST/);
        await rm(path.join(root, "agent"));
        await ui.save();
        assert.equal(manager.get("enabled"), false);
        ui.press(keys.escape);
        await opening;
    });

    test("Ctrl+S reloads saved settings and Ctrl+L no longer reloads", async (t) => {
        // Reload completion is observable through backend state even after status-row rendering is removed.
        const { manager, ctx, ui, settingsPath } = await fixture(t);
        const opening = openSettingsPanel(ctx);
        await mkdir(path.dirname(settingsPath("global")), {
            recursive: true,
        });
        await writeFile(settingsPath("global"), JSON.stringify({ enabled: false }));
        assert.equal(manager.get("enabled"), true);
        assert.doesNotMatch(ui.text(), /Effective:|Source:/);
        ui.press(keys.removedReload);
        assert.equal(manager.get("enabled"), true);
        await ui.save(keys.saveReload);
        await ui.waitFor(() => {
            const text = ui.text();
            return !text.includes("Saving / loading") && manager.get("enabled") === false;
        });
        assert.equal(manager.get("enabled"), false);
        ui.press(keys.escape);
        await opening;
    });

    test("Ctrl+S persists an input candidate before reloading only the active section", async (t) => {
        // Saving through the panel commits through the leased view before section reload callbacks run.
        const { manager, ctx, ui, section, releases, settingsPath } = await fixture(t);
        releases[0]!();
        const observed: { id: string; value: number }[] = [];
        for (const id of ["sample", "other"]) {
            releases.push(
                registerSettingsSection(ui, {
                    ...section,
                    id,
                    async reload() {
                        const stored = JSON.parse(await readFile(settingsPath("global"), "utf8"));
                        observed.push({ id, value: stored.count });
                        await section.reload();
                    },
                }),
            );
        }
        const opening = openSettingsPanel(ctx, { section: "sample" });
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.enter);
        ui.press(keys.end);
        ui.press(keys.backspace);
        ui.press("4");
        await ui.save(keys.saveReload);
        assert.equal(manager.get("count"), 4);
        assert.deepEqual(observed, [{ id: "sample", value: 4 }]);
        assert.match(ui.text(), /Lune settings · global/);
        assert.doesNotMatch(ui.text(), /Unsaved/);
        ui.press(keys.escape);
        await opening;
    });

    test("Ctrl+S saves a preview choice in the scope selected with Ctrl+G", async (t) => {
        // A saved preview choice uses the selected project scope before the panel reloads its section.
        const { manager, ctx, ui, releases, settingsPath } = await fixture(t);
        releases[0]!();
        const appearance = createSettingsSection(manager, {
            label: "Sample",
            fields: {
                enabled: {
                    editor: "select",
                    presentation: true,
                    preview: ({ value }) => ({
                        render: () => [String(value)],
                        invalidate() {},
                    }),
                },
            },
        });
        let reloaded = false;
        releases.push(
            registerSettingsSection(ui, {
                ...appearance,
                async reload() {
                    const stored = JSON.parse(await readFile(settingsPath("project"), "utf8"));
                    assert.equal(stored.enabled, false);
                    await appearance.reload();
                    reloaded = true;
                },
            }),
        );
        const opening = openSettingsPanel(ctx);
        ui.press(keys.scope);
        ui.press(keys.enter);
        ui.press(keys.down);
        assert.equal(manager.get("enabled"), true);
        await ui.save(keys.saveReload);
        assert.equal(manager.inspect("enabled").projectValue, false);
        assert.equal(manager.inspect("enabled").globalValue, undefined);
        assert.equal(reloaded, true);
        assert.match(ui.text(), /Lune settings · project/);
        assert.doesNotMatch(ui.text(), /Unsaved/);
        ui.press("\x1b[27;5;9~");
        assert.match(ui.text(), /Lune settings · project/);
        ui.press("\x1b[103;5u");
        assert.match(ui.text(), /Lune settings · global/);
        ui.press(keys.escape);
        await opening;
    });

    test("Ctrl+S keeps invalid or failed input editable and skips reload until persistence succeeds", async (t) => {
        const { manager, ctx, ui, section, releases, root } = await fixture(t);
        releases[0]!();
        let reloads = 0;
        releases.push(
            registerSettingsSection(ui, {
                ...section,
                async reload() {
                    reloads++;
                    await section.reload();
                },
            }),
        );
        const opening = openSettingsPanel(ctx);
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.enter);
        ui.press(keys.end);
        ui.press(keys.backspace);
        ui.press("-2");
        await ui.save(keys.saveReload);
        assert.match(ui.text(), /Invalid value for Count/);
        assert.equal(manager.get("count"), 1);
        assert.equal(reloads, 0);
        ui.press(keys.escape);
        ui.press(keys.enter);
        ui.press(keys.end);
        ui.press(keys.backspace);
        ui.press("4");
        await rm(path.join(root, "agent"), { recursive: true });
        await writeFile(path.join(root, "agent"), "blocked");
        await ui.save(keys.saveReload);
        assert.match(ui.text(), /ENOTDIR|EEXIST/);
        assert.match(ui.text(), /Preview · Unsaved/);
        assert.equal(manager.get("count"), 1);
        assert.equal(reloads, 0);
        await rm(path.join(root, "agent"));
        await ui.save(keys.saveReload);
        assert.equal(manager.get("count"), 4);
        assert.equal(reloads, 1);
        assert.doesNotMatch(ui.text(), /Unsaved/);
        ui.press(keys.escape);
        await opening;
    });

    test("reflects committed state when another subscriber throws after saving", async (t) => {
        // A notification error remains visible while the committed backend value remains authoritative.
        const { manager, ctx, ui } = await fixture(t);
        const unsubscribe = manager.subscribe(() => {
            throw new Error("consumer failed");
        });
        t.after(unsubscribe);
        const opening = openSettingsPanel(ctx);
        await ui.save();
        assert.equal(manager.get("enabled"), false);
        assert.match(ui.text(), /Settings change listeners failed after state was updated/);
        assert.doesNotMatch(ui.text(), /Effective:|Source:/);
        ui.press(keys.escape);
        await opening;
    });

    test("Left and Right switch sections like Shift+Tab and Tab with wrap-around", async (t) => {
        const { ctx, ui, section, releases } = await fixture(t);
        releases.push(
            registerSettingsSection(ui, {
                ...section,
                id: "other",
                label: "Other",
                fields: [section.fields[2]!],
            }),
        );
        const opening = openSettingsPanel(ctx, { section: "other" });
        assert.doesNotMatch(ui.text(), /enabled/);
        ui.press(keys.right);
        assert.match(ui.text(), /enabled/);
        ui.press(keys.right);
        assert.doesNotMatch(ui.text(), /enabled/);
        ui.press(keys.left);
        assert.match(ui.text(), /enabled/);
        ui.press(keys.left);
        assert.doesNotMatch(ui.text(), /enabled/);
        ui.press(keys.escape);
        await opening;
    });

    test("Left and Right edit the open input instead of switching sections", async (t) => {
        const { manager, ctx, ui, section, releases } = await fixture(t);
        releases.push(
            registerSettingsSection(ui, {
                ...section,
                id: "zeta",
                label: "Zeta",
                fields: [section.fields[0]!],
            }),
        );
        const opening = openSettingsPanel(ctx);
        assert.match(ui.text(), /Count/);
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.enter);
        // Left moves the cursor before the existing "1", so "5" yields "51".
        ui.press(keys.left);
        ui.press("5");
        ui.press(keys.right);
        ui.press("7");
        assert.match(ui.text(), /Count · global/);

        await ui.save();
        assert.equal(manager.get("count"), 517);
        ui.press(keys.escape);
        await opening;
    });

    test("Left and Right do not switch sections while a choice editor is open", async (t) => {
        const { manager, ctx, ui, section, releases } = await fixture(t);
        releases[0]!();
        releases.push(
            registerSettingsSection(
                ui,
                createSettingsSection(manager, {
                    label: "Sample",
                    fieldOrder: ["density"],
                    fields: {
                        density: {
                            label: "Density",
                            editor: "select",
                            choices: [
                                { value: "base", label: "Base" },
                                { value: "full", label: "Full" },
                            ],
                        },
                    },
                }),
            ),
        );
        releases.push(
            registerSettingsSection(ui, {
                ...section,
                id: "zeta",
                label: "Zeta",
                fields: [section.fields[0]!],
            }),
        );
        const opening = openSettingsPanel(ctx);
        // Each arrow is checked alone: a left/right pair would cancel out on two sections.
        for (const arrow of [keys.right, keys.left]) {
            ui.press(keys.enter);
            assert.match(ui.text(), /Density · global/);
            ui.press(arrow);
            assert.match(ui.text(), /Density · global/);
            ui.press(keys.escape);
            // Still in the Sample section: Zeta's only row would be "enabled".
            assert.match(ui.text(), /Lune settings · global/);
            assert.match(ui.text(), /Density/);
            assert.doesNotMatch(ui.text(), /enabled/);
        }
        ui.press(keys.escape);
        await opening;
    });

    test("switches section tabs and tracks removal without retaining manager ownership", async (t) => {
        const { manager, ctx, ui, releases, section } = await fixture(t);
        const other = {
            ...section,
            id: "other",
            label: "Other",
            fields: [section.fields[2]!],
        };
        const releaseOther = registerSettingsSection(ui, other);
        releases.push(releaseOther);
        const opening = openSettingsPanel(ctx, { section: "other" });
        assert.match(ui.text(), /Other \/ Sample/);
        assert.match(ui.text(), /Sample 1 \/ base/);
        ui.press(keys.tab);
        assert.doesNotMatch(ui.text(), /Sample 1 \/ base/);
        ui.press(keys.tab);
        assert.match(ui.text(), /Sample 1 \/ base/);
        releaseOther();
        await ui.save();
        assert.equal(manager.get("enabled"), false);
        releases[0]!();
        assert.match(ui.text(), /No extensions have registered settings/);
        ui.press(keys.escape);
        await opening;
        const requests = ui.renders;
        await manager.set("enabled", true);
        assert.equal(ui.renders, requests);
    });

    test("bounds themed previews at narrow widths and disposes them on close", async (t) => {
        const { manager, ctx, ui, previews } = await fixture(t);
        const opening = openSettingsPanel(ctx);
        ui.press(keys.down);
        ui.press(keys.down);
        for (const width of [1, 12, 40, 88, 120]) {
            const lines = ui.panel!.render(width);
            assert.ok(lines.every((line) => visibleWidth(line) <= width));
        }
        assert.ok(ui.panel!.render(120).some((line) => line.includes("│")));
        assert.ok(ui.panel!.render(40).some((line) => line.includes("Sample 1")));
        ui.panel!.invalidate();
        assert.match(ui.text(), /Sample 1/);
        ui.press(keys.escape);
        await opening;
        assert.deepEqual(previews(), {
            created: previews().created,
            disposed: previews().created,
        });
        const requests = ui.renders;
        await manager.set("count", 2);
        assert.equal(ui.renders, requests);
        assert.equal(manager.get("count"), 2);
    });

    test("surfaces a failing preview instead of losing the panel", async (t) => {
        const { manager, ctx, ui, releases } = await fixture(t);
        releases[0]!();
        releases.push(
            registerSettingsSection(
                ui,
                createSettingsSection(manager, {
                    label: "Broken",
                    fields: {
                        count: {
                            presentation: true,
                            preview: () => ({
                                render() {
                                    throw new Error("boom");
                                },
                                invalidate() {},
                            }),
                        },
                    },
                }),
            ),
        );
        const opening = openSettingsPanel(ctx);
        ui.press(keys.down);
        ui.press(keys.down);
        assert.match(ui.text(), /Preview failed: boom/);
        ui.press(keys.escape);
        await opening;
    });

    test("rejects an unknown section and releases the panel it already bound", async (t) => {
        const { ctx, ui, releases, section } = await fixture(t);
        await assert.rejects(
            openSettingsPanel(ctx, { section: "missing" }),
            /Unknown settings section "missing"/,
        );
        assert.equal(ui.panel, undefined);
        const requests = ui.renders;
        releases.push(
            registerSettingsSection(ui, {
                ...section,
                id: "later",
                label: "Later",
            }),
        );
        assert.equal(ui.renders, requests);
    });

    test("dynamic choices search and switch candidate ranges without changing the captured write scope", async (t) => {
        const { manager, ctx, ui, releases } = await fixture(t);
        const dynamic = createSettingsSection(manager, {
            id: "dynamic",
            label: "Dynamic",
            fields: {
                count: {
                    label: "Count",
                    formatValue: (value) => `Count ${value}`,
                    choiceSource: {
                        scopes: ["scoped", "all"],
                        defaultScope: () => "scoped",
                        load: ({ candidateScope, values }) => [
                            { value: 2, label: `Scoped ${values.density}` },
                            ...(candidateScope === "all"
                                ? [
                                      {
                                          value: 5,
                                          label: "Provider Five",
                                          description: "provider/model-id",
                                      },
                                  ]
                                : []),
                        ],
                    },
                },
            },
        });
        releases.push(registerSettingsSection(ui, dynamic));
        const opening = openSettingsPanel(ctx, {
            section: "dynamic",
            scope: "project",
        });
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.enter);
        assert.match(ui.text(), /Count · project · scoped/);
        assert.doesNotMatch(ui.text(), /Provider Five/);
        ui.press(keys.tab);
        ui.press(keys.scope);
        ui.press("provider/model-id");
        assert.match(ui.text(), /Provider Five/);
        assert.doesNotMatch(ui.text(), /Scoped base/);
        ui.press(keys.enter);
        await ui.waitFor(() => ui.text().includes("Lune settings"));
        assert.equal(manager.inspect("count").projectValue, 5);
        assert.equal(manager.inspect("count").globalValue, undefined);
        assert.match(ui.text(), /Count 5/);
        ui.press(keys.escape);
        await opening;
    });

    test("model selector shows custom provider IDs inline and searches nested IDs and model names", async (t) => {
        const { ctx, ui, releases } = await fixture(t);
        const custom = {
            provider: "magpie",
            id: "codex/gpt-6.1-sol",
            name: "GPT-6.1-Sol · Codex",
            reasoning: false,
            api: "openai-responses",
        } as NonNullable<ExtensionContext["model"]>;
        const native = { ...custom, provider: "openai", id: "gpt-session", name: "Session model" };
        const context = {
            ...ctx,
            model: native,
            scopedModels: [{ model: native, thinkingLevel: "off" }],
            modelRegistry: {
                getAvailable: () => [native, custom],
                getProviderDisplayName: (provider: string) =>
                    provider === "magpie" ? "Custom gateway" : provider,
                find: (provider: string, id: string) =>
                    [native, custom].find(
                        (model) => model.provider === provider && model.id === id,
                    ),
            },
        } as unknown as ExtensionContext;
        const definition = defineSettings({
            id: "model-selector",
            schema: Type.Object({
                enabled: Type.Boolean({ default: false }),
                model: Type.Union(
                    [Type.Null(), Type.Object({ provider: Type.String(), id: Type.String() })],
                    { default: null },
                ),
            }),
        });
        const panel = defineSettingsPanel(definition, {
            label: "Model settings",
            fields: [
                { path: "enabled", label: "Enabled" },
                {
                    path: "model",
                    label: "Model",
                    choiceSource: modelChoices({
                        specialChoices: [{ value: null, label: "Follow session" }],
                    }),
                },
            ],
        });
        const lease = await acquireSettings(definition, { cwd: ctx.cwd, projectTrusted: true });
        const settings = lease.settings;
        releases.push(registerSettingsSection(ui, createDefinedSettingsSection(settings, panel)));
        releases.push(() => lease.release());
        const opening = openSettingsPanel(context, { section: panel.id });
        ui.press(keys.down);
        ui.press(keys.enter);
        await ui.waitFor(() => !ui.text().includes("Saving / loading"));
        assert.match(ui.text(), /Model · global · scoped/);
        assert.doesNotMatch(ui.text(), /\[magpie\]/);
        ui.press(keys.tab);
        await ui.waitFor(() => ui.text().includes("codex/gpt-6.1-sol [magpie]"));
        assert.match(ui.text(), /codex\/gpt-6\.1-sol \[magpie\]/);
        ui.press("magpie/codex/gpt-6.1-sol");
        const lines = ui.panel!.render(80).map(stripTerminalSequences);
        assert.ok(lines.some((line) => line.includes("codex/gpt-6.1-sol [magpie]")));
        assert.match(ui.text(), /Model Name: GPT-6\.1-Sol · Codex/);
        assert.ok(lines.every((line) => visibleWidth(line) <= 80));
        assert.ok(ui.panel!.render(30).every((line) => visibleWidth(line) <= 30));
        ui.press(keys.escape);
        ui.press(keys.enter);
        await ui.waitFor(() => !ui.text().includes("Saving / loading"));
        ui.press(keys.tab);
        await ui.waitFor(() => ui.text().includes("codex/gpt-6.1-sol [magpie]"));
        ui.press("GPT-6.1-Sol");
        assert.match(ui.text(), /codex\/gpt-6\.1-sol \[magpie\]/);
        ui.press(keys.enter);
        await ui.waitFor(() => ui.text().includes("Lune settings"));
        assert.deepEqual(settings.get("model"), { provider: "magpie", id: "codex/gpt-6.1-sol" });
        assert.equal(context.model, native);
        ui.press(keys.enter);
        await ui.waitFor(() => !ui.text().includes("Saving / loading"));
        ui.press(keys.tab);
        await ui.waitFor(() => ui.text().includes("✓ codex/gpt-6.1-sol [magpie]"));
        assert.match(ui.text(), /✓ codex\/gpt-6\.1-sol \[magpie\]/);
        ui.press(keys.escape);
        ui.press(keys.escape);
        await opening;
    });

    test("dynamic refresh errors retain choices and Escape aborts an in-flight refresh without saving", async (t) => {
        const { manager, ctx, ui, releases } = await fixture(t);
        let refreshingSignal: AbortSignal | undefined;
        let fail = true;
        const dynamic = createSettingsSection(manager, {
            id: "refresh",
            label: "Refresh",
            fields: {
                count: {
                    choiceSource: {
                        load: () => [{ value: 2, label: "Existing choice" }],
                        refresh: async ({ signal }) => {
                            if (fail) throw new Error("catalog unavailable");
                            refreshingSignal = signal;
                            await new Promise<void>((_resolve, reject) =>
                                signal.addEventListener("abort", () => reject(signal.reason), {
                                    once: true,
                                }),
                            );
                        },
                    },
                },
            },
        });
        releases.push(registerSettingsSection(ui, dynamic));
        const opening = openSettingsPanel(ctx, { section: "refresh" });
        ui.press(keys.down);
        ui.press(keys.down);
        ui.press(keys.enter);
        ui.press(keys.reset);
        await ui.waitFor(() => ui.text().includes("catalog unavailable"));
        assert.match(ui.text(), /Existing choice/);
        fail = false;
        ui.press(keys.reset);
        assert.equal(refreshingSignal!.aborted, false);
        ui.press(keys.escape);
        assert.equal(refreshingSignal!.aborted, true);
        assert.equal(manager.get("count"), 1);
        assert.match(ui.text(), /Lune settings/);
        ui.press(keys.escape);
        await opening;
    });

    test("guards terminal-only interaction and registers the unified command", async (t) => {
        const { ctx, ui } = await fixture(t);
        await assert.rejects(openSettingsPanel({ ...ctx, mode: "rpc" }), /TUI/);
        assert.equal(ui.panel, undefined);
        const commands = new Map<
            string,
            { handler(args: string, ctx: ExtensionContext): Promise<void> }
        >();
        luneCore({
            on: () => () => {},
            registerCommand: (
                name: string,
                definition: {
                    handler(args: string, ctx: ExtensionContext): Promise<void>;
                },
            ) => commands.set(name, definition),
        } as unknown as ExtensionAPI);
        const opening = commands.get("lune-core-settings")!.handler("sample", ctx);
        assert.match(ui.text(), /Sample/);
        ui.press(keys.escape);
        await opening;
    });

    test("the number editor parses numeric input and rejects anything else", async (t) => {
        const { ctx, ui, releases, sandbox } = await fixture(t);
        releases[0]!();
        const definition = defineSettings({
            id: "numbers",
            schema: Type.Object({ ratio: Type.Number({ default: 1.5, minimum: 0 }) }),
        });
        const lease = await sandbox.acquire(definition);
        releases.push(
            registerSettingsSection(
                ui,
                createSettingsSection(lease.settings, { label: "Numbers" }),
            ),
        );
        const opening = openSettingsPanel(ctx, { section: "numbers" });
        assert.match(ui.text(), /ratio\s+1\.5/);
        ui.press(keys.enter);
        ui.press(keys.end);

        for (const [typed, message] of [
            ["", /Enter a number for ratio/],
            ["abc", /"abc" is not a number/],
            ["1e999", /"1e999" is not a number/],
            ["-1", /Invalid value for ratio/],
        ] as const) {
            for (let index = 0; index < 8; index++) ui.press(keys.backspace);
            for (const char of typed) ui.press(char);
            ui.press(keys.enter);
            assert.match(ui.text(), message);
            assert.equal(lease.settings.get("ratio"), 1.5);
        }
        for (let index = 0; index < 8; index++) ui.press(keys.backspace);
        for (const char of "0.25") ui.press(char);
        await ui.save();

        assert.equal(lease.settings.get("ratio"), 0.25);
        ui.press(keys.escape);
        await opening;
    });

    test("secret fields are masked in the list, edit from empty and keep the value on empty Enter", async (t) => {
        const { ctx, ui, releases, sandbox } = await fixture(t);
        releases[0]!();
        const definition = defineSettings({
            id: "secrets",
            schema: Type.Object({ apiKey: Type.String({ default: "" }) }),
        });
        const lease = await sandbox.acquire(definition);
        releases.push(
            registerSettingsSection(
                ui,
                createSettingsSection(lease.settings, {
                    label: "Secrets",
                    fields: { apiKey: { secret: true } },
                }),
            ),
        );
        const opening = openSettingsPanel(ctx, { section: "secrets" });
        assert.match(ui.text(), /apiKey\s+\(not set\)/);

        await lease.settings.set("apiKey", "sk-live-1234");
        assert.match(ui.text(), /apiKey\s+••••••••/);
        assert.doesNotMatch(ui.text(), /sk-live/);

        ui.press(keys.enter);
        assert.match(ui.text(), /Type a new value/);
        assert.doesNotMatch(ui.text(), /sk-live/);
        assert.match(ui.text(), /empty Enter keeps current/);
        ui.press(keys.enter);
        assert.equal(lease.settings.get("apiKey"), "sk-live-1234");
        assert.match(ui.text(), /Lune settings · global/);

        ui.press(keys.enter);
        for (const char of "newsecret") ui.press(char);
        assert.match(ui.text(), /•{9}/);
        assert.doesNotMatch(ui.text(), /newsecret/);
        await ui.save();

        assert.equal(lease.settings.get("apiKey"), "newsecret");
        assert.doesNotMatch(ui.text(), /newsecret|sk-live/);
        assert.match(ui.text(), /apiKey\s+••••••••/);
        ui.press(keys.escape);
        await opening;
    });

    test("an untrusted project shows the disabled banner and refuses edits and resets", async (t) => {
        const { manager, ctx, ui, settingsPath } = await fixture(t, { projectTrusted: false });
        const banner = /Project settings are disabled because this folder is not trusted\./;
        const opening = openSettingsPanel(ctx);
        assert.doesNotMatch(ui.text(), banner);

        ui.press(keys.scope);
        assert.match(ui.text(), /Lune settings · project/);
        assert.match(ui.text(), banner);
        assert.doesNotMatch(ui.text(), /global only/);
        ui.press(keys.enter);
        assert.equal(manager.get("enabled"), true);
        assert.match(ui.text(), banner);
        ui.press(keys.reset);
        ui.press(keys.down);
        ui.press(keys.enter);

        assert.equal(manager.get("density"), "base");
        assert.equal(manager.inspect("enabled").projectValue, undefined);
        await assert.rejects(readFile(settingsPath("project"), "utf8"), { code: "ENOENT" });
        ui.press(keys.scope);
        assert.doesNotMatch(ui.text(), banner);
        await ui.save();
        assert.equal(manager.get("density"), "full");
        ui.press(keys.escape);
        await opening;
    });

    test("global-only rows are labelled in project scope and refuse project edits", async (t) => {
        const { ctx, ui, releases, sandbox, settingsPath } = await fixture(t);
        releases[0]!();
        const definition = defineSettings({
            id: "guarded",
            schema: Type.Object({
                token: Type.String({ default: "" }),
                limit: Type.Integer({ default: 1 }),
            }),
            globalOnly: ["token"],
        });
        const lease = await sandbox.acquire(definition);
        await lease.settings.set("token", "abc");
        releases.push(
            registerSettingsSection(
                ui,
                createSettingsSection(lease.settings, { label: "Guarded" }),
            ),
        );
        const opening = openSettingsPanel(ctx, { section: "guarded" });
        assert.doesNotMatch(ui.text(), /global only/);

        ui.press(keys.scope);

        assert.match(ui.text(), /token\s+abc · global only/);
        assert.doesNotMatch(ui.text(), /limit\s+1 · global only/);
        ui.press(keys.enter);
        assert.match(ui.text(), /token can only be set globally/);
        assert.match(ui.text(), /Lune settings · project/);
        ui.press(keys.reset);
        assert.match(ui.text(), /token can only be set globally/);
        assert.equal(lease.settings.get("token"), "abc");
        await assert.rejects(readFile(settingsPath("project"), "utf8"), { code: "ENOENT" });

        ui.press(keys.down);
        ui.press(keys.enter);
        ui.press(keys.end);
        ui.press("7");
        ui.press(keys.enter);
        await ui.waitFor(() => !ui.text().includes("Saving / loading"));
        assert.equal(lease.settings.inspect("limit").projectValue, 17);
        ui.press(keys.escape);
        await opening;
    });

    test("unavailable sections show the error with a retry hint and Ctrl+S reloads", async (t) => {
        const { ctx, ui, section, releases } = await fixture(t);
        releases[0]!();
        let reloads = 0;
        let failure: Error | undefined;
        releases.push(
            registerSettingsSection(ui, {
                id: "broken",
                label: "Broken",
                fields: [],
                scopes: [],
                unavailable: "Migration failed: boom",
                subscribe: () => () => {},
                async reload() {
                    reloads++;
                    if (failure) throw failure;
                },
            }),
        );
        releases.push(registerSettingsSection(ui, { ...section, id: "other", label: "Other" }));
        const opening = openSettingsPanel(ctx, { section: "broken" });

        assert.match(ui.text(), /Settings could not be loaded:/);
        assert.match(ui.text(), /Migration failed: boom/);
        assert.match(ui.text(), /Fix the problem, then press Ctrl\+S to retry\./);
        assert.match(ui.text(), /Tab\/←→ section · Ctrl\+S retry · Esc close/);
        ui.press(keys.right);
        assert.match(ui.text(), /Count/);
        assert.doesNotMatch(ui.text(), /could not be loaded/);
        ui.press(keys.left);
        assert.match(ui.text(), /Settings could not be loaded:/);
        assert.doesNotMatch(ui.text(), /No settings are available/);
        ui.press(keys.scope);
        assert.match(ui.text(), /Lune settings · global/);

        failure = new Error("still broken");
        await ui.save(keys.saveReload);
        assert.equal(reloads, 1);
        assert.match(ui.text(), /Retry failed: still broken/);

        failure = undefined;
        await ui.save(keys.saveReload);
        assert.equal(reloads, 2);
        ui.press(keys.escape);
        await opening;
    });
});

describe("settings section metadata", { concurrency: false, timeout: 10000 }, () => {
    test("rejects duplicate field order and incompatible editor declarations", async (t) => {
        const { manager } = await fixture(t);
        assert.throws(
            () =>
                createSettingsSection(manager, {
                    label: "Invalid",
                    fieldOrder: ["count", "count"],
                }),
            /unique schema keys/,
        );
        assert.throws(
            () =>
                createSettingsSection(manager, {
                    label: "Invalid",
                    fields: { count: { editor: "text" } },
                }),
            /string schema/,
        );
        assert.throws(
            () =>
                createSettingsSection(manager, {
                    label: "Invalid",
                    fields: { count: { editor: "select" } },
                }),
            /requires static or dynamic choices/,
        );
        assert.throws(
            () =>
                createSettingsSection(manager, {
                    label: "Invalid",
                    fields: { enabled: { editor: "cycle", choiceSource: { load: () => [] } } },
                }),
            /requires static choices/,
        );
    });

    test("rejects presentation fields without a preview and choices outside the schema", async (t) => {
        const { manager } = await fixture(t);
        assert.throws(
            () =>
                createSettingsSection(manager, {
                    label: "Sample",
                    // @ts-expect-error Presentation fields must declare a preview.
                    fields: { count: { presentation: true } },
                }),
            {
                name: "TypeError",
                message: /Presentation setting "count" requires a preview/,
            },
        );
        assert.throws(
            () =>
                createSettingsSection(manager, {
                    label: "Sample",
                    fields: {
                        // @ts-expect-error Choices must satisfy the setting schema.
                        density: { choices: [{ value: "dense", label: "Dense" }] },
                    },
                }),
            { name: "TypeError", message: /Invalid choice for setting "density"/ },
        );
    });
});

describe("settings panel registry", () => {
    const section = (id: string): SettingsSection => ({
        id,
        label: id,
        fields: [],
        scopes: [],
        subscribe: () => () => {},
        reload: async () => {},
    });
    const field = (id: string): SettingsPanelField => ({
        id,
        label: id,
        schema: Type.Object({}),
        scopes: ["global", "project"],
        inspect: () => ({
            defaultValue: undefined,
            globalValue: undefined,
            projectValue: undefined,
            value: undefined,
            source: "default",
        }),
        set: async () => {},
        reset: async () => {},
    });

    test("isolates runners, rejects duplicates, and protects later registrations", () => {
        const registry = createSettingsPanelRegistry();
        const a = {},
            b = {};
        const release = registry.register(a, section("a"));
        assert.equal(registry.getSections(a).length, 1);
        assert.equal(registry.getSections(b).length, 0);
        assert.throws(() => registry.register(a, section("a")), /Duplicate/);
        release();
        const replacement = section("a");
        const releaseReplacement = registry.register(a, replacement);
        release();
        assert.equal(registry.getSections(a)[0], replacement);
        releaseReplacement();
    });

    test("rejects duplicate field ids before the panel can bind the wrong setting", () => {
        const registry = createSettingsPanelRegistry();
        const scope = {};
        const duplicate = {
            ...section("duplicate"),
            fields: [field("same"), field("same")],
        };
        assert.throws(
            () => registry.register(scope, duplicate),
            /Duplicate fields in settings section "duplicate"/,
        );
        assert.equal(registry.getSections(scope).length, 0);
    });

    test("reports listener failures without abandoning registry consistency", () => {
        const registry = createSettingsPanelRegistry();
        const scope = {};
        let fail = false;
        const unsubscribe = registry.subscribe(scope, () => {
            if (fail) throw new Error("listener failed");
        });
        fail = true;
        assert.throws(() => registry.register(scope, section("broken")), {
            name: "AggregateError",
            message: /Settings panel registry listeners failed/,
        });
        assert.equal(registry.getSections(scope).length, 0);

        fail = false;
        const release = registry.register(scope, section("kept"));
        fail = true;
        assert.throws(() => release(), {
            name: "AggregateError",
            message: /Settings panel registry listeners failed/,
        });
        assert.equal(registry.getSections(scope).length, 0);
        unsubscribe();
    });

    test("shares section discovery and notifications across loaded Core copies", async (t) => {
        const copy = await import(new URL("../src/panel/host.ts?copy=1", import.meta.url).href);
        const registry = getSettingsPanelRegistry();
        const copiedRegistry = copy.getSettingsPanelRegistry();
        assert.strictEqual(copiedRegistry, registry);

        const scope = {};
        const observed: string[][] = [];
        const unsubscribe = copiedRegistry.subscribe(scope, () => {
            observed.push(copiedRegistry.getSections(scope).map(({ id }: SettingsSection) => id));
        });
        t.after(unsubscribe);
        const registered = section("shared");
        const release = registry.register(scope, registered);
        t.after(release);

        assert.deepEqual(copiedRegistry.getSections(scope), [registered]);
        assert.deepEqual(copiedRegistry.getSections({}), []);
        release();
        assert.deepEqual(copiedRegistry.getSections(scope), []);
        assert.deepEqual(observed, [["shared"], []]);
    });
});
