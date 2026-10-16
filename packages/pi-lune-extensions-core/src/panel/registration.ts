/** Panel projection of binding readiness; Pi lifecycle and storage remain binding-owned. */
import { isDeepStrictEqual } from "node:util";
import type { TObject } from "typebox";
import { observeSettingsBinding, type SettingsBinding } from "../settings/binding.ts";
import type { SettingsPanelDefinition } from "./definition.ts";
import { createDefinedSettingsSection } from "./defined-section.ts";
import { registerSettingsSection } from "./host.ts";
import type { SettingsSection } from "./section.ts";

// Include causes: migration and storage errors explain the file and step in their cause.
function describe(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause !== undefined ? describe(error.cause) : "";
    return cause ? `${message}: ${cause}` : message;
}

/** Ownership of the binding subscription and mounted section, never borrowed Settings. */
export interface SettingsPanelRegistration {
    /** Unmount/unsubscribe once; share completion and aggregate retained cleanup errors. */
    dispose(): Promise<void>;
}

/**
 * Project a binding's current view into a declared Panel, including after startup.
 *
 * The binding must be live and created by this Core copy.
 * Definition ID/schema/backend identity must match the binding. RPC/print modes keep
 * Settings usable but register no section. Duplicate Panel IDs reject the newcomer.
 * When loading fails, an unavailable section reports the error, and reloading it
 * retries the binding's acquisition for the same session.
 * No Pi hooks or view-signal watchers are installed; binding retirement unmounts first.
 *
 * Dispose before the binding (ResourceScope reverse acquisition order is suitable).
 * The handle never releases borrowed Settings, even when setup or cleanup fails.
 * @throws TypeError For mismatched declarations or foreign bindings; registry errors propagate.
 * @throws DOMException With AbortError when the binding has already retired.
 */
export function registerSettingsPanel<T extends TObject>(
    panel: SettingsPanelDefinition<T>,
    settings: SettingsBinding<T>,
): SettingsPanelRegistration {
    if (
        panel.settings.id !== settings.definition.id ||
        panel.settings.backend !== settings.definition.backend ||
        !isDeepStrictEqual(panel.settings.schema, settings.definition.schema)
    )
        throw new TypeError("Settings panel and binding definitions do not match");
    let release: (() => void) | undefined;
    let disposal: Promise<void> | undefined;
    const errors: unknown[] = [];
    const unmount = (unregister = release) => {
        release = undefined;
        try {
            unregister?.();
        } catch (error) {
            errors.push(error);
        }
    };
    const unsubscribe = observeSettingsBinding(settings, (state) => {
        unmount();
        if (!state || state.context.mode !== "tui") return;
        const section: SettingsSection =
            state.status === "ready"
                ? createDefinedSettingsSection(state.view, panel)
                : {
                      id: panel.id,
                      label: panel.label,
                      fields: [],
                      scopes: [],
                      unavailable: describe(state.error),
                      subscribe: () => () => {},
                      reload: () => state.retry(),
                  };
        // Registry observers can retire this mount before its release handle is returned.
        let active = true;
        release = () => {
            active = false;
        };
        const unregister = registerSettingsSection(state.context.ui, section);
        if (active) release = unregister;
        else unmount(unregister);
    });
    return {
        dispose() {
            if (disposal) return disposal;
            disposal = Promise.resolve().then(() => {
                if (errors.length)
                    throw new AggregateError(errors, "Settings panel cleanup failed");
            });
            unsubscribe();
            unmount();
            return disposal;
        },
    };
}
