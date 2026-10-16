/**
 * Contributor-facing Dock entry; aggregation/registry control lives in /dock/host.
 *
 * createDockContribution coordinates shared-host presence with a feature-owned
 * standalone renderer. It borrows native contexts and receives explicit refreshes,
 * rather than installing lifecycle hooks, timers or business state management.
 * Read types.ts for the single-line snapshot and retirement contracts.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDockRegistry } from "./host.ts";
import type { DockRegistry } from "./registry.ts";
import type { DockDefinition, DockHandle, LuneDockSnapshot } from "./types.ts";

export { LUNE_DOCK_PROTOCOL_VERSION } from "./types.ts";
export type {
    LuneDockDisplayMode,
    LuneDockSnapshot,
    LuneDockProvider,
    LuneDockHost,
    IndependentDock,
    DockDefinition,
    DockHandle,
} from "./types.ts";

/**
 * Build a contributor adapter; the shared Dock service is discovered on attach.
 *
 * Construction attaches no UI and cannot fail on protocol grounds. Call attach(ctx)
 * from native startup, refresh when presentation changes, and detach({ retired: true })
 * when Pi replaces/shuts down the context. An attached host suppresses the standalone
 * renderer; host removal restores it. Non-TUI contexts never join the shared registry.
 * When the shared Dock is incompatible, attach keeps the standalone renderer and warns
 * through ctx.ui.notify instead of throwing, so the feature's own UI stays usable.
 *
 * The adapter owns registration/observer handles, not business state or the Pi session.
 * Duplicate/provider failures propagate; callers must clean partial attachment.
 */
export function createDockContribution(definition: DockDefinition): DockHandle {
    const standalone = definition.standalone;
    let ctx: ExtensionContext | undefined;
    let registry: DockRegistry | undefined;
    let release: (() => void) | undefined;
    const listeners = new Set<(snapshot: LuneDockSnapshot) => void>();
    let snapshot: LuneDockSnapshot | undefined;

    const handle: DockHandle = {
        attach(currentCtx) {
            handle.detach({ retired: true });
            ctx = currentCtx;
            standalone.setCtx(currentCtx);
            if (currentCtx.mode !== "tui") {
                standalone.render();
                return;
            }
            let shared: DockRegistry;
            try {
                shared = getDockRegistry();
            } catch (error) {
                standalone.render();
                const reason = error instanceof Error ? error.message : String(error);
                currentCtx.ui.notify(
                    `Dock "${definition.id}" is showing its standalone view: ${reason}`,
                    "warning",
                );
                return;
            }
            snapshot = definition.getSnapshot(currentCtx);
            registry = shared;
            release = shared.registerContribution(currentCtx.ui, {
                id: definition.id,
                getSnapshot: () => snapshot!,
                subscribe(listener) {
                    listeners.add(listener);
                    return () => {
                        listeners.delete(listener);
                    };
                },
                activate: () => definition.activate(currentCtx),
                onHostPresenceChange(present) {
                    if (present) standalone.clear();
                    else standalone.render();
                },
            });
        },
        detach(options = {}) {
            release?.();
            release = undefined;
            registry = undefined;
            // Clear must stop standalone timers even when Pi has retired the old UI.
            if (options.retired) standalone.setCtx(undefined);
            if (ctx) standalone.clear();
            standalone.setCtx(undefined);
            snapshot = undefined;
            listeners.clear();
            ctx = undefined;
        },
        refresh(options = {}) {
            if (!ctx) return;
            if (options.summaryChanged !== false && release) {
                snapshot = definition.getSnapshot(ctx);
                for (const listener of listeners) listener(snapshot);
            }
            if (!release || !registry?.hasHost(ctx.ui)) standalone.render();
        },
    };
    return handle;
}
