/**
 * Settings consumer entry: declarations, native lifecycle binding and leased views.
 *
 * Read definition.ts for schema, migration and scope invariants, binding.ts for session
 * readiness, and types.ts for precedence, writes and retirement. Persistence is
 * backend-owned; this entry does not own Panel metadata or model/UI behavior.
 *
 * Use /settings/advanced only when manually owning a lease and /settings/backend when
 * implementing storage.
 */
export { defineSettings } from "./definition.ts";
export { bindSettings } from "./binding.ts";
export { readGlobalSettings } from "./acquire.ts";
export type { SettingsDefinition, DefinedSettings, SettingsMigration } from "./definition.ts";
export type { SettingsBinding, SettingsContext } from "./binding.ts";
export {
    assertSettingsSchema,
    SettingsNotificationError,
    isSettingsNotificationError,
} from "./types.ts";
export type {
    SettingsView,
    SettingsField,
    SettingsPath,
    SettingsPathValue,
    DeepReadonly,
    SettingInspection,
    SettingsKey,
    SettingsSchema,
    SettingsScope,
} from "./types.ts";
