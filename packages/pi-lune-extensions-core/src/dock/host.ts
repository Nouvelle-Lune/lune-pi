/**
 * Dock host entry for aggregators that render registered contributor snapshots.
 *
 * Core Host provides shared discovery; this boundary separately validates the Dock
 * protocol before reuse. Registry factories are isolated and do not bootstrap or
 * replace process-global state. A host owns layout/input, not contributor business
 * state; provider and single-line snapshot contracts are defined in types.ts.
 */
import { getCoreHost } from "../core/host.ts";
import type { DockRegistry } from "./registry.ts";
import { LUNE_DOCK_PROTOCOL_VERSION } from "./types.ts";

export { createDockRegistry } from "./registry.ts";
export type { DockRegistry, DockHost, DockContribution, MountedContribution } from "./registry.ts";

/**
 * Return the shared Dock service only when its own protocol matches this copy.
 *
 * A missing/mismatched Dock version throws without replacing the outer Host or
 * preventing compatible Settings/Panel access. npm versions are not ABI checks.
 */
export function getDockRegistry(): DockRegistry {
    const registry = getCoreHost().dock;
    if (registry.protocolVersion !== LUNE_DOCK_PROTOCOL_VERSION)
        throw new Error(
            `Incompatible Lune Dock protocol: loaded=${registry.protocolVersion}, required=${LUNE_DOCK_PROTOCOL_VERSION}`,
        );
    return registry;
}
