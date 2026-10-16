import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { Type } from "typebox";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component, type TUI } from "@earendil-works/pi-tui";
import { defineSettings } from "../src/settings/index.ts";
import { createSettingsSandbox } from "../src/testing/index.ts";
import { defineSettingsPanel } from "../src/panel/index.ts";
import { openSettingsPanel } from "../src/panel/tui.ts";
import {
    createDefinedSettingsSection,
    createSettingsSection,
    registerSettingsSection,
} from "../src/panel/host.ts";
import type {
    SettingsChoiceContext,
    SettingsCustomEditorContext,
    SettingsEditorComponent,
    SettingsPanelField,
    SettingsSection,
} from "../src/panel/section.ts";
import type { SettingsScope } from "../src/settings/types.ts";

const keys = {
    enter: "\r",
    escape: "\x1b",
    up: "\x1b[A",
    down: "\x1b[B",
    left: "\x1b[D",
    right: "\x1b[C",
    scope: "\x07",
    reset: "\x12",
    space: " ",
};
const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

class PanelUi {
    panel: (Component & { dispose?: () => void; focused?: boolean }) | undefined;
    renders = 0;
    private readonly waiters = new Set<() => void>();
    readonly tui = {
        requestRender: () => {
            this.renders++;
            for (const check of [...this.waiters]) check();
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
    lines(width = 100): string[] {
        return this.panel!.render(width).map(stripTerminalSequences);
    }
    text(width = 100): string {
        return this.lines(width).join("\n");
    }
    press(...inputs: string[]): void {
        for (const input of inputs) this.panel!.handleInput!(input);
    }
    settled(): Promise<void> {
        const done = () => !this.text().includes("Saving / loading");
        if (done()) return Promise.resolve();
        return new Promise((resolve) => {
            const check = () => {
                if (!done()) return;
                this.waiters.delete(check);
                resolve();
            };
            this.waiters.add(check);
        });
    }
    /** Label of the highlighted list row (labels in these tests are single words). */
    selected(): string | undefined {
        return this.lines()
            .map((line) => /^→ (\w+)/.exec(line)?.[1])
            .find(Boolean);
    }
    /** Row text for a field label, including its description column. */
    row(label: string): string | undefined {
        return this.lines()
            .slice(4)
            .find((line) => new RegExp(`^(→ )?${label}\\b`).test(line.trim()));
    }
    title(): string {
        return this.lines()[1]!;
    }
    help(): string {
        const lines = this.lines();
        return lines[lines.length - 2]!;
    }
}

interface Spec {
    id: string;
    group?: string;
    scopes?: readonly SettingsScope[];
    schema?: SettingsPanelField["schema"];
    initial?: unknown;
    visible?: (scope: SettingsScope) => boolean;
    disabled?: (scope: SettingsScope) => string | undefined;
    customEditor?: SettingsPanelField["customEditor"];
    failSet?: string;
}

// In-memory section so renderer behavior is driven without storage or timing.
function fakeSection(id: string, specs: Spec[]) {
    const store = new Map<string, { global?: unknown; project?: unknown; initial: unknown }>();
    const listeners = new Set<() => void>();
    const sets: { id: string; value: unknown; scope: SettingsScope }[] = [];
    const resets: { id: string; scope: SettingsScope }[] = [];
    const notify = () => listeners.forEach((listener) => listener());
    const read = (field: string, scope: SettingsScope) => {
        const entry = store.get(field)!;
        return scope === "project" && entry.project !== undefined
            ? entry.project
            : (entry.global ?? entry.initial);
    };
    const fields = specs.map((spec): SettingsPanelField => {
        store.set(spec.id, { initial: spec.initial ?? "" });
        return {
            id: spec.id,
            label: spec.id,
            schema: spec.schema ?? Type.String(),
            group: spec.group,
            scopes: spec.scopes ?? ["global", "project"],
            editor: spec.customEditor ? "custom" : undefined,
            visible: spec.visible ? (_ctx, scope) => spec.visible!(scope) : undefined,
            disabled: spec.disabled ? (_ctx, scope) => spec.disabled!(scope) : undefined,
            customEditor: spec.customEditor,
            inspect: () => {
                const entry = store.get(spec.id)!;
                return {
                    defaultValue: entry.initial,
                    globalValue: entry.global,
                    projectValue: entry.project,
                    value: entry.project ?? entry.global ?? entry.initial,
                    source: "default",
                };
            },
            set: async (value, scope) => {
                sets.push({ id: spec.id, value, scope });
                if (spec.failSet) throw new Error(spec.failSet);
                store.get(spec.id)![scope] = value;
                notify();
            },
            reset: async (scope) => {
                resets.push({ id: spec.id, scope });
                store.get(spec.id)![scope] = undefined;
                notify();
            },
        };
    });
    const section: SettingsSection = {
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
    return {
        section,
        sets,
        resets,
        read,
        /** Change a stored value from outside the panel and notify subscribers. */
        write: (field: string, value: unknown, scope: SettingsScope = "global") => {
            store.get(field)![scope] = value;
            notify();
        },
    };
}

type Api = Pick<ReturnType<typeof fakeSection>, "read" | "write">;

function open(t: TestContext, specsOrFactory: Spec[] | ((api: Api) => Spec[])) {
    // Callbacks need the store that is created from the specs, so they bind to it lazily.
    const api = {} as Api;
    const specs = typeof specsOrFactory === "function" ? specsOrFactory(api) : specsOrFactory;
    const ui = new PanelUi();
    const fake = fakeSection("fake", specs);
    Object.assign(api, { read: fake.read, write: fake.write });
    const ctx = { mode: "tui", hasUI: true, cwd: "/unused", ui } as unknown as ExtensionContext;
    const release = registerSettingsSection(ui, fake.section);
    void openSettingsPanel(ctx, { section: "fake" });
    t.after(() => {
        ui.panel?.dispose?.();
        release();
    });
    return { ui, ctx, ...fake };
}

describe("field groups in the panel", () => {
    const grouped: Spec[] = [
        { id: "Top" },
        { id: "Host", group: "Network" },
        { id: "Port", group: "Network" },
        { id: "Theme", group: "Display" },
    ];

    test("renders a heading before the first field of each group only", (t) => {
        const { ui } = open(t, grouped);
        const labels = ui.lines().map(
            (line) =>
                line
                    .replace(/^[→ ] ?/, "")
                    .trim()
                    .split(/\s{2,}/)[0],
        );
        const start = labels.indexOf("Top");
        assert.deepEqual(labels.slice(start, start + 6), [
            "Top",
            "Network",
            "Host",
            "Port",
            "Display",
            "Theme",
        ]);
    });

    test("initial selection is the first field and navigation steps over headings in both directions", (t) => {
        const { ui } = open(t, grouped);
        const visited = [ui.selected()];
        for (let step = 0; step < 4; step++) {
            ui.press(keys.down);
            visited.push(ui.selected());
        }
        assert.deepEqual(visited, ["Top", "Host", "Port", "Theme", "Top"]);
        ui.press(keys.up);
        assert.equal(ui.selected(), "Theme");
        ui.press(keys.up, keys.up);
        assert.equal(ui.selected(), "Host");
    });

    test("when every field is grouped the first selection skips the leading heading and wrap-around lands on fields", (t) => {
        const { ui } = open(t, [
            { id: "Host", group: "Network" },
            { id: "Theme", group: "Display" },
        ]);
        assert.equal(ui.selected(), "Host");
        ui.press(keys.up);
        assert.equal(ui.selected(), "Theme");
        ui.press(keys.down);
        assert.equal(ui.selected(), "Host");
    });

    test("a group whose fields are all hidden loses its heading", (t) => {
        const { ui } = open(t, [
            { id: "Top" },
            { id: "Host", group: "Network", visible: () => false },
            { id: "Theme", group: "Display" },
        ]);
        const text = ui.text();
        assert.doesNotMatch(text, /Network/);
        assert.match(text, /Display/);
        ui.press(keys.down);
        assert.equal(ui.selected(), "Theme");
    });

    test("the heading precedes the first visible field when earlier group members are hidden", (t) => {
        const { ui } = open(t, [
            { id: "Host", group: "Network", visible: () => false },
            { id: "Port", group: "Network" },
        ]);
        const labels = ui.lines().map(
            (line) =>
                line
                    .replace(/^[→ ] ?/, "")
                    .trim()
                    .split(/\s{2,}/)[0],
        );
        assert.ok(labels.indexOf("Network") < labels.indexOf("Port"));
        assert.equal(ui.selected(), "Port");
    });
});

describe("conditional visibility", () => {
    test("hides a field when visible returns false while keeping its stored value", (t) => {
        const { ui, sets } = open(t, (api) => [
            { id: "Mode", initial: "basic" },
            {
                id: "Extra",
                initial: "kept",
                visible: () => api.read("Mode", "global") === "advanced",
            },
        ]);
        assert.equal(ui.row("Extra"), undefined);
        ui.press(keys.enter);
        ui.press("\x1b[F", ...Array(5).fill("\x7f"), ..."advanced", keys.enter);
        return ui.settled().then(() => {
            assert.deepEqual(sets, [{ id: "Mode", value: "advanced", scope: "global" }]);
            assert.match(ui.row("Extra") ?? "", /kept/);
            ui.press(keys.down, keys.enter);
            assert.equal(ui.title(), "Extra · global");
        });
    });

    test("re-evaluates visibility after another field changes and after an external update", (t) => {
        const { ui, write } = open(t, (api) => [
            { id: "Mode", initial: "basic" },
            { id: "Extra", visible: () => api.read("Mode", "global") === "advanced" },
        ]);
        assert.equal(ui.row("Extra"), undefined);
        write("Mode", "advanced");
        assert.ok(ui.row("Extra"));
        write("Mode", "basic");
        assert.equal(ui.row("Extra"), undefined);
    });

    test("passes the current scope to visible and refreshes on a Ctrl+G scope switch", (t) => {
        const { ui } = open(t, [
            { id: "Always" },
            { id: "ProjectOnly", visible: (scope) => scope === "project" },
        ]);
        assert.equal(ui.row("ProjectOnly"), undefined);
        ui.press(keys.scope);
        assert.ok(ui.row("ProjectOnly"));
        ui.press(keys.scope);
        assert.equal(ui.row("ProjectOnly"), undefined);
    });

    test("explains that nothing applies when every field is hidden", (t) => {
        const { ui } = open(t, [
            { id: "A", visible: () => false },
            { id: "B", visible: () => false },
        ]);
        assert.match(ui.text(), /No settings in this section apply right now\./);
        ui.press(keys.enter, keys.down, keys.reset);
        assert.match(ui.text(), /No settings in this section apply right now\./);
    });

    test("a throwing visible keeps the field listed and reports the failure", (t) => {
        const { ui } = open(t, [
            {
                id: "Flaky",
                visible: () => {
                    throw new Error("boom");
                },
            },
            { id: "Other" },
        ]);
        assert.ok(ui.row("Flaky"));
        assert.match(ui.text(), /Could not check whether to show Flaky: boom/);
        assert.ok(ui.row("Other"));
    });

    test("an input opened on a field keeps saving to it after a refresh hides the field", async (t) => {
        let shown = true;
        const { ui, sets, write, read } = open(t, [
            { id: "Name", initial: "old", visible: () => shown },
            { id: "Other" },
        ]);
        ui.press(keys.enter);
        assert.equal(ui.title(), "Name · global");
        shown = false;
        write("Other", "changed");
        assert.equal(ui.row("Name"), undefined);
        ui.press("\x1b[F", "!");
        ui.press(keys.enter);
        await ui.settled();
        assert.deepEqual(sets, [{ id: "Name", value: "old!", scope: "global" }]);
        assert.equal(read("Name", "global"), "old!");
    });

    test("number and JSON inputs also save to the field captured at entry", async (t) => {
        let shown = true;
        const { ui, sets, write } = open(t, [
            { id: "Count", initial: 1, schema: Type.Integer(), visible: () => shown },
            { id: "Tags", initial: ["a"], schema: Type.Array(Type.String()), visible: () => shown },
            { id: "Other" },
        ]);
        ui.press(keys.enter);
        shown = false;
        write("Other", "x");
        ui.press("\x1b[F", "\x7f", "7", keys.enter);
        await ui.settled();
        shown = true;
        write("Other", "y");
        // The refresh left the selection on Other, so Tags is two steps down.
        ui.press(keys.down, keys.down, keys.enter);
        assert.equal(ui.title(), "Tags · global");
        shown = false;
        write("Other", "z");
        ui.press("\x1b[F", "\x7f", `,"b"]`, keys.enter);
        await ui.settled();
        assert.deepEqual(sets, [
            { id: "Count", value: 7, scope: "global" },
            { id: "Tags", value: ["a", "b"], scope: "global" },
        ]);
    });
});

describe("conditional disabling", () => {
    test("shows the reason on the row and refuses Enter, Space and Ctrl+R with that reason", async (t) => {
        const { ui, sets, resets } = open(t, [
            { id: "Locked", disabled: () => "Turn on Mode first" },
            { id: "Free" },
        ]);
        assert.match(ui.row("Locked") ?? "", /Turn on Mode first/);
        for (const key of [keys.enter, keys.space, keys.reset]) {
            ui.press(key);
            assert.match(ui.text(), /Turn on Mode first/);
            assert.equal(ui.title(), "Lune settings · global");
        }
        await ui.settled();
        assert.deepEqual(sets, []);
        assert.deepEqual(resets, []);
    });

    test("the refusal is shown as an error line, not only the row description", (t) => {
        const { ui } = open(t, [{ id: "Locked", disabled: () => "Read-only for now" }]);
        const before = ui.lines().filter((line) => line.includes("Read-only for now")).length;
        ui.press(keys.enter);
        const after = ui.lines().filter((line) => line.includes("Read-only for now")).length;
        assert.equal(before, 1);
        assert.equal(after, 2);
    });

    test("re-enables editing once the condition clears and the field is refreshed", async (t) => {
        const { ui, write, sets } = open(t, (api) => [
            { id: "Mode", initial: "off" },
            {
                id: "Target",
                initial: "a",
                disabled: () => (api.read("Mode", "global") === "off" ? "Mode is off" : undefined),
            },
        ]);
        ui.press(keys.down, keys.enter);
        assert.match(ui.text(), /Mode is off/);
        write("Mode", "on");
        assert.doesNotMatch(ui.row("Target") ?? "", /Mode is off/);
        ui.press(keys.enter);
        assert.equal(ui.title(), "Target · global");
        ui.press("\x1b[F", "b", keys.enter);
        await ui.settled();
        assert.deepEqual(sets, [{ id: "Target", value: "ab", scope: "global" }]);
    });

    test("passes the current scope to disabled", (t) => {
        const { ui } = open(t, [
            {
                id: "Field",
                disabled: (scope) => (scope === "project" ? "Global only here" : undefined),
            },
        ]);
        assert.doesNotMatch(ui.row("Field") ?? "", /Global only here/);
        ui.press(keys.scope);
        assert.match(ui.row("Field") ?? "", /Global only here/);
    });

    test("a throwing disabled blocks edits and resets with the failure message", async (t) => {
        const { ui, sets, resets } = open(t, [
            {
                id: "Flaky",
                disabled: () => {
                    throw new Error("oops");
                },
            },
        ]);
        for (const key of [keys.enter, keys.reset]) {
            ui.press(key);
            assert.match(ui.text(), /Could not check whether Flaky can be changed: oops/);
        }
        await ui.settled();
        assert.deepEqual([sets, resets], [[], []]);
    });
});

interface Probe {
    component: SettingsEditorComponent & { focused?: boolean };
    inputs: string[];
    disposed: number;
    context: SettingsCustomEditorContext<unknown, unknown>;
}

function probeEditor(
    options: {
        help?: string;
        withFocus?: boolean;
        render?: () => string[];
        handle?: (data: string) => void;
        factoryError?: string;
    } = {},
) {
    const probes: Probe[] = [];
    const customEditor: SettingsPanelField["customEditor"] = (context) => {
        if (options.factoryError) throw new Error(options.factoryError);
        const probe: Probe = {
            inputs: [],
            disposed: 0,
            context: context as never,
            component: {
                render: options.render ?? (() => ["EDITOR BODY"]),
                invalidate() {},
                handleInput: (data) => {
                    probe.inputs.push(data);
                    options.handle?.(data);
                },
                dispose: () => {
                    probe.disposed++;
                },
                ...(options.help ? { help: options.help } : {}),
                ...(options.withFocus ? { focused: false } : {}),
            },
        };
        probes.push(probe);
        return probe.component;
    };
    return { probes, customEditor, last: () => probes[probes.length - 1]! };
}

describe("custom editors in the panel", () => {
    test("Enter opens the editor, renders its body and shows its help beside Esc cancel", (t) => {
        const editor = probeEditor({ help: "Enter pick" });
        const { ui } = open(t, [{ id: "Custom", initial: "v", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        assert.equal(editor.probes.length, 1);
        assert.match(ui.text(), /EDITOR BODY/);
        assert.equal(ui.title(), "Custom · global");
        assert.equal(ui.help(), "Enter pick · Esc cancel");
    });

    test("without component help only Esc cancel is shown", (t) => {
        const editor = probeEditor();
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        assert.equal(ui.help(), "Esc cancel");
    });

    test("opens with an isolated copy of the value at the current scope and its write scope", (t) => {
        const editor = probeEditor();
        const { ui, ctx, read } = open(t, [
            {
                id: "List",
                initial: ["a"],
                schema: Type.Array(Type.String()),
                customEditor: editor.customEditor,
            },
        ]);
        ui.press(keys.scope, keys.enter);
        const { context } = editor.last();
        assert.equal(context.scope, "project");
        assert.strictEqual(context.context, ctx);
        assert.strictEqual(context.theme, theme);
        assert.deepEqual(context.value, ["a"]);
        (context.value as string[]).push("mutated");
        assert.deepEqual(read("List", "global"), ["a"]);
    });

    test("forwards every key except Escape and does not save", async (t) => {
        const editor = probeEditor();
        const { ui, sets } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        ui.press("a", keys.enter, keys.down, "\x13", "\x07", keys.reset, "\t");
        assert.deepEqual(editor.last().inputs, [
            "a",
            keys.enter,
            keys.down,
            "\x13",
            "\x07",
            keys.reset,
            "\t",
        ]);
        await ui.settled();
        assert.deepEqual(sets, []);
        assert.equal(ui.title(), "Custom · global");
    });

    test("forwards Left and Right to the open editor", (t) => {
        const editor = probeEditor();
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        ui.press(keys.left, keys.right);
        assert.deepEqual(editor.last().inputs, [keys.left, keys.right]);
        assert.equal(ui.title(), "Custom · global");
        assert.match(ui.text(), /EDITOR BODY/);
    });

    test("Escape closes without saving, disposes once and returns to the list", (t) => {
        const editor = probeEditor();
        const { ui, sets } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        ui.press(keys.escape);
        assert.deepEqual(editor.last().inputs, []);
        assert.equal(editor.last().disposed, 1);
        assert.deepEqual(sets, []);
        assert.equal(ui.title(), "Lune settings · global");
        assert.doesNotMatch(ui.text(), /EDITOR BODY/);
    });

    test("cancel() closes without saving and disposes", (t) => {
        const editor = probeEditor();
        const { ui, sets } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        editor.last().context.cancel();
        assert.equal(editor.last().disposed, 1);
        assert.deepEqual(sets, []);
        assert.equal(ui.title(), "Lune settings · global");
    });

    test("submit saves a valid value at the scope captured at open, closes and disposes", async (t) => {
        const editor = probeEditor();
        const { ui, sets, read } = open(t, [
            { id: "Custom", initial: "old", customEditor: editor.customEditor },
        ]);
        ui.press(keys.scope, keys.enter);
        editor.last().context.submit("new");
        await ui.settled();
        assert.deepEqual(sets, [{ id: "Custom", value: "new", scope: "project" }]);
        assert.equal(read("Custom", "project"), "new");
        assert.equal(editor.last().disposed, 1);
        assert.equal(ui.title(), "Lune settings · project");
        assert.match(ui.row("Custom") ?? "", /new/);
    });

    test("an invalid submitted value is rejected and the editor stays open", async (t) => {
        const editor = probeEditor();
        const { ui, sets } = open(t, [
            { id: "Custom", schema: Type.Integer(), initial: 1, customEditor: editor.customEditor },
        ]);
        ui.press(keys.enter);
        editor.last().context.submit("not a number");
        await ui.settled();
        assert.match(ui.text(), /Invalid value for Custom/);
        assert.match(ui.text(), /EDITOR BODY/);
        assert.equal(editor.last().disposed, 0);
        assert.deepEqual(sets, []);
        editor.last().context.submit(5);
        await ui.settled();
        assert.deepEqual(sets, [{ id: "Custom", value: 5, scope: "global" }]);
        assert.equal(editor.last().disposed, 1);
    });

    test("a failing field.set shows the error and keeps the editor open", async (t) => {
        const editor = probeEditor();
        const { ui } = open(t, [
            { id: "Custom", failSet: "disk full", customEditor: editor.customEditor },
        ]);
        ui.press(keys.enter);
        editor.last().context.submit("x");
        await ui.settled();
        assert.match(ui.text(), /disk full/);
        assert.match(ui.text(), /EDITOR BODY/);
        assert.equal(editor.last().disposed, 0);
    });

    test("submit, cancel and requestRender after the editor closed do nothing", async (t) => {
        const editor = probeEditor();
        const { ui, sets } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        const { context } = editor.last();
        ui.press(keys.escape);
        const rendersBefore = ui.renders;
        context.submit("late");
        context.cancel();
        context.requestRender();
        await ui.settled();
        assert.deepEqual(sets, []);
        assert.equal(editor.last().disposed, 1);
        assert.equal(ui.renders, rendersBefore);
    });

    test("a stale editor cannot act on a newly opened one", async (t) => {
        const editor = probeEditor();
        const { ui, sets } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter, keys.escape, keys.enter);
        const [first, second] = editor.probes;
        first!.context.submit("stale");
        first!.context.cancel();
        await ui.settled();
        assert.deepEqual(sets, []);
        assert.equal(second!.disposed, 0);
        assert.match(ui.text(), /EDITOR BODY/);
    });

    test("requestRender asks the host to redraw while open", (t) => {
        const editor = probeEditor();
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        const before = ui.renders;
        editor.last().context.requestRender();
        assert.equal(ui.renders, before + 1);
    });

    test("a throwing factory reports the failure and stays on the list", (t) => {
        const editor = probeEditor({ factoryError: "no widget" });
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        assert.match(ui.text(), /Could not open the editor for Custom: no widget/);
        assert.equal(ui.title(), "Lune settings · global");
    });

    test("a throwing render shows the failure in the body and Escape still closes", (t) => {
        const editor = probeEditor({
            render: () => {
                throw new Error("bad draw");
            },
        });
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        assert.match(ui.text(), /Editor failed to render: bad draw/);
        ui.press(keys.escape);
        assert.equal(editor.last().disposed, 1);
        assert.equal(ui.title(), "Lune settings · global");
    });

    test("a throwing handleInput shows its message and keeps the editor open", (t) => {
        const editor = probeEditor({
            handle: () => {
                throw new Error("key exploded");
            },
        });
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter, "x");
        assert.match(ui.text(), /key exploded/);
        assert.match(ui.text(), /EDITOR BODY/);
        assert.equal(editor.last().disposed, 0);
    });

    test("disposing the panel disposes an open editor once", (t) => {
        const editor = probeEditor();
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        ui.panel!.dispose!();
        ui.panel!.dispose!();
        assert.equal(editor.last().disposed, 1);
    });

    test("keeps a focusable component's focused flag in sync with the panel", (t) => {
        const editor = probeEditor({ withFocus: true });
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        assert.equal(editor.last().component.focused, true);
        ui.panel!.focused = false;
        assert.equal(editor.last().component.focused, false);
        ui.panel!.focused = true;
        assert.equal(editor.last().component.focused, true);
    });

    test("does not add a focused property to components that lack one", (t) => {
        const editor = probeEditor();
        const { ui } = open(t, [{ id: "Custom", customEditor: editor.customEditor }]);
        ui.press(keys.enter);
        ui.panel!.focused = false;
        assert.equal("focused" in editor.last().component, false);
    });

    test("a disabled field or a global-only field at project scope never creates the editor", (t) => {
        const editor = probeEditor();
        const { ui } = open(t, [
            { id: "Locked", disabled: () => "Not now", customEditor: editor.customEditor },
            { id: "GlobalOnly", scopes: ["global"], customEditor: editor.customEditor },
        ]);
        ui.press(keys.enter);
        assert.match(ui.text(), /Not now/);
        ui.press(keys.down, keys.scope, keys.enter);
        assert.match(ui.text(), /GlobalOnly can only be set globally/);
        assert.equal(editor.probes.length, 0);
    });

    test("a throwing disabled check prevents the editor from opening", (t) => {
        const editor = probeEditor();
        const { ui } = open(t, [
            {
                id: "Custom",
                disabled: () => {
                    throw new Error("bad check");
                },
                customEditor: editor.customEditor,
            },
        ]);
        ui.press(keys.enter);
        assert.match(ui.text(), /Could not check whether Custom can be changed: bad check/);
        assert.equal(editor.probes.length, 0);
    });
});

describe("adapters wire group, visible, disabled and customEditor", () => {
    const schema = Type.Object({
        mode: Type.String({ default: "basic" }),
        count: Type.Integer({ default: 1 }),
        extra: Type.String({ default: "" }),
    });

    async function views(t: TestContext) {
        const sandbox = await createSettingsSandbox({ prefix: "lune-conditional-" });
        t.after(() => sandbox.dispose());
        const definition = defineSettings({ id: "conditional", schema });
        const lease = await sandbox.acquire(definition, { projectTrusted: true });
        const settings = lease.settings;
        await settings.set("mode", "global-mode", { scope: "global" });
        await settings.set("count", 5, { scope: "project" });
        return { definition, settings };
    }
    const ctx = { cwd: "/unused" } as unknown as ExtensionContext;
    const expectedValues = (scope: SettingsScope) =>
        scope === "global"
            ? { mode: "global-mode", count: 1, extra: "" }
            : { mode: "global-mode", count: 5, extra: "" };

    type Probe = {
        visible: SettingsChoiceContext<unknown>[];
        disabled: SettingsChoiceContext<unknown>[];
        editor: SettingsCustomEditorContext<unknown, unknown>[];
    };
    const callbacks = (probe: Probe) => ({
        visible: (c: SettingsChoiceContext<unknown>) => (
            probe.visible.push(c),
            c.scope === "project"
        ),
        disabled: (c: SettingsChoiceContext<unknown>) => (
            probe.disabled.push(c),
            `locked in ${c.scope}`
        ),
        customEditor: (c: SettingsCustomEditorContext<unknown, unknown>) => {
            probe.editor.push(c);
            return { render: () => [], invalidate() {}, handleInput() {} };
        },
    });

    function check(section: SettingsSection, probe: Probe) {
        const [mode, count, extra] = section.fields;
        assert.deepEqual(
            section.fields.map((field) => field.group),
            ["Basics", "Basics", "More"],
        );
        assert.equal(count!.editor, "custom");
        assert.equal(mode!.visible, undefined);
        assert.equal(mode!.disabled, undefined);
        assert.equal(mode!.customEditor, undefined);
        for (const scope of ["global", "project"] as const) {
            assert.equal(extra!.visible!(ctx, scope), scope === "project");
            assert.equal(extra!.disabled!(ctx, scope), `locked in ${scope}`);
            const seen = probe.visible.at(-1)!;
            assert.equal(seen.scope, scope);
            assert.strictEqual(seen.context, ctx);
            assert.deepEqual(seen.values, expectedValues(scope));
            assert.deepEqual(probe.disabled.at(-1)!.values, expectedValues(scope));
        }
        const submit = () => {};
        const cancel = () => {};
        const requestRender = () => {};
        const component = count!.customEditor!({
            context: ctx,
            scope: "project",
            theme,
            value: 5,
            submit,
            cancel,
            requestRender,
        });
        assert.equal(typeof component.render, "function");
        const received = probe.editor.at(-1)!;
        assert.deepEqual(received.values, expectedValues("project"));
        assert.strictEqual(received.submit, submit);
        assert.strictEqual(received.cancel, cancel);
        assert.strictEqual(received.requestRender, requestRender);
        assert.strictEqual(received.context, ctx);
        assert.equal(received.scope, "project");
        assert.equal(received.value, 5);
        assert.equal(received.theme, theme);
    }

    test("createSettingsSection passes metadata through and scoped values to callbacks", async (t) => {
        const { settings } = await views(t);
        const probe: Probe = { visible: [], disabled: [], editor: [] };
        const cb = callbacks(probe);
        check(
            createSettingsSection(settings, {
                label: "Conditional",
                fields: {
                    mode: { group: "Basics" },
                    count: { group: "Basics", customEditor: cb.customEditor },
                    extra: { group: "More", visible: cb.visible, disabled: cb.disabled },
                },
            }),
            probe,
        );
    });

    test("createDefinedSettingsSection passes metadata through and scoped values to callbacks", async (t) => {
        const { settings, definition } = await views(t);
        const probe: Probe = { visible: [], disabled: [], editor: [] };
        const cb = callbacks(probe);
        const panel = defineSettingsPanel(definition, {
            label: "Conditional",
            fields: [
                { path: "mode", group: "Basics" },
                { path: "count", group: "Basics", customEditor: cb.customEditor },
                { path: "extra", group: "More", visible: cb.visible, disabled: cb.disabled },
            ],
        });
        check(createDefinedSettingsSection(settings, panel), probe);
    });

    test("callback values are a snapshot copy, not the live view", async (t) => {
        const { settings, definition } = await views(t);
        let captured: { mode: string } | undefined;
        const panel = defineSettingsPanel(definition, {
            label: "Conditional",
            fields: [
                {
                    path: "mode",
                    visible: ({ values }) => {
                        captured = values;
                        values.mode = "tampered";
                        return true;
                    },
                },
            ],
        });
        const section = createDefinedSettingsSection(settings, panel);
        section.fields[0]!.visible!(ctx, "global");
        assert.equal(settings.get("mode"), "global-mode");
        section.fields[0]!.visible!(ctx, "global");
        assert.notEqual(captured, undefined);
    });

    test("createSettingsSection rejects misordered or invalid groups, honoring fieldOrder", async (t) => {
        const { settings } = await views(t);
        assert.throws(
            () =>
                createSettingsSection(settings, {
                    label: "Bad",
                    fields: { mode: { group: "A" }, count: {}, extra: { group: "A" } },
                }),
            { name: "TypeError", message: /Ungrouped settings must come before group "A"/ },
        );
        assert.throws(
            () =>
                createSettingsSection(settings, {
                    label: "Bad",
                    fields: { mode: { group: "A" }, count: { group: "B" }, extra: { group: "A" } },
                }),
            { name: "TypeError", message: 'Settings group "A" must list its fields together' },
        );
        assert.doesNotThrow(() =>
            createSettingsSection(settings, {
                label: "Reordered",
                fieldOrder: ["count", "mode", "extra"],
                fields: { mode: { group: "A" }, count: {}, extra: { group: "A" } },
            }),
        );
        assert.throws(
            () =>
                createSettingsSection(settings, {
                    label: "Bad",
                    fieldOrder: ["mode"],
                    fields: { mode: { group: "" } },
                }),
            { name: "TypeError", message: 'Settings group for "mode" must be a non-empty string' },
        );
    });

    test("createDefinedSettingsSection rejects a layout that bypassed defineSettingsPanel", async (t) => {
        const { settings, definition } = await views(t);
        const panel = defineSettingsPanel(definition, { label: "Conditional" });
        const forged = {
            ...panel,
            fields: [{ path: "mode", group: "A" }, { path: "count" }],
        } as unknown as typeof panel;
        assert.throws(() => createDefinedSettingsSection(settings, forged), {
            name: "TypeError",
            message: /Ungrouped settings must come before group "A"/,
        });
    });
});
