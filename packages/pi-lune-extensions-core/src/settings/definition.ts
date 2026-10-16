/**
 * Static Settings declarations; validation here must not acquire backend/UI resources.
 *
 * Definitions describe persistence identity, schema, upgrades and scope policy, not
 * presentation. Clone and freeze declaration data so later caller mutations cannot
 * change a live contract. Acquisition lives in acquire.ts; native session ownership
 * lives in binding.ts.
 */
import { Value } from "typebox/value";
import { IsOptional, type TObject } from "typebox";
import { assertSettingsSchema, type SettingsKey } from "./types.ts";
import type { SettingsBackendFactory } from "./backend.ts";

/**
 * Upgrade stored overrides by exactly one settings version.
 *
 * Receives an isolated copy of one scope's overrides (no defaults, no `$` metadata)
 * and returns that scope's overrides for the next version. Keep it synchronous and
 * pure: it runs during acquisition, once per stored file that holds overrides (scopes
 * with none skip migrations), and its result is validated against the current schema
 * before it is written back.
 */
export type SettingsMigration = (overrides: Record<string, unknown>) => Record<string, unknown>;

/**
 * Reusable persistence contract, independent of any session or Panel registration.
 * Pass through defineSettings before reuse; backend factories retain their identity.
 */
export interface SettingsDefinition<T extends TObject> {
    /**
     * Stable namespace key and file name: lowercase letters, digits, ".", "_" or "-",
     * starting and ending with a letter or digit. Changing it selects new storage.
     */
    readonly id: string;
    /** Required top-level properties with defaults accepted by their own schemas. */
    readonly schema: T;
    /**
     * Ordered upgrades. Stored data at version n passes through migrations[n - 1];
     * the current version is migrations.length + 1. Never remove or reorder entries
     * that have shipped. File storage only; custom backends own their upgrades.
     */
    readonly migrations?: readonly SettingsMigration[];
    /**
     * Top-level keys that are never read from or written to project files, such as
     * credentials or endpoints that a cloned repository must not override.
     */
    readonly globalOnly?: readonly SettingsKey<T>[];
    /** Omit for Pi global/project JSON files; custom factories transfer one release obligation. */
    readonly backend?: SettingsBackendFactory<T>;
}

/** Frozen, normalized declaration returned by defineSettings. */
export interface DefinedSettings<T extends TObject> extends SettingsDefinition<T> {
    readonly migrations: readonly SettingsMigration[];
    readonly globalOnly: readonly SettingsKey<T>[];
}

const SETTINGS_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * Freeze cloned declaration/snapshot trees, including symbol-keyed schema metadata.
 * Call with acyclic data, not runtime resource owners; functions keep their identity.
 * @internal
 */
export function freezeValue<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const key of Reflect.ownKeys(value)) freezeValue(Reflect.get(value, key));
        Object.freeze(value);
    }
    return value;
}

/** Current stored-data version: one more than the number of shipped migrations. */
export function settingsVersion(definition: SettingsDefinition<TObject>): number {
    return (definition.migrations?.length ?? 0) + 1;
}

/**
 * Resolve only required object-property paths, avoiding ambiguous optional bindings.
 * Arrays are editable as whole values, not traversed by index. Empty/unknown paths
 * throw before a field can acquire UI resources or accept writes.
 * @internal
 */
export function schemaAtPath(schema: TObject, path: readonly string[]) {
    if (!path.length) throw new TypeError("Settings paths must not be empty");
    let current = schema;
    for (const key of path) {
        if (
            current.type !== "object" ||
            !current.properties ||
            !Object.hasOwn(current.properties, key)
        )
            throw new TypeError(`Unknown settings path ${JSON.stringify(path)}`);
        if (IsOptional(current.properties[key]!))
            throw new TypeError(
                `Settings paths must reference required properties: ${JSON.stringify(path)}`,
            );
        current = current.properties[key] as TObject;
    }
    return current;
}

/**
 * Validate and snapshot a Settings contract without reading files or installing hooks.
 *
 * Every top-level field must be required and have a schema-valid default; names
 * starting with "$" are reserved for stored metadata. The result and cloned schema
 * trees are frozen; backend and migration callbacks keep their identity. Panel
 * metadata belongs in defineSettingsPanel, and an embedded panel property is rejected.
 *
 * @throws TypeError For an invalid ID, optional/missing/invalid defaults, reserved
 *     names, unknown or duplicate global-only keys, migrations combined with a
 *     custom backend, or embedded UI.
 * @example
 * const definition = defineSettings({
 *     id: "example",
 *     schema: Type.Object({ enabled: Type.Boolean({ default: true }) }),
 * });
 */
export function defineSettings<T extends TObject>(
    definition: SettingsDefinition<T>,
): DefinedSettings<T> {
    if (!SETTINGS_ID.test(definition.id))
        throw new TypeError(
            `Settings id "${definition.id}" must use lowercase letters, digits, ".", "_" or "-", and start and end with a letter or digit`,
        );
    if ("panel" in definition)
        throw new TypeError("Declare panels separately with defineSettingsPanel");
    assertSettingsSchema(definition.schema);
    const reserved = Object.keys(definition.schema.properties).find((key) => key.startsWith("$"));
    if (reserved !== undefined)
        throw new TypeError(`Setting "${reserved}" must not start with "$"; it is reserved`);
    const migrations = definition.migrations ?? [];
    if (migrations.some((migration) => typeof migration !== "function"))
        throw new TypeError(`Settings "${definition.id}" migrations must be functions`);
    if (migrations.length && definition.backend)
        throw new TypeError(
            `Settings "${definition.id}" cannot combine migrations with a custom backend; the backend owns upgrades`,
        );
    const globalOnly = definition.globalOnly ?? [];
    for (const key of globalOnly)
        if (!Object.hasOwn(definition.schema.properties, key))
            throw new TypeError(`Unknown global-only setting "${key}" in "${definition.id}"`);
    if (new Set(globalOnly).size !== globalOnly.length)
        throw new TypeError(`Duplicate global-only settings in "${definition.id}"`);
    return Object.freeze({
        id: definition.id,
        schema: freezeValue(Value.Clone(definition.schema)),
        migrations: Object.freeze([...migrations]),
        globalOnly: Object.freeze([...globalOnly]),
        backend: definition.backend,
    });
}
