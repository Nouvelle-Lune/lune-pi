import aurora from "./pi-core-aurora.json" with { type: "json" };
import claudeCode from "./pi-core-claude-code.json" with { type: "json" };
import codex from "./pi-core-codex.json" with { type: "json" };
import cursor from "./pi-core-cursor.json" with { type: "json" };
import dark from "./pi-core-dark.json" with { type: "json" };
import darkPlain from "./pi-core-dark-plain.json" with { type: "json" };
import dawn from "./pi-core-dawn.json" with { type: "json" };
import eclipse from "./pi-core-eclipse.json" with { type: "json" };
import light from "./pi-core-light.json" with { type: "json" };
import mist from "./pi-core-mist.json" with { type: "json" };
import nebula from "./pi-core-nebula.json" with { type: "json" };

export interface PaletteDefinition {
    readonly name: string;
    readonly appearance: string;
    /** A non-empty `bg` paints the terminal together with `text`; `moon1`…`moon5` tint the crescent top to bottom. */
    readonly vars: Readonly<Record<string, string>>;
    readonly colors: Readonly<Record<string, string>>;
}

export interface PaletteEntry {
    readonly label: string;
    readonly description: string;
    readonly definition: PaletteDefinition;
}

/** Settings order. Each file is also a standalone Pi theme listed in package.json. */
export const palettes = {
    "pi-core-dark": {
        label: "Lune Core Dark",
        description: "Moonlight blues on midnight navy",
        definition: dark,
    },
    "pi-core-dark-plain": {
        label: "Lune Core Dark Plain",
        description: "Moonlight blues without panel or terminal backgrounds",
        definition: darkPlain,
    },
    "pi-core-light": {
        label: "Lune Core Light",
        description: "Moonlight blues on pale paper",
        definition: light,
    },
    "pi-core-aurora": {
        label: "Lune Core Aurora",
        description: "Teal aurora over polar night",
        definition: aurora,
    },
    "pi-core-eclipse": {
        label: "Lune Core Eclipse",
        description: "Golden corona on black",
        definition: eclipse,
    },
    "pi-core-nebula": {
        label: "Lune Core Nebula",
        description: "Violet and magenta clouds",
        definition: nebula,
    },
    "pi-core-dawn": {
        label: "Lune Core Dawn",
        description: "Terracotta sunrise on parchment",
        definition: dawn,
    },
    "pi-core-mist": {
        label: "Lune Core Mist",
        description: "Pine teal on sage mist",
        definition: mist,
    },
    "pi-core-claude-code": {
        label: "Lune Core Claude Code",
        description: "Claude Code-style clay orange on warm charcoal",
        definition: claudeCode,
    },
    "pi-core-cursor": {
        label: "Lune Core Cursor",
        description: "Cursor-style pastel syntax on graphite",
        definition: cursor,
    },
    "pi-core-codex": {
        label: "Lune Core Codex",
        description: "Codex-style cyan and magenta on black",
        definition: codex,
    },
} as const satisfies Record<string, PaletteEntry>;

export type PaletteName = keyof typeof palettes;

export const paletteNames = Object.keys(palettes) as [PaletteName, ...PaletteName[]];

export function paletteAppearance(name: PaletteName): "dark" | "light" {
    return palettes[name].definition.appearance === "light" ? "light" : "dark";
}

export function isPaletteName(name: string | undefined): name is PaletteName {
    return name !== undefined && Object.hasOwn(palettes, name);
}
