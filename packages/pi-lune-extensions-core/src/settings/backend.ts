/**
 * Custom storage SPI; ordinary consumers should use SettingsView instead.
 *
 * The factory must return a usable backend with the declaration's ID/schema and a
 * release handle for that acquisition. acquire.ts wraps it in a lease-local view;
 * it does not initialize custom storage or own the backend's internal policy.
 * See docs/custom-backend.md for the complete ownership and transaction contract.
 */
import type { Static, TObject } from "typebox";
import type { SettingInspection, SettingsKey, SettingsSchema, SettingsScope } from "./types.ts";

/**
 * Resolve only when reads are ready; synchronous and asynchronous factories are valid.
 * cwd is the owning session's project directory. When projectTrusted is false the
 * backend must neither read nor write project state; views also reject such access.
 * Shared implementations must balance each acquisition's release without closing
 * state borrowed by another caller. A mismatched backend is released and rejected.
 */
export type SettingsBackendFactory<T extends TObject> = (context: {
    cwd: string;
    projectTrusted: boolean;
}) =>
    | { backend: SettingsBackend<T>; release(): void | Promise<void> }
    | Promise<{ backend: SettingsBackend<T>; release(): void | Promise<void> }>;

/**
 * Storage authority for validation, committed state and whole-value inheritance.
 *
 * Reads must provide project -> global -> default precedence. Mutations must validate
 * before commit and serialize read/modify/write operations, not just final writes.
 * Upgrading stored data across schema versions is the backend's own responsibility.
 * Observer failures after commit use SettingsNotificationError, not an I/O failure.
 * The schema must remain stable for the acquisition; callers must not mutate it.
 */
export interface SettingsBackend<TSchema extends TObject> {
    readonly id: string;
    readonly settingSchema: SettingsSchema<TSchema>;
    /** Report explicit overrides separately from the inherited effective value. */
    inspect<K extends SettingsKey<TSchema>>(key: K): SettingInspection<Static<TSchema>[K]>;
    /** Replace one validated top-level override; omitted scope means global. */
    set<K extends SettingsKey<TSchema>>(
        key: K,
        value: Static<TSchema>[K],
        options?: { scope?: SettingsScope },
    ): Promise<void>;
    /** Remove the selected override so lower-precedence state becomes visible. */
    reset<K extends SettingsKey<TSchema>>(
        key: K,
        options?: { scope?: SettingsScope },
    ): Promise<void>;
    /** Observe committed changes; return cleanup for this subscription, not the backend. */
    subscribe(listener: () => void): () => void;
    /** Reread external state without silently substituting defaults for invalid values. */
    reload(): Promise<void>;
    /**
     * Optional transaction required for nested field edits; not an external get/set pair.
     * Invoke transform with isolated scope-local current and inherited values inside
     * serialization. Global inherits defaults; project inherits global then defaults.
     * Undefined removes the override; otherwise validate the complete replacement.
     */
    update?<K extends SettingsKey<TSchema>>(
        key: K,
        transform: (
            value: Static<TSchema>[K],
            inherited: Static<TSchema>[K],
        ) => Static<TSchema>[K] | undefined,
        options?: { scope?: SettingsScope },
    ): Promise<void>;
}
