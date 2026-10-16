/**
 * Renderer-free Panel declarations, native registration and model choice helpers.
 *
 * Read definition.ts for immutable metadata, registration.ts for borrowed Settings
 * ownership, and section.ts for choices, previews and custom field contracts.
 * modelChoices delegates discovery to Pi; it never executes or selects a model.
 *
 * This entry uses Pi peers as types only. Import /panel/tui to open an interactive
 * renderer, or /panel/host to adapt/register a custom section against a live view.
 */
export { defineSettingsPanel } from "./definition.ts";
export type {
    SettingsPanelDefinition,
    SettingsPanelOptions,
    SettingsPanelFieldDefinition,
    SettingsFieldBuilder,
} from "./definition.ts";
export { registerSettingsPanel } from "./registration.ts";
export type { SettingsPanelRegistration } from "./registration.ts";
export { modelChoices } from "./tools/model-choices.ts";
export type {
    ModelReference,
    ModelChoiceScope,
    ModelChoicesOptions,
} from "./tools/model-choices.ts";
export type {
    SettingsEditor,
    SettingsPanelSchema,
    SettingsChoiceContext,
    SettingsChoiceSource,
    SettingsChoice,
    SettingsPreview,
    SettingsCustomEditor,
    SettingsCustomEditorContext,
    SettingsEditorComponent,
    SettingsFieldOptions,
    SettingsPanelField,
    SettingsSection,
} from "./section.ts";
