/**
 * Discovery-free Panel registry factory used by the unified Core Host.
 *
 * UI scope is a weak identity, normally native ctx.ui; sections in different runners
 * never share tabs. The registry owns membership/observation only, not view storage
 * or rendering. Release handles compare section identity to protect later owners.
 */
import type { SettingsSection } from "./section.ts";

/** Host contract for UI-scoped section membership and change observation. */
export interface SettingsPanelRegistry {
    /**
     * Reject duplicate section/field IDs and return an idempotent release.
     * Observer failure on registration rolls back membership; failure on removal
     * is reported after membership was removed, so callers must not assume it remains.
     */
    register(scope: object, section: SettingsSection): () => void;
    /** Snapshot membership in registration order; section objects remain borrowed. */
    getSections(scope: object): readonly SettingsSection[];
    /** Observe membership changes only; field changes are each section's responsibility. */
    subscribe(scope: object, listener: () => void): () => void;
}

type Scope = { sections: Map<string, SettingsSection>; listeners: Set<() => void> };

/**
 * Create isolated state without registering a global discovery key.
 * Ordinary shared consumers use /panel/host getSettingsPanelRegistry instead.
 */
export function createSettingsPanelRegistry(): SettingsPanelRegistry {
    const scopes = new WeakMap<object, Scope>();
    const stateFor = (scope: object): Scope => {
        let state = scopes.get(scope);
        if (!state) {
            state = { sections: new Map(), listeners: new Set() };
            scopes.set(scope, state);
        }
        return state;
    };
    const notify = (state: Scope): void => {
        const errors: unknown[] = [];
        for (const listener of [...state.listeners]) {
            try {
                listener();
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length)
            throw new AggregateError(errors, "Settings panel registry listeners failed");
    };
    return {
        register(scope, section) {
            const state = stateFor(scope);
            if (state.sections.has(section.id))
                throw new Error(`Duplicate settings section "${section.id}"`);
            if (new Set(section.fields.map(({ id }) => id)).size !== section.fields.length) {
                throw new Error(`Duplicate fields in settings section "${section.id}"`);
            }
            state.sections.set(section.id, section);
            try {
                notify(state);
            } catch (error) {
                state.sections.delete(section.id);
                throw error;
            }
            return () => {
                if (state.sections.get(section.id) !== section) return;
                state.sections.delete(section.id);
                notify(state);
            };
        },
        getSections: (scope) => [...stateFor(scope).sections.values()],
        subscribe(scope, listener) {
            const listeners = stateFor(scope).listeners;
            const subscription = () => listener();
            listeners.add(subscription);
            return () => {
                listeners.delete(subscription);
            };
        },
    };
}
