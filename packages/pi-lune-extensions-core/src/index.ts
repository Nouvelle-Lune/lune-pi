/**
 * Common extension APIs; importing this entry does not acquire settings or open UI.
 *
 * Start with defineSettings -> bindSettings, then optionally defineSettingsPanel ->
 * registerSettingsPanel, all inside scopedExtension so cleanup follows Pi's
 * session_shutdown. Dock contributions borrow Pi contexts rather than owning sessions.
 * Native Pi events remain the business layer.
 *
 * Detailed contracts live in settings/types.ts, panel/section.ts and dock/types.ts.
 * Advanced ownership/storage lives under /settings/advanced and /settings/backend;
 * custom UI hosts use /panel/host or /dock/host; tests use /testing.
 * Import /panel/tui explicitly for the renderer and its optional pi-tui runtime peer.
 */
export { defineSettings, bindSettings, readGlobalSettings } from "./settings/index.ts";
export type { SettingsDefinition, SettingsBinding, SettingsView } from "./settings/index.ts";
export { defineSettingsPanel } from "./panel/definition.ts";
export type { SettingsPanelDefinition } from "./panel/definition.ts";
export { registerSettingsPanel } from "./panel/registration.ts";
export type { SettingsPanelRegistration } from "./panel/registration.ts";
export { ResourceScope, scopedExtension } from "./resources/index.ts";
export { createDockContribution } from "./dock/index.ts";
