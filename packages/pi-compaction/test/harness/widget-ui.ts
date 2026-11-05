import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

export interface WidgetCall {
    readonly key: string;
    /** `undefined` clears the widget. */
    readonly content: WidgetFactory | undefined;
    readonly options: unknown;
}

/** A theme whose `fg` wraps text in a marker naming the color, so tests can read colors back. */
export function markerTheme(): Theme {
    return {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as unknown as Theme;
}

/** A theme that leaves text untouched, for tests about content and layout only. */
export function plainTheme(): Theme {
    return { fg: (_color: string, text: string) => text } as unknown as Theme;
}

export function stubTui(): TUI & { renders: number } {
    const tui = {
        renders: 0,
        requestRender() {
            tui.renders++;
        },
    };
    return tui as unknown as TUI & { renders: number };
}

/** Records every `setWidget` call and mounts factories the way Pi does, keeping the live component. */
export function recordWidgets(theme: Theme = plainTheme()): {
    readonly calls: WidgetCall[];
    readonly tui: ReturnType<typeof stubTui>;
    /** The component Pi would currently hold, or undefined once cleared. */
    component(): (Component & { dispose?(): void }) | undefined;
    setWidget(key: string, content: unknown, options?: unknown): void;
} {
    const calls: WidgetCall[] = [];
    const tui = stubTui();
    let mounted: (Component & { dispose?(): void }) | undefined;
    return {
        calls,
        tui,
        component: () => mounted,
        setWidget(key, content, options) {
            calls.push({ key, content: content as WidgetFactory | undefined, options });
            mounted?.dispose?.();
            mounted =
                typeof content === "function" ? (content as WidgetFactory)(tui, theme) : undefined;
        },
    };
}
