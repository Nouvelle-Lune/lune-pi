import { Type, type Static, type TLiteral } from "typebox";
import { defineSettings, type SettingsView } from "@lune_99/pi-lune-extensions-core/settings";
import { DOCK_STYLES } from "./dock-footer.ts";

export const SETTINGS_ID = "pi-dock";

function choice<const T extends readonly string[]>(values: T, initial: T[number]) {
    const variants = values.map((value) => Type.Literal(value)) as {
        -readonly [K in keyof T]: TLiteral<T[K]>;
    };
    return Type.Union<{ -readonly [K in keyof T]: TLiteral<T[K]> }>(
        [...variants] as [...{ -readonly [K in keyof T]: TLiteral<T[K]> }],
        { default: initial },
    );
}

export const dockSchema = Type.Object({
    enabled: Type.Boolean({ default: true }),
    displayMode: choice(["base", "detail", "full"] as const, "detail"),
    style: choice(DOCK_STYLES, "ruled"),
    showModel: Type.Boolean({ default: true }),
    showWorkspace: Type.Boolean({ default: true }),
    showUsage: Type.Boolean({ default: true }),
    // Contribution IDs are not known until runtime, so visibility and order cannot be per-ID fields.
    hidden: Type.Array(Type.String({ minLength: 1 }), { default: [], uniqueItems: true }),
    order: Type.Record(Type.String({ minLength: 1 }), Type.Integer(), { default: {} }),
});

export type DockSettings = Static<typeof dockSchema>;
export type DockSettingsView = SettingsView<typeof dockSchema>;

export const dockSettings = defineSettings({ id: SETTINGS_ID, schema: dockSchema });
