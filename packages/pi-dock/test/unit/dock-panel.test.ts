import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { getDockRegistry } from "@lune_99/pi-lune-extensions-core/dock/host";
import { createDefinedSettingsSection } from "@lune_99/pi-lune-extensions-core/panel/host";
import { acquireSettings } from "@lune_99/pi-lune-extensions-core/settings/advanced";

import { DOCK_STYLES } from "../../src/dock-footer.ts";
import { dockPanel } from "../../src/dock-panel.ts";
import { dockSettings, type DockSettings } from "../../src/dock-settings.ts";
import { createAgentFixture, identityTheme, textSnapshot } from "../harness.ts";

/** The panel section Core would mount, over a real settings view in an isolated agent directory. */
async function openSection(t: TestContext) {
    const fixture = await createAgentFixture(t);
    const lease = await acquireSettings(dockSettings, { cwd: fixture.cwd, projectTrusted: true });
    t.after(() => lease.release());
    const section = createDefinedSettingsSection(lease.settings, dockPanel);
    const field = (id: string) => {
        const found = section.fields.find((candidate) => candidate.id === id);
        assert.ok(found, `the Dock panel must declare a "${id}" field`);
        return found;
    };
    return { ...fixture, view: lease.settings, section, field };
}

function previewLines(
    field: ReturnType<Awaited<ReturnType<typeof openSection>>["field"]>,
    value: unknown,
    width: number,
): string[] {
    assert.ok(field.preview, `${field.id} must have a preview`);
    return field.preview(value, identityTheme, "global").render(width).map(stripTerminalSequences);
}

describe("dock settings panel declaration", () => {
    it("is the Dock section of the pi-dock settings", () => {
        assert.equal(dockPanel.id, "dock");
        assert.equal(dockPanel.label, "Dock");
        assert.strictEqual(dockPanel.settings, dockSettings);
    });

    it("lists the settings in display order", () => {
        const actual = dockPanel.fields.map(({ path }) => path);

        assert.deepEqual(actual, [
            "enabled",
            "style",
            "displayMode",
            "showModel",
            "showWorkspace",
            "showUsage",
            "hidden",
            "order",
        ]);
    });

    it("labels each field for the settings list", async (t) => {
        const { section } = await openSection(t);

        const actual = section.fields.map(({ id, label }) => [id, label]);

        assert.deepEqual(actual, [
            ["enabled", "Dock"],
            ["style", "Style"],
            ["displayMode", "Presentation"],
            ["showModel", "Show model"],
            ["showWorkspace", "Show directory"],
            ["showUsage", "Show usage"],
            ["hidden", "Hidden plugins"],
            ["order", "Plugin order"],
        ]);
    });

    it("offers every dock style, in order, as the style choices", async (t) => {
        const { field } = await openSection(t);

        const actual = field("style").choices?.map(({ value }) => value);

        assert.deepEqual(actual, [...DOCK_STYLES]);
        assert.equal(field("style").editor, "cycle");
    });

    it("offers the three presentation levels as the presentation choices", async (t) => {
        const { field } = await openSection(t);

        const actual = field("displayMode").choices?.map(({ value }) => value);

        assert.deepEqual(actual, ["base", "detail", "full"]);
    });

    it("edits the switches as on or off", async (t) => {
        const { field } = await openSection(t);

        for (const id of ["enabled", "showModel", "showWorkspace", "showUsage"]) {
            assert.deepEqual(
                field(id).choices?.map(({ label }) => label),
                ["on", "off"],
                id,
            );
        }
    });

    it("picks hidden plugins from a list and edits the order as JSON", async (t) => {
        const { field } = await openSection(t);

        assert.equal(field("hidden").editor, "select");
        assert.equal(field("hidden").choiceSource?.multiple, true);
        assert.equal(field("order").editor, "json");
    });
});

describe("dock settings panel formatting", () => {
    it("shows the hidden plugins as a list, or none", async (t) => {
        const { field } = await openSection(t);
        const format = (value: unknown) =>
            field("hidden").formatValue?.(value, {} as ExtensionContext, "global");

        assert.equal(format([]), "none");
        assert.equal(format(["shell", "ask"]), "shell, ask");
    });

    it("shows the order as id=position pairs, or the registration order", async (t) => {
        const { field } = await openSection(t);
        const format = (value: unknown) =>
            field("order").formatValue?.(value, {} as ExtensionContext, "global");

        assert.equal(format({}), "registration order");
        assert.equal(format({ shell: 1, ask: -2 }), "shell=1, ask=-2");
    });
});

describe("dock settings panel hidden plugin choices", () => {
    async function loadChoices(ui: object, section: Awaited<ReturnType<typeof openSection>>) {
        const source = section.field("hidden").choiceSource;
        assert.ok(source);
        return source.load({
            context: { ui } as ExtensionContext,
            values: section.view.snapshot(),
            scope: "global",
            signal: new AbortController().signal,
        });
    }

    function register(t: TestContext, ui: object, id: string) {
        const release = getDockRegistry().registerContribution(ui, {
            id,
            getSnapshot: () => textSnapshot(id),
            subscribe: () => () => {},
            activate: () => undefined,
        });
        t.after(release);
    }

    it("lists the contributions registered with the dock of this UI", async (t) => {
        const section = await openSection(t);
        const ui = {};
        register(t, ui, "shells");
        register(t, ui, "questions");
        register(t, {}, "elsewhere");

        const actual = await loadChoices(ui, section);

        assert.deepEqual(
            actual.map(({ value, label }) => [value, label]),
            [
                ["shells", "shells"],
                ["questions", "questions"],
            ],
        );
    });

    it("lists nothing, and says why, while no plugin has registered", async (t) => {
        const section = await openSection(t);

        const actual = await loadChoices({}, section);

        assert.deepEqual(actual, []);
        assert.match(
            section.field("hidden").choiceSource?.emptyMessage ?? "",
            /No plugin has registered/,
        );
    });
});

describe("dock settings panel previews", () => {
    const PREVIEW_FIELDS = [
        "enabled",
        "style",
        "displayMode",
        "showModel",
        "showWorkspace",
        "showUsage",
    ];

    it("previews every presentation and layout field, and nothing else", async (t) => {
        const { section } = await openSection(t);

        const actual = section.fields.filter(({ preview }) => preview).map(({ id }) => id);

        assert.deepEqual(actual, PREVIEW_FIELDS);
    });

    it("draws every style within the requested width", async (t) => {
        const { field } = await openSection(t);

        for (const style of DOCK_STYLES) {
            for (let width = 1; width <= 120; width++) {
                for (const line of previewLines(field("style"), style, width)) {
                    assert.ok(
                        visibleWidth(line) <= width,
                        `${style} preview at ${width} columns is too wide: ${JSON.stringify(line)}`,
                    );
                }
            }
        }
    });

    it("shows the candidate style", async (t) => {
        const { field } = await openSection(t);

        const ruled = previewLines(field("style"), "ruled", 100);
        const boxed = previewLines(field("style"), "boxed", 100);
        const compact = previewLines(field("style"), "compact", 100);
        const minimal = previewLines(field("style"), "minimal", 100);
        const classic = previewLines(field("style"), "classic", 100);

        assert.match(ruled[0]!, /^─+$/);
        assert.match(boxed[0]!, /^╭─+╮$/);
        assert.doesNotMatch(compact.join("\n"), /[─╭]/);
        assert.equal(minimal.length, 1);
        assert.equal(classic.length, 1);
        assert.doesNotMatch(classic[0]!, /claude-opus-5-5/, "classic draws no model");
    });

    it("draws sample cells focused, so the selection and key hints show", async (t) => {
        const { field } = await openSection(t);

        const text = previewLines(field("style"), "ruled", 100).join("\n");

        assert.match(text, /❯ ○ Shell/);
        assert.match(text, /enter open/);
    });

    it("shows the candidate presentation level", async (t) => {
        const { field } = await openSection(t);

        // The cell chrome and padding take four columns, so the preview needs room for the full sample.
        const base = previewLines(field("displayMode"), "base", 160).join("\n");
        const detail = previewLines(field("displayMode"), "detail", 160).join("\n");
        const full = previewLines(field("displayMode"), "full", 160).join("\n");

        assert.match(base, /○ Shell/);
        assert.doesNotMatch(base, /running/);
        assert.match(detail, /○ Shell · 2 running/);
        assert.doesNotMatch(detail, /latest/);
        assert.match(full, /latest:/);
    });

    it("shows the Claude example model only when the model switch is on", async (t) => {
        const { field } = await openSection(t);

        const shown = previewLines(field("showModel"), true, 120).join("\n");
        const hidden = previewLines(field("showModel"), false, 120).join("\n");

        // This preview fixture is also the source of the README's generated images.
        assert.match(shown, /\(anthropic\) claude-opus-5-5/);
        assert.doesNotMatch(shown, /deepseek/i);
        assert.doesNotMatch(hidden, /claude-opus-5-5/);
    });

    it("shows the candidate directory and usage switches", async (t) => {
        const { field } = await openSection(t);

        const directoryOff = previewLines(field("showWorkspace"), false, 120).join("\n");
        const directoryOn = previewLines(field("showWorkspace"), true, 120).join("\n");
        const usageOff = previewLines(field("showUsage"), false, 120).join("\n");
        const usageOn = previewLines(field("showUsage"), true, 120).join("\n");

        assert.doesNotMatch(directoryOff, /projects\/lune/);
        assert.match(directoryOn, /projects\/lune/);
        assert.doesNotMatch(usageOff, /27k\/1\.0M · +2\.7%/);
        assert.match(usageOn, /27k\/1\.0M · +2\.7%/);
    });

    it("combines the candidate with the other stored settings", async (t) => {
        const { field, view } = await openSection(t);
        await view.set("showModel", false);
        await view.set("style", "boxed");

        const styleCandidate = previewLines(field("style"), "compact", 120).join("\n");
        const enabledCandidate = previewLines(field("enabled"), false, 120);

        assert.doesNotMatch(
            styleCandidate,
            /claude-opus-5-5/,
            "the stored model switch applies to a style preview",
        );
        assert.match(
            enabledCandidate[0]!,
            /^╭─+╮$/,
            "the stored style applies to an enabled preview",
        );
    });

    it("previews the saved settings, not the defaults, when only another field changes", async (t) => {
        const { field, view } = await openSection(t);
        const value: DockSettings["displayMode"] = "base";
        await view.set("displayMode", value);

        const lines = previewLines(field("showUsage"), true, 120).join("\n");

        assert.doesNotMatch(lines, /running/);
    });
});
