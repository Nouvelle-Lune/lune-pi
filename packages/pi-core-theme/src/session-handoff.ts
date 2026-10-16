/**
 * Pi resets extension UI the moment a reload or session replacement starts, and applies its own
 * saved theme again once the new session is bound. Between the two, the outgoing instance has
 * already torn down and the incoming one has not mounted, so the native header and palette would
 * show for the whole rebuild.
 *
 * The outgoing instance leaves its appearance in place, Pi's reset and theme re-apply are
 * countered in the same tick (before any frame renders), and the incoming instance adopts it.
 * This reaches into Pi internals, so every step falls back to Pi's own behaviour.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { HeaderFactory } from "./startup-header.ts";
import { setTerminalColors } from "./terminal-background.ts";

export interface PaletteState {
    name: string;
    /** The instance on screen, reapplied verbatim after Pi resets the theme. */
    applied: Theme;
    /** What to restore when the palette is turned off later. */
    native: Theme;
}

export interface Appearance {
    header?: HeaderFactory;
    palette?: PaletteState;
}

export interface SessionHandoff {
    /** Take what the previous instance left on screen; empty unless it handed over. */
    adopt(): Appearance;
    /** Record what is on screen now so the next replacement can keep it. */
    track(appearance: Appearance): void;
    /** Marks the coming shutdown as a replacement, so teardown must keep the appearance. */
    leave(reason: string): void;
    readonly handingOver: boolean;
}

type Method = (...args: unknown[]) => unknown;
interface MethodPatch {
    active: boolean;
    original: Method;
    installed: Method;
}
interface ThemeController {
    applyFromSettings?: Method;
    setThemeInstance?: (theme: Theme) => unknown;
}
interface HostMode {
    themeController?: ThemeController;
    setExtensionHeader?: (factory: HeaderFactory | undefined) => void;
}
interface HandoffState extends Appearance {
    leaving: boolean;
    /** A successor is expected; cleared when it adopts or when the replacement finishes without one. */
    pending: boolean;
}

const STATE = Symbol.for("nouvelle-lune.pi-core-theme.session-handoff");
const inert: SessionHandoff = {
    adopt: () => ({}),
    track() {},
    leave() {},
    handingOver: false,
};

export function installSessionHandoff(
    interactiveMode: { prototype: object } | undefined,
): SessionHandoff {
    const prototype = interactiveMode?.prototype as
        | (Record<string, unknown> & { [STATE]?: HandoffState })
        | undefined;
    if (!prototype || typeof prototype.resetExtensionUI !== "function") return inert;
    // Survives a module reload: the host prototype outlives every extension instance.
    const state = (prototype[STATE] ??= { leaving: false, pending: false });

    const settle = (mode: HostMode) => {
        if (!state.pending) return;
        state.pending = false;
        state.leaving = false;
        // The replacement finished without an instance claiming it, such as a removed extension.
        try {
            if (state.header) mode.setExtensionHeader?.(undefined);
            if (state.palette) {
                mode.themeController?.setThemeInstance?.(state.palette.native);
                setTerminalColors(undefined);
            }
        } catch {
            // Pi's own state is already consistent; nothing further to undo.
        }
        state.header = undefined;
        state.palette = undefined;
    };

    patchMethod(
        prototype,
        "resetExtensionUI",
        (original, patch) =>
            function (this: HostMode, ...args) {
                if (patch.active) hookThemeReset(this, state);
                const result = original.apply(this, args);
                if (patch.active && state.header) {
                    try {
                        this.setExtensionHeader?.(state.header);
                    } catch {
                        // The native header Pi just restored stays.
                    }
                }
                return result;
            },
    );
    for (const name of ["handleReloadCommand", "rebindCurrentSession"]) {
        patchMethod(
            prototype,
            name,
            (original, patch) =>
                async function (this: HostMode, ...args) {
                    try {
                        return await original.apply(this, args);
                    } finally {
                        if (patch.active) settle(this);
                    }
                },
        );
    }

    return {
        adopt() {
            if (!state.pending) return {};
            state.pending = false;
            state.leaving = false;
            return { header: state.header, palette: state.palette };
        },
        track({ header, palette }) {
            state.header = header;
            state.palette = palette;
        },
        leave(reason) {
            state.leaving = reason !== "quit";
            state.pending = state.leaving && !!(state.header || state.palette);
        },
        get handingOver() {
            return state.leaving;
        },
    };
}

/** Pi re-applies the saved theme after every bind; put Lune's back before the next frame renders. */
function hookThemeReset(mode: HostMode, state: HandoffState) {
    const controller = mode.themeController;
    if (!controller) return;
    patchMethod(
        controller as Record<string, unknown>,
        "applyFromSettings",
        (original, patch) =>
            function (this: ThemeController, ...args) {
                const result = original.apply(this, args);
                const palette = state.palette;
                if (patch.active && palette) {
                    try {
                        this.setThemeInstance?.(palette.applied);
                    } catch {
                        // The saved theme stays; the palette watcher corrects it on the next render.
                    }
                }
                return result;
            },
    );
}

/** Wraps once per target: a newer module takes over the original instead of stacking on the old wrapper. */
function patchMethod(
    target: Record<string, unknown>,
    name: string,
    wrap: (original: Method, patch: MethodPatch) => Method,
) {
    const current = target[name];
    if (typeof current !== "function") return;
    const slot = Symbol.for(`nouvelle-lune.pi-core-theme.session-handoff.${name}`);
    const previous = (target as Record<symbol, MethodPatch | undefined>)[slot];
    const original = (
        previous && current === previous.installed ? previous.original : current
    ) as Method;
    if (previous) previous.active = false;
    const patch = { active: true, original } as MethodPatch;
    patch.installed = wrap(original, patch);
    target[name] = patch.installed;
    (target as Record<symbol, MethodPatch>)[slot] = patch;
}
