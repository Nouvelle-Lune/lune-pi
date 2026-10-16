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
    type SettingsChoiceSource,
    type SettingsFieldOptions,
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

/** Presentation only; omission of fields exposes all top-level schema keys in order. */
export interface SettingsPanelOptions<T extends TObject> {
    /** Registry identity; defaults to the Settings ID and must be unique in one UI scope. */
    id?: string;
    label: string;
    /** Array or typed builder; only declared fields are shown, in their declared order. */
    fields?:
        | readonly SettingsPanelFieldDefinition<T>[]
        | ((field: SettingsFieldBuilder<T>) => readonly SettingsPanelFieldDefinition<T>[]);
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
    assertSettingsGroups(fields);
    return Object.freeze({ settings, id, label: options.label, fields: Object.freeze(fields) });
}
