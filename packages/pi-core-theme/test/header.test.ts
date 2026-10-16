import assert from "node:assert/strict";
import { test } from "node:test";
import { keyText, Theme, VERSION } from "@earendil-works/pi-coding-agent";
import {
    colorToHex,
    getKeybindings,
    KeybindingsManager,
    setKeybindings,
    stripTerminalSequences,
    type Component,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { createLuneHeader } from "../src/header.ts";
import { createPalette } from "../src/palette.ts";
import { createThemePanel } from "../src/panel.ts";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { themeSettings } from "../src/settings.ts";
import { getThemeByName } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const headerOptions = { version: "0.1.0", piVersion: VERSION, keyText };

function theme(mode: "truecolor" | "256color" = "truecolor") {
    // Resolve a complete built-in palette before changing only its terminal color encoding.
    const builtin = getThemeByName("dark");
    assert.ok(builtin);
    const colors = Object.entries(builtin.colors).map(
        ([token, color]) => [token, colorToHex(color)] as const,
    );
    return new Theme(
        Object.fromEntries(
            colors.filter(([token]) => !token.endsWith("Bg")),
        ) as ConstructorParameters<typeof Theme>[0],
        Object.fromEntries(
            colors.filter(([token]) => token.endsWith("Bg")),
        ) as ConstructorParameters<typeof Theme>[1],
        mode,
    );
}

test("the Lune header keeps its mark, version and shortcuts within every terminal width", () => {
    // Resize must preserve terminal-cell bounds, including half-block pixels and the smallest widths.
    const header = createLuneHeader(theme(), headerOptions);
    for (const width of [0, 1, 2, 8, 30, 68, 80, 120]) {
        const lines = header.render(width);
        for (const line of lines)
            assert.ok(visibleWidth(line) <= width, `Overflow at width ${width}`);
        if (width === 0) assert.deepEqual(lines, []);
    }
    const wide = header.render(120).map(stripTerminalSequences);
    assert.equal(wide.length, 7);
    assert.match(wide[1]!, /L U N E/);
    assert.match(wide[1]!, new RegExp(`theme v0\\.1\\.0 · pi v${VERSION.replaceAll(".", "\\.")}`));
    assert.match(wide.join("\n"), /[▀▄]/);
    assert.match(wide.join("\n"), /\/ commands/);
    assert.match(wide.join("\n"), /! shell/);
    assert.match(wide.join("\n"), /\/lune-core-settings settings/);
    const narrow = header.render(30).map(stripTerminalSequences);
    assert.ok(narrow.length > wide.length);
    assert.match(narrow.join("\n"), /L U N E/);
    assert.match(narrow.join("\n"), /\/lune-core-settings/);
});

test("header expansion and invalidation read current configured shortcuts", (t) => {
    // Remapped or disabled bindings must be reflected rather than displaying hard-coded keys.
    const previous = getKeybindings();
    t.after(() => setKeybindings(previous));
    const keys = new KeybindingsManager({
        "app.interrupt": { defaultKeys: "escape" },
        "app.model.select": { defaultKeys: "ctrl+l" },
        "app.tools.expand": { defaultKeys: "ctrl+o" },
        "app.clear": { defaultKeys: "ctrl+c" },
        "app.editor.external": { defaultKeys: "ctrl+g" },
    });
    setKeybindings(keys);
    const header = createLuneHeader(theme(), headerOptions);
    const compact = header.render(120).map(stripTerminalSequences).join("\n");
    assert.match(compact, /escape interrupt/);
    assert.match(compact, /ctrl\+o more/);
    assert.doesNotMatch(compact, /external editor/);
    header.setExpanded(true);
    const expanded = header.render(120).map(stripTerminalSequences).join("\n");
    assert.match(expanded, /ctrl\+g external editor/);
    assert.match(expanded, /ctrl\+o less/);
    keys.setUserBindings({ "app.interrupt": "ctrl+j", "app.editor.external": [] });
    header.invalidate();
    const remapped = header.render(120).map(stripTerminalSequences).join("\n");
    assert.match(remapped, /ctrl\+j interrupt/);
    assert.doesNotMatch(remapped, /escape interrupt|external editor/);
    header.setExpanded(false);
    assert.doesNotMatch(header.render(120).map(stripTerminalSequences).join("\n"), /Shortcuts/);
});

test("brand pixels use Pi Theme styling in truecolor and 256-color modes", () => {
    // Theme performs terminal-specific color encoding for both foreground and lower pixel backgrounds.
    const rgb = createLuneHeader(theme("truecolor"), headerOptions).render(120).join("\n");
    const indexed = createLuneHeader(theme("256color"), headerOptions).render(120).join("\n");
    assert.match(rgb, /\x1b\[38;2;/);
    assert.match(rgb, /\x1b\[48;2;/);
    assert.match(indexed, /\x1b\[38;5;/);
    assert.match(indexed, /\x1b\[48;5;/);
    assert.equal(stripTerminalSequences(rgb), stripTerminalSequences(indexed));
});

test("Theme preview describes off and renders on without acquiring a live header", () => {
    // Preview is a passive candidate component; the committed runtime alone owns setHeader.
    // Fields form a heterogeneous list, so the enabled field's callback is narrowed explicitly.
    const preview = createThemePanel(headerOptions).fields[0]!.preview as (input: {
        value: boolean;
        values: Static<typeof themeSettings.schema>;
        scope: "global";
        theme: Theme;
    }) => Component;
    const defaults = Value.Default(themeSettings.schema, undefined) as Static<
        typeof themeSettings.schema
    >;
    const off = preview({
        value: false,
        values: { ...defaults, enabled: false },
        scope: "global",
        theme: theme(),
    });
    const on = preview({
        value: true,
        values: { ...defaults, enabled: true },
        scope: "global",
        theme: theme(),
    });
    assert.match(
        off.render(120).map(stripTerminalSequences).join("\n"),
        /Pi's built-in appearance/,
    );
    assert.match(on.render(120).map(stripTerminalSequences).join("\n"), /L U N E/);
    assert.equal(visibleWidth(off.render(8)[0]!), 8);
});

test("the header renders host versions and key helpers instead of dependency-copy state", () => {
    // Bundled Pi resolves entry imports independently from native nested dependency modules.
    const header = createLuneHeader(theme(), {
        version: "2.3.4",
        piVersion: "9.8.7",
        keyText: (key) => (key === "app.interrupt" ? "ctrl+j" : ""),
    });
    const output = header.render(120).map(stripTerminalSequences).join("\n");
    assert.match(output, /theme v2\.3\.4 · pi v9\.8\.7/);
    assert.match(output, /ctrl\+j interrupt/);
    assert.doesNotMatch(output, /escape interrupt/);
    // Unconfigured helpers render nothing instead of a hard-coded fallback key.
    assert.doesNotMatch(output, /ctrl\+o/);
});

test("Lune palette themes tint the crescent with their moon colors, other themes keep the ice-blue moon", () => {
    const eclipse = createLuneHeader(createPalette("pi-core-eclipse", theme()), headerOptions)
        .render(120)
        .join("\n");
    assert.ok(eclipse.includes("255;244;222"), "eclipse moon1 #fff4de");
    const base = theme();
    assert.ok(!["pi-core-eclipse", "pi-core-dark", "pi-core-light"].includes(base.name ?? ""));
    const plain = createLuneHeader(base, headerOptions).render(120).join("\n");
    assert.ok(plain.includes("244;248;255"), "dark default moon1 #f4f8ff");
    assert.ok(!plain.includes("255;244;222"));
    const light = createLuneHeader(
        new Theme(
            Object.fromEntries(
                Object.entries(base.colors)
                    .filter(([token]) => !token.endsWith("Bg"))
                    .map(([token, color]) => [token, colorToHex(color)]),
            ) as ConstructorParameters<typeof Theme>[0],
            Object.fromEntries(
                Object.entries(base.colors)
                    .filter(([token]) => token.endsWith("Bg"))
                    .map(([token, color]) => [token, colorToHex(color)]),
            ) as ConstructorParameters<typeof Theme>[1],
            "truecolor",
            { name: "custom", appearance: "light" },
        ),
        headerOptions,
    )
        .render(120)
        .join("\n");
    assert.ok(light.includes("157;204;255"), "light default moon1 #9dccff");
});
