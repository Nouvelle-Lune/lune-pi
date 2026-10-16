import { Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
import {
    paletteAppearance,
    palettes,
    type PaletteDefinition,
    type PaletteName,
} from "./palettes/index.ts";

const backgrounds = new Set([
    "selectedBg",
    "searchMatchBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
]);
/** Pi's ui.theme can be a live proxy, so restoration must hold a concrete snapshot. */
export function capturePalette(
    current: Pick<Theme, "name" | "colors" | "getColorMode" | "appearance">,
    getTheme: (name: string) => Theme | undefined,
): Theme {
    if (current instanceof Theme) return current;
    const named = current.name ? getTheme(current.name) : undefined;
    if (named) return named;
    const colors = Object.entries(current.colors).map(([key, color]) => [key, colorToHex(color)]);
    return new Theme(
        Object.fromEntries(
            colors.filter(([key]) => !backgrounds.has(key!)),
        ) as ConstructorParameters<typeof Theme>[0],
        Object.fromEntries(
            colors.filter(([key]) => backgrounds.has(key!)),
        ) as ConstructorParameters<typeof Theme>[1],
        current.getColorMode(),
        { name: current.name, appearance: current.appearance },
    );
}

export function createPalette(name: PaletteName, current: Theme): Theme {
    const definition: PaletteDefinition = palettes[name].definition;
    const colors = Object.entries(definition.colors).map(([key, value]) => [
        key,
        definition.vars[value] ?? value,
    ]);
    return new Theme(
        Object.fromEntries(
            colors.filter(([key]) => !backgrounds.has(key!)),
        ) as ConstructorParameters<typeof Theme>[0],
        Object.fromEntries(
            colors.filter(([key]) => backgrounds.has(key!)),
        ) as ConstructorParameters<typeof Theme>[1],
        current.getColorMode(),
        { name, appearance: paletteAppearance(name) },
    );
}
