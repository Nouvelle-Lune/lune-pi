/**
 * Static presentation declarations, separate from Settings persistence/ownership.
 *
 * Normalize and validate paths/editors before acquiring any live view or UI scope.
 * Field order, paths, choice values and candidate ranges are snapshotted; callbacks
 * retain identity so schema-backed declarations remain reusable across sessions.
 * registration.ts mounts these declarations; defined-section.ts binds their paths.
 */
import { Value } from "typebox/value";
import type { Static, TObject } from "typebox";
import { freezeValue, schemaAtPath, type SettingsDefinition } from "../settings/definition.ts";
import type { SettingsPath, SettingsPathValue } from "../settings/types.ts";
import {
    assertSettingsGroups,
    resolveSettingsFieldOptions,
    type SettingsChoiceContext,
    type SettingsChoiceSource,
    type SettingsFieldOptions,
    type SettingsMenu,
} from "./section.ts";

/** Path/value-correlated metadata; paths reference only required object properties. */
export type SettingsPanelFieldDefinition<T extends TObject, P = SettingsPath<T>> = P extends unknown
    ? { path: P } & SettingsFieldOptions<SettingsPathValue<Static<T>, P>, Static<T>>
    : never;

/**
 * Bind the path before metadata so nested value/preview callbacks infer that path's type.
 * NoInfer prevents metadata from widening the inferred path to fit an unrelated value.
 */
export type SettingsFieldBuilder<T extends TObject> = <const P extends SettingsPath<T>>(
    path: P,
    options?: SettingsFieldOptions<SettingsPathValue<Static<T>, NoInfer<P>>, Static<T>>,
) => SettingsPanelFieldDefinition<T>;

/**
 * A row that opens a secondary menu of fields the consumer builds, such as entries kept
 * outside this panel's Settings. Callbacks receive the panel's values at the viewed scope.
 */
export interface SettingsMenuDefinition<TValues> {
    /** Unique among the panel's menus and field IDs (a path, or a nested path as JSON). */
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    /** See SettingsFieldOptions.group; menus follow the fields in the group order rules. */
    readonly group?: string;
    visible?(context: SettingsChoiceContext<TValues>): boolean;
    disabled?(context: SettingsChoiceContext<TValues>): string | undefined;
    /** Text beside the label, such as a count of the menu's entries. */
    summary?(context: SettingsChoiceContext<TValues>): string;
    /** Build the page; called again on every refresh while the menu is open. */
    open(context: SettingsChoiceContext<TValues>): SettingsMenu;
}

/** Presentation only; omission of fields exposes all top-level schema keys in order. */
export interface SettingsPanelOptions<T extends TObject> {
    /** Registry identity; defaults to the Settings ID and must be unique in one UI scope. */
    id?: string;
    label: string;
    /** Array or typed builder; only declared fields are shown, in their declared order. */
    fields?:
        | readonly SettingsPanelFieldDefinition<T>[]
        | ((field: SettingsFieldBuilder<T>) => readonly SettingsPanelFieldDefinition<T>[]);
    /** Secondary menu rows, listed after the fields in this order. */
    menus?: readonly SettingsMenuDefinition<Static<T>>[];
}

/**
 * Frozen reusable metadata referencing a Settings declaration, not a live view.
 * Creating it neither acquires configuration nor makes a section visible.
 */
export interface SettingsPanelDefinition<T extends TObject> {
    readonly settings: SettingsDefinition<T>;
    readonly id: string;
    readonly label: string;
    readonly fields: readonly SettingsPanelFieldDefinition<T>[];
    readonly menus: readonly SettingsMenuDefinition<Static<T>>[];
}

/**
 * Snapshot/validate a presentation contract without installing lifecycle hooks.
 *
 * Omitted fields derive all top-level schema keys. A builder preserves nested tuple
 * inference; paths cannot duplicate or overlap ancestors because two controls would
 * compete to edit the same value. Static choices/editor conflicts are checked now;
 * dynamic source values are checked when loaded by the editor.
 *
 * @returns Frozen metadata; choice data is cloned while callback identities survive.
 * @throws TypeError For empty identity/label, invalid paths, overlaps or editor metadata.
 * @example
 * const panel = defineSettingsPanel(definition, {
 *     label: "Example",
 *     fields: field => [field("enabled", { label: "Enabled" })],
 * });
 */
export function defineSettingsPanel<T extends TObject>(
    settings: SettingsDefinition<T>,
    options: SettingsPanelOptions<T>,
): SettingsPanelDefinition<T> {
    const id = options.id ?? settings.id;
    if (!id.trim() || !options.label.trim())
        throw new TypeError("Settings panel id and label must not be empty");
    const field: SettingsFieldBuilder<T> = (path, metadata) =>
        ({ path, ...metadata }) as unknown as SettingsPanelFieldDefinition<T>;
    const declared = typeof options.fields === "function" ? options.fields(field) : options.fields;
    const fields = (
        declared ?? Object.keys(settings.schema.properties).map((path) => ({ path }))
    ).map((input) => {
        const metadata = input as SettingsPanelFieldDefinition<T>;
        const source = metadata.choiceSource as
            | SettingsChoiceSource<unknown, Static<T>>
            | undefined;
        return Object.freeze({
            ...metadata,
            path:
                typeof metadata.path === "string"
                    ? metadata.path
                    : Object.freeze([...metadata.path]),
            choices: metadata.choices
                ? Object.freeze(
                      metadata.choices.map((choice) =>
                          Object.freeze({
                              ...choice,
                              value: freezeValue(Value.Clone(choice.value)),
                          }),
                      ),
                  )
                : undefined,
            choiceSource: source
                ? Object.freeze({
                      ...source,
                      scopes: source.scopes ? Object.freeze([...source.scopes]) : undefined,
                  })
                : undefined,
        }) as SettingsPanelFieldDefinition<T>;
    });
    // Parent/child controls would each materialize the same top-level override.
    const paths = fields.map(({ path }) => (typeof path === "string" ? [path] : [...path]));
    for (let index = 0; index < paths.length; index++) {
        const path = paths[index]!;
        resolveSettingsFieldOptions(
            JSON.stringify(path),
            schemaAtPath(settings.schema, path),
            fields[index],
        );
        if (
            paths
                .slice(0, index)
                .some((other) =>
                    other
                        .slice(0, Math.min(other.length, path.length))
                        .every((key, offset) => key === path[offset]),
                )
        )
            throw new TypeError(`Overlapping settings panel path ${JSON.stringify(path)}`);
    }
    const menus = (options.menus ?? []).map((menu) => Object.freeze({ ...menu }));
    // The same IDs createDefinedSettingsSection gives the fields.
    const ids = new Set<string>(
        fields.map(({ path }) => (typeof path === "string" ? path : JSON.stringify(path))),
    );
    for (const menu of menus) {
        if (!menu.id.trim() || !menu.label.trim())
            throw new TypeError("Settings menu id and label must not be empty");
        if (ids.has(menu.id)) throw new TypeError(`Duplicate settings panel id "${menu.id}"`);
        ids.add(menu.id);
        if (typeof menu.open !== "function")
            throw new TypeError(`Settings menu "${menu.id}" requires an open function`);
        for (const name of ["visible", "disabled", "summary"] as const)
            if (menu[name] !== undefined && typeof menu[name] !== "function")
                throw new TypeError(`Settings ${name} for menu "${menu.id}" must be a function`);
    }
    assertSettingsGroups([...fields, ...menus]);
    return Object.freeze({
        settings,
        id,
        label: options.label,
        fields: Object.freeze(fields),
        menus: Object.freeze(menus),
    });
}
