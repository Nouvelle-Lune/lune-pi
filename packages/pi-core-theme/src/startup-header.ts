/**
 * Pi builds its native header and renders it inside `init()`, before extensions get `session_start`.
 * Replacing the header as `init()` adds it is the only way the first frame is already Lune's.
 *
 * This reaches into Pi internals, so every step falls back to the native header.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export type HeaderFactory = (tui: TUI, theme: Theme) => Component;

export interface StartupHeader {
    /** True once if the swap happened, so `session_start` adopts that header instead of replacing it. */
    claim(): boolean;
    dispose(): void;
}

export interface StartupHeaderOptions {
    /** Must be the host's class: a dependency copy would patch a prototype Pi never runs. */
    interactiveMode: { prototype: object } | undefined;
    enabled: () => Promise<boolean>;
    factory: HeaderFactory;
}

type Init = (...args: unknown[]) => Promise<unknown>;
interface InitPatch {
    active: boolean;
    ran: boolean;
    original: Init;
    installed: Init;
}
interface ModeInternals {
    headerContainer?: { addChild?: (child: unknown) => unknown };
    builtInHeader?: unknown;
    setExtensionHeader?: (factory: HeaderFactory | undefined) => void;
}

const PATCH = Symbol.for("nouvelle-lune.pi-core-theme.startup-header");
const inert: StartupHeader = { claim: () => false, dispose() {} };

export function installStartupHeader({
    interactiveMode,
    enabled,
    factory,
}: StartupHeaderOptions): StartupHeader {
    const prototype = interactiveMode?.prototype as
        | { init?: Init; [PATCH]?: InitPatch }
        | undefined;
    const previous = prototype?.[PATCH];
    // init() runs once per process, so a reload has nothing left to patch or pre-read.
    if (!prototype || typeof prototype.init !== "function" || previous?.ran) return inert;
    const original =
        previous && prototype.init === previous.installed ? previous.original : prototype.init;
    // Started now so the settings read overlaps the rest of Pi's startup instead of delaying init().
    const decision = enabled().catch(() => false);
    let swapped = false;
    const patch: InitPatch = {
        active: true,
        ran: false,
        original,
        installed: async function (this: ModeInternals, ...args) {
            patch.ran = true;
            const restore =
                patch.active && (await decision)
                    ? swapOnAdd(this, factory, () => (swapped = true))
                    : undefined;
            try {
                return await original.apply(this, args);
            } finally {
                restore?.();
            }
        },
    };
    if (previous) previous.active = false;
    prototype.init = patch.installed;
    prototype[PATCH] = patch;
    return {
        claim() {
            const result = swapped;
            swapped = false;
            return result;
        },
        dispose() {
            patch.active = false;
        },
    };
}

/** Identity, not class name, picks the native header out of the container. */
function swapOnAdd(mode: ModeInternals, factory: HeaderFactory, onSwap: () => void) {
    const container = mode.headerContainer;
    const addChild = container?.addChild;
    if (
        !container ||
        typeof addChild !== "function" ||
        typeof mode.setExtensionHeader !== "function"
    )
        return undefined;
    const own = Object.hasOwn(container, "addChild");
    const restore = () => {
        if (own) container.addChild = addChild;
        else delete container.addChild;
    };
    container.addChild = function (this: unknown, child: unknown) {
        const result = addChild.call(this, child);
        if (child === mode.builtInHeader) {
            restore();
            try {
                mode.setExtensionHeader!(factory);
                onSwap();
            } catch {
                // The native header already in the container simply stays.
            }
        }
        return result;
    };
    return restore;
}
