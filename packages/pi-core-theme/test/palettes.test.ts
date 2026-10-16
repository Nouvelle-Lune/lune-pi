import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { createPalette } from "../src/palette.ts";
import {
    type PaletteDefinition,
    isPaletteName,
    paletteAppearance,
    paletteNames,
    palettes,
} from "../src/palettes/index.ts";
import { themeSchema } from "../src/settings.ts";
import { getThemeByName } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const expectedNames = [
    "pi-core-dark",
    "pi-core-light",
    "pi-core-aurora",
    "pi-core-eclipse",
    "pi-core-nebula",
    "pi-core-dawn",
    "pi-core-mist",
];
const literalColor = /^(#[0-9a-fA-F]{6}|\d{1,3}|)$/;

test("the registry exposes the seven Lune palettes in settings order", () => {
    const actual = [...paletteNames];
    assert.deepEqual(actual, expectedNames);
    for (const name of expectedNames) assert.ok(isPaletteName(name));
    for (const name of ["inherit", "dark", "", undefined, "toString"])
        assert.equal(isPaletteName(name), false);
});

for (const name of expectedNames as (keyof typeof palettes)[]) {
    test(`palette ${name} is a complete, self-consistent theme definition`, () => {
        const { label, description } = palettes[name];
        const definition: PaletteDefinition = palettes[name].definition;
        assert.ok(label && description);
        assert.equal(definition.name, name);
        assert.ok(["dark", "light"].includes(definition.appearance));
        assert.equal(paletteAppearance(name), definition.appearance);
        for (const key of ["bg", "text", "moon1", "moon2", "moon3", "moon4", "moon5"])
            assert.match(definition.vars[key] ?? "", /^#[0-9a-fA-F]{6}$/, `var ${key}`);
        for (const [token, value] of Object.entries(definition.colors)) {
            const resolved = definition.vars[value as string] ?? value;
            assert.match(String(resolved), literalColor, `color ${token} -> ${String(value)}`);
        }
    });

    test(`createPalette(${name}) names the theme and takes its appearance from the palette`, () => {
        const current = getThemeByName("dark")!;
        const theme = createPalette(name, current);
        assert.equal(theme.name, name);
        assert.equal(theme.appearance, palettes[name].definition.appearance);
    });
}

test("package.json lists exactly the palette files as Pi themes", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        pi: { themes: string[] };
    };
    const expected = expectedNames.map((name) => `./src/palettes/${name}.json`);
    assert.deepEqual([...pkg.pi.themes].sort(), [...expected].sort());
});

test("the settings schema accepts inherit and every palette and rejects unknown names", () => {
    const base = Value.Default(themeSchema, {}) as Record<string, unknown>;
    for (const palette of ["inherit", ...expectedNames])
        assert.ok(Value.Check(themeSchema, { ...base, palette }), palette);
    for (const palette of ["lune-core-dark", "pi-core-", "", 3])
        assert.equal(Value.Check(themeSchema, { ...base, palette }), false, String(palette));
});

test("palette defaults to inherit and paletteBackground defaults to on", () => {
    const defaults = Value.Default(themeSchema, {}) as {
        palette: string;
        paletteBackground: boolean;
    };
    assert.equal(defaults.palette, "inherit");
    assert.equal(defaults.paletteBackground, true);
});
