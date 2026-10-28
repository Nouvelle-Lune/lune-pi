import type { Theme } from "@earendil-works/pi-coding-agent";

/** A theme that returns text unchanged, enough for headless UI and plain tool renderers. */
export function createFakeTheme(): Theme {
    const identity = (text: string) => text;

    return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: identity,
        italic: identity,
        underline: identity,
        strikethrough: identity,
        style: identity,
        colors: {},
    } as unknown as Theme;
}
