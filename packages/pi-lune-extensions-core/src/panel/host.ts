/**
 * Custom Panel host entry: adapt borrowed views and register sections by UI identity.
 *
 * Factories create isolated registries; getSettingsPanelRegistry discovers the shared
 * process-local registry through Core Host. Use the stable native ctx.ui object as
 * scope, detach sections before releasing their views, and own returned unsubscribe
 * handles. Rendering remains an explicit /panel/tui responsibility.
 */
import { getCoreHost } from "../core/host.ts";
import type { SettingsPanelRegistry } from "./registry.ts";
import type { SettingsSection } from "./section.ts";

export { createSettingsPanelRegistry } from "./registry.ts";
export type { SettingsPanelRegistry } from "./registry.ts";
export { createSettingsSection } from "./section.ts";
export { createDefinedSettingsSection } from "./defined-section.ts";

/**
 * Reuse the shared registry without loading the Core command extension.
 * Incompatible outer Host protocols/shapes throw rather than split UI discovery.
 */
export function getSettingsPanelRegistry(): SettingsPanelRegistry {
    return getCoreHost().panel;
}

/**
 * Register one borrowed section in a UI scope; duplicate section/field IDs throw.
 *
 * The returned synchronous release is idempotent and cannot remove a replacement
 * registration. It may throw if a registry observer fails after removal. Detach
 * before releasing the section's view; this function does not close that view.
 * @param scope The stable ctx.ui object, shared by hosts and contributors.
 */
export function registerSettingsSection(scope: object, section: SettingsSection): () => void {
    return getSettingsPanelRegistry().register(scope, section);
}
