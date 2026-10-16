/**
 * Discovery-free Dock service factory; Core Host composes the shared instance.
 *
 * Weak UI scopes isolate runners. Contributions keep membership/subscriptions even
 * without an aggregator so fallback/host transitions do not create a second state
 * owner. Mounted snapshots are complete replacements; retired callbacks/releases
 * compare identity before touching later registrations with the same ID.
 */
import { LUNE_DOCK_PROTOCOL_VERSION } from "./types.ts";
import type { LuneDockHost, LuneDockProvider, LuneDockSnapshot } from "./types.ts";

/** Provider plus optional host-presence observation for switching standalone UI. */
export interface DockContribution extends LuneDockProvider {
    /** true suppresses fallback; false restores it. Failures must remain observable. */
    onHostPresenceChange?(present: boolean): void;
}

/**
 * Host-readable current provider presentation; treat entries as borrowed registry state.
 * Snapshot publication replaces the entire snapshot, not individual optional levels.
 */
export interface MountedContribution {
    readonly id: string;
    readonly provider: LuneDockProvider;
    snapshot: LuneDockSnapshot;
}

/** Aggregator-owned render invalidation; business providers never own the host UI. */
export interface DockHost {
    invalidate(): void;
}

/**
 * UI-scoped Dock service with its own protocol, independent of outer Host discovery.
 * Use the same stable ctx.ui identity for contributor and host calls; distinct runner
 * objects must not merge. This registry owns coordination, not provider business state.
 */
export interface DockRegistry {
    /** Advertise LUNE_DOCK_PROTOCOL_VERSION even when no aggregator has attached. */
    readonly protocolVersion: number;
    /** Read initial truth, subscribe, and return an identity-protected release; duplicates throw. */
    registerContribution(scope: object, contribution: DockContribution): () => void;
    /**
     * One host per UI; reread provider truth before announcing presence/invalidation.
     * Failed attachment rolls back presence and reports rollback failures as well.
     */
    attachHost(scope: object, host: DockHost): () => void;
    /** Versioned provider facade, or undefined when this UI has no aggregator. */
    getHost(scope: object): LuneDockHost | undefined;
    hasHost(scope: object): boolean;
    /** Fresh membership array with borrowed entries in registration order; not a deep snapshot. */
    getContributions(scope: object): readonly MountedContribution[];
}

type Mounted = MountedContribution & { unsubscribe: () => void };
type Scope = {
    contributions: Map<string, DockContribution>;
    mounted: Map<string, Mounted>;
    host?: DockHost;
};

/**
 * Create isolated coordination state without process-global discovery.
 * Most hosts/contributors should use getDockRegistry so installed Core copies share it.
 */
export function createDockRegistry(): DockRegistry {
    const scopes = new WeakMap<object, Scope>();
    const stateFor = (scope: object): Scope => {
        let state = scopes.get(scope);
        if (!state) {
            state = { contributions: new Map(), mounted: new Map() };
            scopes.set(scope, state);
        }
        return state;
    };
    const notifyPresence = (contributions: Iterable<DockContribution>, present: boolean): void => {
        const errors: unknown[] = [];
        for (const contribution of contributions) {
            try {
                contribution.onHostPresenceChange?.(present);
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length) throw new AggregateError(errors, "Lune dock host transition failed");
    };

    return {
        protocolVersion: LUNE_DOCK_PROTOCOL_VERSION,
        registerContribution(scope, contribution) {
            const state = stateFor(scope);
            if (state.contributions.has(contribution.id)) {
                throw new Error(`Duplicate Lune dock contribution: ${contribution.id}`);
            }
            const mounted: Mounted = {
                id: contribution.id,
                provider: contribution,
                snapshot: contribution.getSnapshot(),
                unsubscribe: () => {},
            };
            // Install identity before subscribe, which may synchronously publish a replacement.
            state.contributions.set(contribution.id, contribution);
            state.mounted.set(contribution.id, mounted);
            try {
                mounted.unsubscribe = contribution.subscribe((snapshot) => {
                    if (state.mounted.get(contribution.id) !== mounted) return;
                    mounted.snapshot = snapshot;
                    state.host?.invalidate();
                });
                contribution.onHostPresenceChange?.(state.host !== undefined);
            } catch (error) {
                state.contributions.delete(contribution.id);
                state.mounted.delete(contribution.id);
                mounted.unsubscribe();
                throw error;
            }
            state.host?.invalidate();
            return () => {
                // A retired handle cannot remove a later registration with the same ID.
                if (state.contributions.get(contribution.id) !== contribution) return;
                state.contributions.delete(contribution.id);
                state.mounted.delete(contribution.id);
                mounted.unsubscribe();
                state.host?.invalidate();
            };
        },
        attachHost(scope, host) {
            const state = stateFor(scope);
            if (state.host) throw new Error("A Lune dock host is already attached to this UI");
            state.host = host;
            try {
                for (const mounted of state.mounted.values()) {
                    mounted.snapshot = mounted.provider.getSnapshot();
                }
                notifyPresence(state.contributions.values(), true);
                host.invalidate();
            } catch (error) {
                // No release handle exists after failed initialization, so ownership must roll back.
                state.host = undefined;
                try {
                    notifyPresence(state.contributions.values(), false);
                } catch (cleanupError) {
                    throw new AggregateError(
                        [error, cleanupError],
                        "Lune dock host attachment and cleanup failed",
                    );
                }
                throw error;
            }
            return () => {
                if (state.host !== host) return;
                state.host = undefined;
                notifyPresence(state.contributions.values(), false);
            };
        },
        hasHost: (scope) => scopes.get(scope)?.host !== undefined,
        getHost(scope) {
            if (!scopes.get(scope)?.host) return undefined;
            return {
                protocolVersion: this.protocolVersion,
                register: (provider) => this.registerContribution(scope, provider),
            };
        },
        getContributions: (scope) => [...stateFor(scope).mounted.values()],
    };
}
