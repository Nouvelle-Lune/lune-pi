/**
 * Cross-extension Dock protocol, independent of a particular aggregator or feature.
 *
 * Contributors own business state and publish complete single-line presentations;
 * hosts own layout/display level and activation routing. Context lifetime remains
 * native Pi-owned. Components/Pi contexts are type-only dependencies at this entry.
 */
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Dock snapshot/service ABI, not the npm version or outer Core Host protocol.
 * Bump for incompatible Dock semantics; /dock/host validates shared registry reuse.
 * This is the only Lune Dock protocol: the former standalone package is retired.
 */
export const LUNE_DOCK_PROTOCOL_VERSION = 1;
/** Host-selected presentation level; contributors publish levels, not a selection policy. */
export type LuneDockDisplayMode = "base" | "detail" | "full";

/**
 * Complete replacement snapshot: omitted levels remove earlier presentations.
 * Each supplied component must render exactly one physical line within the host's
 * width. Levels are complete alternatives, not patches or appended fragments.
 */
export interface LuneDockSnapshot {
    base: Component;
    detail?: Component;
    full?: Component;
}

/**
 * Borrowed contributor capability; ownership of business state remains in the plugin.
 * Hosts read current truth before observing future complete replacements.
 */
export interface LuneDockProvider {
    readonly id: string;
    /** Current truth must be available synchronously, including after host reattachment. */
    getSnapshot(): LuneDockSnapshot;
    /** Publish complete replacements; return cleanup for this observer only. */
    subscribe(listener: (snapshot: LuneDockSnapshot) => void): () => void;
    /** Delegate user action to the feature owner; hosts do not interpret business state. */
    activate(): void | Promise<void>;
}

/** UI-scoped provider facade exposed only while an aggregator host is attached. */
export interface LuneDockHost {
    readonly protocolVersion: number;
    /** Borrow a provider until its idempotent registration handle is released. */
    register(provider: LuneDockProvider): () => void;
}

/**
 * Feature-owned fallback renderer when no shared host is present.
 * clear must also stop timers/subscriptions when setCtx(undefined) has retired the UI.
 */
export interface IndependentDock {
    /** Undefined invalidates borrowed context; never write through a retired ctx.ui. */
    setCtx(ctx: ExtensionContext | undefined): void;
    render(): void;
    clear(): void;
}

/**
 * Adapter input: stable UI-scoped ID plus feature-owned snapshots/actions/fallback.
 * The caller is responsible for invoking the returned handle from native lifecycle.
 */
export interface DockDefinition {
    id: string;
    getSnapshot(ctx: ExtensionContext): LuneDockSnapshot;
    activate(ctx: ExtensionContext): void | Promise<void>;
    standalone: IndependentDock;
}

/**
 * Contributor attachment lifetime; no native Pi hooks are installed automatically.
 * Detach even after partial attach failure so fallback resources cannot outlive context.
 */
export interface DockHandle {
    /**
     * Retire a prior attachment; register only in TUI, otherwise use the standalone path.
     * An incompatible shared Dock keeps the standalone path and warns via ctx.ui.notify.
     */
    attach(ctx: ExtensionContext): void;
    /**
     * Idempotent release of registration/fallback resources. retired=true clears the
     * fallback context before cleanup so shutdown/replacement cannot write old UI.
     */
    detach(options?: { retired?: boolean }): void;
    /** Publish a new complete snapshot unless summaryChanged=false; fallback may still render. */
    refresh(options?: { summaryChanged?: boolean }): void;
}
