import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import { defineSettings } from "../src/settings/index.ts";
import { createSettingsSandbox } from "../src/testing/index.ts";
import { defineSettingsPanel } from "../src/panel/index.ts";
import { openSettingsPanel } from "../src/panel/tui.ts";
import { createDefinedSettingsSection, registerSettingsSection } from "../src/panel/host.ts";
import {
    createSettingsMenuField,
    resolveSettingsFieldOptions,
    type SettingsMenu,
    type SettingsPanelField,
    type SettingsPanelSchema,
    type SettingsSection,
} from "../src/panel/section.ts";
import type { SettingsScope } from "../src/settings/types.ts";

const keys = {
    enter: "\r",
    escape: "\x1b",
    up: "\x1b[A",
    down: "\x1b[B",
    tab: "\t",
    scope: "\x07",
    reset: "\x12",
};
const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

class PanelUi {
    panel: (Component & { dispose?: () => void; focused?: boolean }) | undefined;
    closed = false;
    private readonly renderWaiters = new Set<() => void>();
    readonly tui = {
        requestRender: () => {
            for (const check of [...this.renderWaiters]) check();
        },
    } as unknown as TUI;

    async custom(
        factory: (tui: TUI, theme: Theme, keybindings: unknown, done: () => void) => Component,
    ): Promise<void> {
        await new Promise<void>((resolve) => {
            this.panel = factory(this.tui, theme, {}, () => {
                this.closed = true;
                resolve();
            });
            this.panel.focused = true;
        });
    }
    lines(width = 100): string[] {
        return this.panel!.render(width).map(stripTerminalSequences);
    }
    text(): string {
        return this.lines().join("\n");
    }
    press(...inputs: string[]): void {
        for (const input of inputs) this.panel!.handleInput!(input);
    }
    title(): string {
        return this.lines()[1]!;
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
    selected(): string | undefined {
        return this.lines()
            .map((line) => /^→ (\w+)/.exec(line)?.[1])
            .find(Boolean);
    }
    row(label: string): string | undefined {
        return this.lines()
            .slice(4)
            .find((line) => new RegExp(`^(→ )?${label}\\b`).test(line.trim()));
    }
}

/** A text field backed by one in-memory value per scope. */
function textField(id: string, log: string[] = []): SettingsPanelField {
    const values: Partial<Record<SettingsScope, string>> = {};
    return {
        id,
        label: id,
        schema: Type.String() as SettingsPanelSchema,
        scopes: ["global", "project"],
        inspect: () => ({
            defaultValue: "",
            globalValue: values.global,
            projectValue: values.project,
            value: values.project ?? values.global ?? "",
            source: "default",
        }),
        set: async (value, scope) => {
            log.push(`set ${id}=${String(value)}@${scope}`);
            values[scope] = value as string;
        },
        reset: async (scope) => {
            log.push(`reset ${id}@${scope}`);
            delete values[scope];
        },
    };
}

function menuField(
    id: string,
    menu: (scope: SettingsScope) => SettingsMenu,
    summary?: () => string,
) {
    return createSettingsMenuField({
        id,
        label: id,
        scopes: ["global", "project"],
        summary: summary && (() => summary()),
        menu: (_ctx, scope) => menu(scope),
    });
}

function section(id: string, fields: SettingsPanelField[]) {
    const listeners = new Set<() => void>();
    const result: SettingsSection = {
        id,
        label: id,
        fields,
        scopes: ["global", "project"],
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        reload: async () => {},
    };
    return { section: result, notify: () => listeners.forEach((listener) => listener()) };
}

function open(t: TestContext, ...sections: SettingsSection[]) {
    const ui = new PanelUi();
    const ctx = { mode: "tui", hasUI: true, cwd: "/unused", ui } as unknown as ExtensionContext;
    const releases = sections.map((entry) => registerSettingsSection(ui, entry));
    void openSettingsPanel(ctx, { section: sections[0]!.id });
    t.after(() => {
        ui.panel?.dispose?.();
        releases.forEach((release) => release());
    });
    return ui;
}

describe("secondary menus in the panel", () => {
    test("Enter opens a menu row that shows an arrow and its summary; Esc returns to it, then closes the panel", (t) => {
        const { section: s } = section("menus", [
            textField("Plain"),
            menuField(
                "Agents",
                () => ({ fields: [textField("Alpha")] }),
                () => "2 agents",
            ),
        ]);
        const ui = open(t, s);

        assert.match(ui.row("Agents")?.trim() ?? "", /^Agents →\s+2 agents$/);
        assert.equal(ui.title(), "Lune settings · global");

        ui.press(keys.down, keys.enter);
        assert.equal(ui.title(), "Lune settings › Agents · global");
        assert.ok(ui.row("Alpha"));
        assert.equal(ui.row("Plain"), undefined);

        ui.press(keys.escape);
        assert.equal(ui.title(), "Lune settings · global");
        assert.equal(ui.selected(), "Agents");
        assert.equal(ui.closed, false);

        ui.press(keys.escape);
        assert.equal(ui.closed, true);
    });

    test("nested menus extend the title and Esc steps back one level at a time", (t) => {
        const { section: s } = section("menus", [
            menuField("Agents", () => ({
                fields: [menuField("Deep", () => ({ fields: [textField("Leaf")] }))],
            })),
        ]);
        const ui = open(t, s);

        ui.press(keys.enter, keys.enter);
        assert.equal(ui.title(), "Lune settings › Agents › Deep · global");
        assert.ok(ui.row("Leaf"));

        ui.press(keys.escape);
        assert.equal(ui.title(), "Lune settings › Agents · global");
        assert.equal(ui.selected(), "Deep");
        ui.press(keys.escape);
        assert.equal(ui.title(), "Lune settings · global");
        assert.equal(ui.closed, false);
    });

    test("fields inside a menu are edited through their own set and reset", async (t) => {
        const log: string[] = [];
        const { section: s } = section("menus", [
            menuField("Agents", () => ({ fields: [textField("Alpha", log)] })),
        ]);
        const ui = open(t, s);

        ui.press(keys.enter, keys.enter, ..."hi", keys.enter);
        await new Promise((resolve) => setImmediate(resolve));
        ui.press(keys.reset);
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(log, ["set Alpha=hi@global", "reset Alpha@global"]);
    });

    test("an open menu is rebuilt on every refresh and follows changes to its rows", (t) => {
        let names = ["Alpha"];
        const { section: s, notify } = section("menus", [
            menuField("Agents", () => ({ fields: names.map((name) => textField(name)) })),
        ]);
        const ui = open(t, s);

        ui.press(keys.enter);
        assert.ok(ui.row("Alpha"));

        names = ["Alpha", "Beta"];
        notify();
        assert.ok(ui.row("Beta"));

        names = ["Beta"];
        notify();
        assert.equal(ui.row("Alpha"), undefined);
        assert.ok(ui.row("Beta"));
    });

    test("when the row of a nested menu disappears the panel falls back to the parent menu", (t) => {
        let showDeep = true;
        const { section: s, notify } = section("menus", [
            menuField("Agents", () => ({
                fields: showDeep
                    ? [
                          menuField("Deep", () => ({ fields: [textField("Leaf")] })),
                          textField("Alpha"),
                      ]
                    : [textField("Alpha")],
            })),
        ]);
        const ui = open(t, s);

        ui.press(keys.enter, keys.enter);
        assert.equal(ui.title(), "Lune settings › Agents › Deep · global");

        showDeep = false;
        notify();

        assert.equal(ui.title(), "Lune settings › Agents · global");
        assert.ok(ui.row("Alpha"));
    });

    test("the open path survives a Ctrl+G scope switch and rebuilds the menu for the new scope", (t) => {
        const scopes: SettingsScope[] = [];
        const { section: s } = section("menus", [
            menuField("Agents", (scope) => {
                scopes.push(scope);
                return { fields: [textField(`In${scope}`)] };
            }),
        ]);
        const ui = open(t, s);

        ui.press(keys.enter);
        assert.ok(ui.row("Inglobal"));
        ui.press(keys.scope);

        assert.equal(ui.title(), "Lune settings › Agents · project");
        assert.ok(ui.row("Inproject"));
        assert.equal(scopes.at(-1), "project");
    });

    test("Ctrl+R on a menu row names the menu and resets nothing", (t) => {
        const log: string[] = [];
        const { section: s } = section("menus", [
            menuField("Agents", () => ({ fields: [textField("Alpha", log)] })),
        ]);
        const ui = open(t, s);

        ui.press(keys.reset);

        assert.match(ui.text(), /Open Agents to reset the settings in it/);
        assert.deepEqual(log, []);
    });

    test("Tab closes every open menu: coming back to the section shows its top level", (t) => {
        const { section: first } = section("first", [
            menuField("Agents", () => ({
                fields: [menuField("Deep", () => ({ fields: [textField("Leaf")] }))],
            })),
        ]);
        const { section: second } = section("second", [textField("Other")]);
        const ui = open(t, first, second);

        ui.press(keys.enter, keys.enter);
        assert.equal(ui.title(), "Lune settings › Agents › Deep · global");

        ui.press(keys.tab);
        assert.ok(ui.row("Other"));
        ui.press(keys.tab);

        assert.equal(ui.title(), "Lune settings · global");
        assert.ok(ui.row("Agents"));
    });

    test("an empty menu shows its message, or a default one", (t) => {
        const { section: s } = section("menus", [
            menuField("Custom", () => ({ fields: [], emptyMessage: "No agents yet." })),
            menuField("Plain", () => ({ fields: [] })),
        ]);
        const ui = open(t, s);

        ui.press(keys.enter);
        assert.match(ui.text(), /No agents yet\./);
        ui.press(keys.escape, keys.down, keys.enter);
        assert.match(ui.text(), /This menu is empty\./);
    });

    test("a menu that throws reports the error and stays at the parent", (t) => {
        const { section: s } = section("menus", [
            menuField("Broken", () => {
                throw new Error("disk gone");
            }),
        ]);
        const ui = open(t, s);

        ui.press(keys.enter);

        assert.match(ui.text(), /Could not open Broken: disk gone/);
        assert.equal(ui.title(), "Lune settings · global");
        assert.ok(ui.row("Broken"));
    });
});

describe("menu fields", () => {
    const options = {
        id: "m",
        label: "M",
        scopes: ["global"] as const,
        menu: () => ({ fields: [] }),
    };

    test("a menu field has no value: set and reset reject and the summary is the displayed value", async () => {
        const field = createSettingsMenuField({ ...options, summary: () => "3 entries" });

        assert.equal(field.editor, "menu");
        assert.equal(field.formatValue?.(undefined, {} as ExtensionContext, "global"), "3 entries");
        await assert.rejects(field.set("x", "global"), {
            name: "TypeError",
            message: /M is a menu/,
        });
        await assert.rejects(field.reset("global"), { name: "TypeError", message: /M is a menu/ });
    });

    test("a menu field without a summary shows an empty value", () => {
        const field = createSettingsMenuField(options);

        assert.equal(field.formatValue?.(undefined, {} as ExtensionContext, "global"), "");
    });

    test("a menu cannot be combined with another editor kind, choices, secrets or previews", () => {
        const schema = Type.Null() as SettingsPanelSchema;
        const menu = () => ({ fields: [] });

        assert.throws(() => resolveSettingsFieldOptions("m", schema, { menu, editor: "text" }), {
            message: 'Menu "m" conflicts with editor "text"',
        });
        for (const extra of [
            { customEditor: () => ({}) },
            { choices: [{ value: 1, label: "one" }] },
            { choiceSource: {} },
            { secret: true },
            { preview: {} },
        ])
            assert.throws(
                () =>
                    resolveSettingsFieldOptions("m", schema, { menu, ...extra } as Record<
                        string,
                        unknown
                    >),
                {
                    message: /cannot use a custom editor, choices, secret or a preview/,
                },
            );
    });

    test('editor "menu" requires a menu function', () => {
        assert.throws(
            () =>
                resolveSettingsFieldOptions("m", Type.Null() as SettingsPanelSchema, {
                    editor: "menu",
                }),
            { message: 'Editor "menu" requires a menu for "m"' },
        );
    });
});

describe("menus in panel definitions", () => {
    const schema = Type.Object({
        mode: Type.String({ default: "basic" }),
        count: Type.Integer({ default: 1 }),
        nested: Type.Object({ deep: Type.String({ default: "" }) }, { default: { deep: "" } }),
    });

    async function views(t: TestContext) {
        const sandbox = await createSettingsSandbox({ prefix: "lune-menus-" });
        t.after(() => sandbox.dispose());
        const definition = defineSettings({ id: "menus", schema });
        const lease = await sandbox.acquire(definition, { projectTrusted: true });
        await lease.settings.set("mode", "global-mode", { scope: "global" });
        await lease.settings.set("count", 5, { scope: "project" });
        return { definition, settings: lease.settings };
    }
    const open_ = () => ({ fields: [] });

    test("defineSettingsPanel rejects empty ids and labels", async (t) => {
        const { definition } = await views(t);

        for (const menu of [
            { id: " ", label: "Agents", open: open_ },
            { id: "agents", label: "", open: open_ },
        ])
            assert.throws(() => defineSettingsPanel(definition, { label: "P", menus: [menu] }), {
                name: "TypeError",
                message: "Settings menu id and label must not be empty",
            });
    });

    test("defineSettingsPanel rejects an id used by a field path, a nested path or another menu", async (t) => {
        const { definition } = await views(t);
        const menu = (id: string) => ({ id, label: "Agents", open: open_ });

        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    fields: [{ path: "mode" }],
                    menus: [menu("mode")],
                }),
            { name: "TypeError", message: 'Duplicate settings panel id "mode"' },
        );
        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    fields: [{ path: ["nested", "deep"] }],
                    menus: [menu('["nested","deep"]')],
                }),
            { name: "TypeError", message: /Duplicate settings panel id/ },
        );
        assert.throws(
            () => defineSettingsPanel(definition, { label: "P", menus: [menu("a"), menu("a")] }),
            { name: "TypeError", message: 'Duplicate settings panel id "a"' },
        );
    });

    test("defineSettingsPanel rejects a menu without open and non-function callbacks", async (t) => {
        const { definition } = await views(t);

        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    menus: [{ id: "a", label: "A" } as never],
                }),
            {
                name: "TypeError",
                message:
                    'Settings menu "a" requires an open function or fields that name it in inMenu',
            },
        );
        for (const name of ["visible", "disabled", "summary"])
            assert.throws(
                () =>
                    defineSettingsPanel(definition, {
                        label: "P",
                        menus: [{ id: "a", label: "A", open: open_, [name]: "no" } as never],
                    }),
                {
                    name: "TypeError",
                    message: `Settings ${name} for menu "a" must be a function`,
                },
            );
    });

    test("groups follow the field-then-menu order: a menu cannot reopen an earlier group", async (t) => {
        const { definition } = await views(t);

        assert.doesNotThrow(() =>
            defineSettingsPanel(definition, {
                label: "P",
                fields: [{ path: "mode", group: "A" }],
                menus: [{ id: "a", label: "A", group: "A", open: open_ }],
            }),
        );
        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    fields: [
                        { path: "mode", group: "A" },
                        { path: "count", group: "B" },
                    ],
                    menus: [{ id: "a", label: "A", group: "A", open: open_ }],
                }),
            { name: "TypeError", message: 'Settings group "A" must list its fields together' },
        );
        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    fields: [{ path: "mode", group: "A" }],
                    menus: [{ id: "a", label: "A", open: open_ }],
                }),
            {
                name: "TypeError",
                message: /Ungrouped settings must come before group "A"/,
            },
        );
    });

    test("a defined panel without menus has an empty menu list", async (t) => {
        const { definition } = await views(t);

        assert.deepEqual(defineSettingsPanel(definition, { label: "P" }).menus, []);
    });

    test("menus become rows after the fields, with the view's scopes and scoped value copies", async (t) => {
        const { definition, settings } = await views(t);
        const ctx = { cwd: "/unused" } as unknown as ExtensionContext;
        const calls: { fn: string; scope: SettingsScope; values: unknown; context: unknown }[] = [];
        const record =
            (fn: string, result: unknown) =>
            (c: { scope: SettingsScope; values: { mode: string }; context: unknown }) => {
                calls.push({ fn, scope: c.scope, values: { ...c.values }, context: c.context });
                c.values.mode = "tampered";
                return result;
            };
        const panel = defineSettingsPanel(definition, {
            label: "P",
            fields: [{ path: "mode" }],
            menus: [
                {
                    id: "agents",
                    label: "Agents",
                    description: "Custom agents",
                    visible: record("visible", true) as never,
                    disabled: record("disabled", "locked") as never,
                    summary: record("summary", "2 agents") as never,
                    open: record("open", { fields: [] }) as never,
                },
            ],
        });
        const mapped = createDefinedSettingsSection(settings, panel);
        const row = mapped.fields.at(-1)!;

        assert.deepEqual(
            mapped.fields.map((field) => field.id),
            ["mode", "agents"],
        );
        assert.equal(row.editor, "menu");
        assert.equal(row.description, "Custom agents");
        assert.deepEqual(row.scopes, settings.scopes);
        assert.equal(row.visible?.(ctx, "project"), true);
        assert.equal(row.disabled?.(ctx, "global"), "locked");
        assert.equal(row.formatValue?.(undefined, ctx, "project"), "2 agents");
        assert.deepEqual(row.menu?.(ctx, "global"), { fields: [] });

        assert.deepEqual(
            calls.map(({ fn, scope, values }) => ({
                fn,
                scope,
                mode: (values as { mode: string }).mode,
            })),
            [
                { fn: "visible", scope: "project", mode: "global-mode" },
                { fn: "disabled", scope: "global", mode: "global-mode" },
                { fn: "summary", scope: "project", mode: "global-mode" },
                { fn: "open", scope: "global", mode: "global-mode" },
            ],
        );
        assert.ok(calls.every((call) => call.context === ctx));
        assert.equal(settings.get("mode"), "global-mode");
    });

    test("a menu without callbacks maps to a row that is visible, enabled and has no summary", async (t) => {
        const { definition, settings } = await views(t);
        const ctx = { cwd: "/unused" } as unknown as ExtensionContext;
        const panel = defineSettingsPanel(definition, {
            label: "P",
            menus: [{ id: "agents", label: "Agents", open: open_ }],
        });
        const row = createDefinedSettingsSection(settings, panel).fields.at(-1)!;

        assert.equal(row.visible, undefined);
        assert.equal(row.disabled, undefined);
        assert.equal(row.formatValue?.(undefined, ctx, "global"), "");
    });
});

describe("fields listed in a menu with inMenu", () => {
    const schema = Type.Object({
        mode: Type.String({ default: "basic" }),
        alpha: Type.String({ default: "a0" }),
        beta: Type.String({ default: "b0" }),
    });

    async function views(t: TestContext) {
        const sandbox = await createSettingsSandbox({ prefix: "lune-inmenu-" });
        t.after(() => sandbox.dispose());
        const definition = defineSettings({ id: "inmenu", schema });
        const lease = await sandbox.acquire(definition, { projectTrusted: true });
        return { definition, settings: lease.settings };
    }

    test("a menu with open and fields naming it is rejected", async (t) => {
        const { definition } = await views(t);

        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    fields: [{ path: "alpha", inMenu: "m" }],
                    menus: [{ id: "m", label: "M", open: () => ({ fields: [] }) }],
                }),
            {
                name: "TypeError",
                message: 'Settings menu "m" has an open function and fields that name it; use one',
            },
        );
    });

    test("a menu without open needs at least one field that names it", async (t) => {
        const { definition } = await views(t);

        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    fields: [{ path: "alpha" }],
                    menus: [{ id: "m", label: "M" }],
                }),
            {
                name: "TypeError",
                message:
                    'Settings menu "m" requires an open function or fields that name it in inMenu',
            },
        );
    });

    test("a field that names an unknown menu is rejected", async (t) => {
        const { definition } = await views(t);

        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    fields: [{ path: "alpha", inMenu: "nope" }],
                    menus: [{ id: "m", label: "M", open: () => ({ fields: [] }) }],
                }),
            { name: "TypeError", message: 'Settings field "alpha" names unknown menu "nope"' },
        );
    });

    test("groups are checked on the menu's own fields and on the top level separately", async (t) => {
        const { definition } = await views(t);

        // Same group name inside the menu and at the top level is fine: they are separate lists.
        assert.doesNotThrow(() =>
            defineSettingsPanel(definition, {
                label: "P",
                fields: [
                    { path: "mode", group: "G" },
                    { path: "alpha", inMenu: "m", group: "G" },
                ],
                menus: [{ id: "m", label: "M", group: "G" }],
            }),
        );
        // A menu's fields cannot split a group.
        assert.throws(
            () =>
                defineSettingsPanel(definition, {
                    label: "P",
                    fields: [
                        { path: "alpha", inMenu: "m", group: "G" },
                        { path: "beta", inMenu: "m", group: "H" },
                        { path: "mode", inMenu: "m", group: "G" },
                    ],
                    menus: [{ id: "m", label: "M" }],
                }),
            { name: "TypeError", message: 'Settings group "G" must list its fields together' },
        );
        // Fields in a menu do not count against the top-level group order.
        assert.doesNotThrow(() =>
            defineSettingsPanel(definition, {
                label: "P",
                fields: [
                    { path: "mode", group: "G" },
                    { path: "alpha", inMenu: "m" },
                ],
                menus: [{ id: "m", label: "M", group: "G" }],
            }),
        );
    });

    test("the section lists only the top-level fields and the menu row, and the menu page lists its fields", async (t) => {
        const { definition, settings } = await views(t);
        const panel = defineSettingsPanel(definition, {
            label: "P",
            fields: [
                { path: "mode" },
                { path: "alpha", inMenu: "m" },
                { path: "beta", inMenu: "m" },
            ],
            menus: [{ id: "m", label: "M" }],
        });
        const mapped = createDefinedSettingsSection(settings, panel);
        const ctx = { cwd: "/unused" } as unknown as ExtensionContext;

        assert.deepEqual(
            mapped.fields.map((field) => field.id),
            ["mode", "m"],
        );
        const page = mapped.fields.at(-1)!.menu?.(ctx, "global");
        assert.deepEqual(
            page?.fields.map((field) => field.id),
            ["alpha", "beta"],
        );
    });

    test("opening the menu shows its fields, and an edit there saves to the settings", async (t) => {
        const { definition, settings } = await views(t);
        const panel = defineSettingsPanel(definition, {
            label: "P",
            fields: [
                { path: "mode" },
                { path: "alpha", inMenu: "m" },
                { path: "beta", inMenu: "m" },
            ],
            menus: [{ id: "m", label: "M" }],
        });
        const ui = open(t, createDefinedSettingsSection(settings, panel));

        assert.ok(ui.row("mode"));
        assert.equal(ui.row("alpha"), undefined);
        assert.equal(ui.row("beta"), undefined);

        ui.press(keys.down, keys.enter);
        assert.equal(ui.title(), "Lune settings › M · global");
        assert.ok(ui.row("alpha"));
        assert.ok(ui.row("beta"));
        assert.equal(ui.row("mode"), undefined);

        ui.press(keys.enter, ..."xyz", keys.enter);
        await ui.waitFor(() => !ui.text().includes("Saving / loading"));
        const actual = settings.get("alpha");
        assert.ok(typeof actual === "string" && actual.includes("xyz"), `alpha was ${actual}`);
        assert.equal(settings.get("beta"), "b0");
    });
});
