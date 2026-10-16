import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

/**
 * Cross-extension contract for surfaces outside Pi's tool-renderer chain, such as custom messages.
 *
 * The value exists on `globalThis` only while the Lune theme renders the transcript, so absence
 * means the theme is off or Core is not installed. Consumers look it up on every render and keep
 * their own renderer for that case; Core never learns who reads it.
 */
export const LUNE_THEME_RENDERER = Symbol.for("@lune_99/pi-core-theme/renderer/v1");

export type LuneActivityStatus = "running" | "done" | "failed" | "cancelled";

export interface LuneActivityEntry {
    /** Rendered like a tool name in a call tree. */
    name: string;
    /** Muted text after the name; clipped before the metadata is. */
    summary?: string;
    status: LuneActivityStatus;
    /** Dim fact after the status, such as an exit code. */
    detail?: string;
    durationMs?: number;
    error?: string;
    /** Display text without terminal control sequences; collapsed cards keep its last lines. */
    output?: string;
    /** The complete output file when `output` is only a retained tail; the full-output browser reads it. */
    fullOutputPath?: string;
}

export interface LuneActivity {
    title: string;
    /** Leads the heading's attention counts, such as a total. */
    summary?: string;
    entries: readonly LuneActivityEntry[];
}

export interface LuneActivityOptions {
    /** Follows Pi's global expand toggle, which also resets anything a click opened. */
    expanded: boolean;
    /**
     * A stable object for the surface, such as the message's own data. Pi rebuilds custom-message
     * components on every invalidation, so what a click opened is remembered against this key. Without
     * it the card has no click targets and only `expanded` opens it.
     */
    key?: object;
}

export interface LuneThemeRenderer {
    readonly version: 1;
    renderActivity(activity: LuneActivity, options: LuneActivityOptions, theme: Theme): Component;
}

/** The release leaves a renderer published by someone else in place. */
export function publishThemeRenderer(renderer: LuneThemeRenderer): () => void {
    const global = globalThis as Record<symbol, unknown>;
    Object.defineProperty(global, LUNE_THEME_RENDERER, { value: renderer, configurable: true });
    return () => {
        if (global[LUNE_THEME_RENDERER] === renderer) delete global[LUNE_THEME_RENDERER];
    };
}
