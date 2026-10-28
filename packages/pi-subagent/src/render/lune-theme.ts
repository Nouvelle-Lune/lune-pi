import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import type { SettledState } from "../run/types.ts";

/**
 * Core Theme publishes its renderer here only while it draws the transcript, so a missing value
 * means the theme is off or not installed.
 */
const LUNE_THEME_RENDERER = Symbol.for("@lune_99/pi-core-theme/renderer/v1");

export type LuneActivityStatus = "running" | "done" | "failed" | "cancelled";

/** The part of Core Theme's renderer contract this package uses; Core Theme is never a dependency. */
export interface LuneActivity {
    title: string;
    summary?: string;
    entries: readonly {
        name: string;
        summary?: string;
        status: LuneActivityStatus;
        detail?: string;
        durationMs?: number;
        error?: string;
        /** Display text without terminal control sequences. */
        output?: string;
        fullOutputPath?: string;
    }[];
}

export interface LuneThemeRenderer {
    readonly version: 1;
    renderActivity(
        activity: LuneActivity,
        options: {
            expanded: boolean;
            /** Lets the theme remember what a click opened; Pi rebuilds message components often. */
            key?: object;
        },
        theme: Theme,
    ): Component;
}

/** Looked up on every render: the theme can be switched while a surface stays on screen. */
export function luneThemeRenderer(): LuneThemeRenderer | undefined {
    const renderer = (globalThis as Record<symbol, unknown>)[LUNE_THEME_RENDERER] as
        | LuneThemeRenderer
        | undefined;

    return renderer?.version === 1 ? renderer : undefined;
}

/**
 * The run state in the theme's vocabulary. A stopped turn was stopped on request, which the theme
 * calls cancelled rather than failed. The report status stays separate, in the entry's detail.
 */
export function activityStatus(state: SettledState | "running"): LuneActivityStatus {
    switch (state) {
        case "running":
            return "running";
        case "idle":
            return "done";
        case "failed":
            return "failed";
        case "interrupted":
            return "cancelled";
    }
}
