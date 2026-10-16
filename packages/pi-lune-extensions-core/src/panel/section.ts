/**
 * Renderer-neutral contracts for fields, sections, choices and passive previews.
 *
 * A section borrows a Settings view; registries discover it and /panel/tui edits it.
 * Global/project selects the persistence view, while candidateScope filters a dynamic
 * list. Adapters include hidden settings in callback snapshots and overlay preview
 * candidates only in clones. Validation/editor resolution stays usable without TUI.
 */
import { Value } from "typebox/value";
import type { Static, TObject, TSchema } from "typebox";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
    SettingInspection,
    SettingsView,
    SettingsKey,
    SettingsScope,
} from "../settings/types.ts";

/**
 * Candidate identity/value independent of its display label.
 * Values must satisfy the field schema (item schema for multiple sources); disabled
 * entries still need valid values because they may represent saved/unavailable choices.
 */
export interface SettingsChoice<T = unknown> {
    value: T;
    label: string;
    description?: string;
    /** Shown beside the label; identifies where a long identity comes from. */
    badge?: string;
    /** Extra search terms that must not widen the visible label. */
    searchText?: string;
    /** Explains why an entry cannot be selected; choosing it reports this text. */
    disabled?: string;
}

/**
 * Context captured for the editor's persistence scope, not its candidate range.
 * Schema-backed adapters collect all scoped settings, including fields not displayed;
 * custom adapters may supply a different values payload. Pi context remains borrowed.
 */
export interface SettingsChoiceContext<TValues = unknown> {
    values: TValues;
    scope: SettingsScope;
    context: ExtensionContext;
}

/**
 * Cancellable discovery contract; callers may request new ranges while work is pending.
 * Honor signal and do not mutate live Settings/model/UI state. The editor rejects
 * invalid values, ignores retired results, and retains selection outside search results.
 */
export interface SettingsChoiceSource<T = unknown, TValues = unknown> {
    /** Array fields toggle an unsaved selection; Enter may confirm an empty array. */
    multiple?: boolean;
    emptyMessage?: string;
    /** `inline` gives the full identity one row instead of a fixed description column. */
    rowLayout?: "columns" | "inline";
    /** Candidate ranges; they filter choices and never change where values are written. */
    scopes?: readonly string[];
    /** Initial candidate range; must be declared in scopes when ranges are provided. */
    defaultScope?(context: ExtensionContext): string;
    /**
     * Produce a complete list for one request; synchronous results remain immediate.
     * signal belongs to discovery, scope to persistence, candidateScope to filtering.
     * Failures are displayed without persisting an unvalidated candidate.
     */
    load(
        context: SettingsChoiceContext<TValues> & { candidateScope?: string; signal: AbortSignal },
    ): readonly SettingsChoice<T>[] | Promise<readonly SettingsChoice<T>[]>;
    /** Explicit refresh before reloading choices; cancellation/provider errors must propagate. */
    refresh?(context: SettingsChoiceContext<TValues> & { signal: AbortSignal }): Promise<void>;
}

/**
 * Passive component created from an unsaved candidate and scoped snapshot.
 * Schema-backed adapters overlay the candidate in values without writing storage.
 * Do not install live widgets or persist here; the interaction bounds rendering and
 * calls an optional component dispose method when replacing/closing the preview.
 */
export type SettingsPreview<T, TValues> = (context: {
    value: T;
    values: TValues;
    theme: Theme;
    scope: SettingsScope;
}) => Component;

/**
 * Host services for one open custom editor; the field and write scope are fixed when it opens.
 * submit validates the candidate against the field schema and saves it at that scope:
 * success closes the editor, while invalid values and failed writes are reported and
 * keep it open. Calls after the editor has closed have no effect.
 */
export interface SettingsCustomEditorContext<T, TValues> extends SettingsChoiceContext<TValues> {
    /** Isolated copy of the field's value at the edited scope. */
    readonly value: T;
    readonly theme: Theme;
    submit(value: T): void;
    /** Close without saving. */
    cancel(): void;
    /** Redraw after state changes that did not come from handleInput, such as async work. */
    requestRender(): void;
}

/**
 * Component a custom editor renders inside the panel frame.
 * It receives every key except Escape, which the panel keeps so an editor can always be
 * left. dispose runs when the editor closes for any reason, including panel shutdown.
 */
export interface SettingsEditorComponent extends Component {
    handleInput(data: string): void;
    /** Key hints for the panel's help line while the editor is open. */
    readonly help?: string;
    /** Set by the panel when its own focus changes, for components that draw a cursor. */
    focused?: boolean;
    dispose?(): void;
}

/** Build the editor for one edit; it must not persist on its own, only through submit. */
export type SettingsCustomEditor<T, TValues> = (
    context: SettingsCustomEditorContext<T, TValues>,
) => SettingsEditorComponent;

/**
 * cycle commits static choices immediately; select confirms a candidate list.
 * text accepts raw strings only; number accepts one finite number for number/integer
 * schemas; json parses then validates complete JSON values; custom hands editing to
 * the field's customEditor. Preview availability does not determine the editor.
 */
export type SettingsEditor = "cycle" | "select" | "text" | "number" | "json" | "custom";

/**
 * Field presentation/editing metadata, not storage policy.
 * presentation=true requires a preview; explicit editors override inference.
 * A multiple choice source is meaningful only for array fields and supplies item
 * choices rather than complete array values. Callbacks receive scope-specific data.
 */
export type SettingsFieldOptions<T, TValues> = {
    label?: string;
    description?: string;
    /**
     * Heading the field is listed under. A group's fields must be adjacent, and
     * ungrouped fields come before every group.
     */
    group?: string;
    /**
     * Hide the field while this returns false, e.g. options of a disabled feature.
     * Hidden fields keep their stored values. Runs on every refresh: keep it cheap and pure.
     */
    visible?(context: SettingsChoiceContext<TValues>): boolean;
    /**
     * Return why the field cannot be changed right now, or undefined when it can.
     * The reason is shown on the row and reported when editing or resetting is attempted.
     */
    disabled?(context: SettingsChoiceContext<TValues>): string | undefined;
    editor?: SettingsEditor;
    /**
     * Replace the built-in editors with a component; implies the custom editor.
     * Cannot be combined with choices, choiceSource, secret or a preview.
     */
    customEditor?: SettingsCustomEditor<T, TValues>;
    /**
     * Mask the value in lists and while typing, and start edits empty instead of
     * revealing it. Requires a string schema and the text editor; choices, previews
     * and formatValue are rejected because they would display the value.
     */
    secret?: boolean;
    choices?: readonly SettingsChoice<T>[];
    choiceSource?:
        | SettingsChoiceSource<T, TValues>
        | (T extends readonly (infer Item)[]
              ? SettingsChoiceSource<Item, TValues> & { multiple: true }
              : never);
    formatValue?(value: T, context: SettingsChoiceContext<TValues>): string;
} & (
    | { presentation: true; preview: SettingsPreview<T, TValues> }
    | { presentation?: false; preview?: SettingsPreview<T, TValues> }
);

/** TypeBox validation plus optional metadata used for editor/label inference. */
export type SettingsPanelSchema = TSchema & {
    type?: string;
    title?: string;
    description?: string;
    anyOf?: SettingsPanelSchema[];
    items?: TSchema;
    const?: unknown;
};

/**
 * Runtime field adapter borrowed by a renderer; it owns no backend lifecycle.
 * Custom implementations must keep inspect/set/reset consistent with one schema and
 * report committed observer errors distinctly from failed persistence.
 */
export interface SettingsPanelField {
    /** Unique within the section; stable across value/list refreshes. */
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly schema: SettingsPanelSchema;
    readonly editor?: SettingsEditor;
    /** See SettingsFieldOptions.group; renderers list adjacent fields under one heading. */
    readonly group?: string;
    /** Persistence scopes this field accepts; renderers block edits at any other scope. */
    readonly scopes: readonly SettingsScope[];
    /** Renderers must never display the value; see SettingsFieldOptions.secret. */
    readonly secret?: boolean;
    readonly choices?: readonly SettingsChoice[];
    readonly choiceSource?: SettingsChoiceSource;
    /** Rebuilds the same collector the source was created with, for the editor instance. */
    choiceContext?(context: ExtensionContext, scope: SettingsScope): SettingsChoiceContext;
    formatValue?(value: unknown, context: ExtensionContext, scope: SettingsScope): string;
    /** Renderers omit the field while this returns false; see SettingsFieldOptions.visible. */
    visible?(context: ExtensionContext, scope: SettingsScope): boolean;
    /** Reason edits and resets are refused at this scope; see SettingsFieldOptions.disabled. */
    disabled?(context: ExtensionContext, scope: SettingsScope): string | undefined;
    /** Present exactly when editor is "custom"; the adapter adds the scoped values snapshot. */
    customEditor?(
        context: Omit<SettingsCustomEditorContext<unknown, unknown>, "values">,
    ): SettingsEditorComponent;
    /** Current precedence explanation; renderers use explicit scope overrides for editing. */
    inspect(): SettingInspection<unknown>;
    /** Validate/commit a candidate at this explicit persistence scope, not a candidate range. */
    set(value: unknown, scope: SettingsScope): Promise<void>;
    /** Restore inheritance at one scope without releasing the borrowed Settings view. */
    reset(scope: SettingsScope): Promise<void>;
    preview?(value: unknown, theme: Theme, scope: SettingsScope): Component;
}

/**
 * UI-scoped membership unit with borrowed fields/configuration.
 * Removing a section ends discovery, not its underlying Settings acquisition.
 */
export interface SettingsSection {
    readonly id: string;
    readonly label: string;
    readonly fields: readonly SettingsPanelField[];
    /** Scopes the section's view can use; project is absent in untrusted folders. */
    readonly scopes: readonly SettingsScope[];
    /**
     * Set when the section's settings could not be loaded. Renderers show this text
     * instead of fields, and reload retries loading rather than rereading values.
     */
    readonly unavailable?: string;
    /** Observe committed field changes; the interaction owns the returned unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Reload this section only; UI errors must not imply a prior save was rolled back. */
    reload(): Promise<void>;
}

/** Only an absent override falls through; an explicit null, false, 0 or empty string wins. */
export function valueAtScope(
    inspection: SettingInspection<unknown>,
    scope: SettingsScope,
): unknown {
    return scope === "global"
        ? inspection.globalValue !== undefined
            ? inspection.globalValue
            : inspection.defaultValue
        : inspection.projectValue !== undefined
          ? inspection.projectValue
          : inspection.value;
}

/** Derived only for unambiguous schemas; anything else needs text or JSON input. */
function schemaChoices(schema: SettingsPanelSchema): SettingsChoice[] | undefined {
    if (schema.type === "boolean")
        return [
            { value: true, label: "on" },
            { value: false, label: "off" },
        ];
    const variants = schema.anyOf;
    if (variants?.every((variant) => Object.hasOwn(variant, "const"))) {
        return variants.map((variant) => ({ value: variant.const, label: String(variant.const) }));
    }
    if (Object.hasOwn(schema, "const"))
        return [{ value: schema.const, label: String(schema.const) }];
    return undefined;
}

/**
 * Prefer an explicit editor, then a custom component, dynamic select, static cycle,
 * string text, number, or JSON. Previews/presentation flags never override this choice;
 * declarations are validated separately so renderer dispatch does not hide conflicts.
 */
export function settingsEditor(
    field: Pick<SettingsPanelField, "editor" | "choiceSource" | "choices" | "schema"> & {
        customEditor?: unknown;
    },
): SettingsEditor {
    return (
        field.editor ??
        (field.customEditor
            ? "custom"
            : field.choiceSource
              ? "select"
              : field.choices?.length
                ? "cycle"
                : field.schema.type === "string"
                  ? "text"
                  : field.schema.type === "number" || field.schema.type === "integer"
                    ? "number"
                    : "json")
    );
}

/**
 * Infer only unambiguous boolean/literal choices and reject impossible editor metadata.
 * Static choices must satisfy the complete schema; dynamic/multiple choices are checked
 * at load time against field/item schemas. Run before acquiring UI in every host mode.
 * @internal
 */
export function resolveSettingsFieldOptions(
    id: string,
    schema: SettingsPanelSchema,
    metadata?: Pick<SettingsPanelField, "editor" | "choices" | "choiceSource" | "secret"> & {
        presentation?: boolean;
        preview?: unknown;
        formatValue?: unknown;
        group?: unknown;
        visible?: unknown;
        disabled?: unknown;
        customEditor?: unknown;
    },
) {
    if (metadata?.presentation && !metadata.preview) {
        throw new TypeError(`Presentation setting "${id}" requires a preview`);
    }
    if (
        metadata?.group !== undefined &&
        (typeof metadata.group !== "string" || !metadata.group.trim())
    )
        throw new TypeError(`Settings group for "${id}" must be a non-empty string`);
    for (const name of ["visible", "disabled", "customEditor"] as const)
        if (metadata?.[name] !== undefined && typeof metadata[name] !== "function")
            throw new TypeError(`Settings ${name} for "${id}" must be a function`);
    if (metadata?.customEditor) {
        if ((metadata.editor ?? "custom") !== "custom")
            throw new TypeError(
                `Custom editor for "${id}" conflicts with editor "${metadata.editor}"`,
            );
        if (metadata.choices || metadata.choiceSource || metadata.secret || metadata.preview)
            throw new TypeError(
                `Custom editor for "${id}" cannot use choices, secret or a preview; it renders its own UI`,
            );
    } else if (metadata?.editor === "custom")
        throw new TypeError(`Editor "custom" requires a customEditor for "${id}"`);
    if (metadata?.secret) {
        if (schema.type !== "string")
            throw new TypeError(`Secret setting "${id}" requires a string schema`);
        if ((metadata.editor ?? "text") !== "text")
            throw new TypeError(`Secret setting "${id}" requires the text editor`);
        if (metadata.choices || metadata.choiceSource || metadata.preview || metadata.formatValue)
            throw new TypeError(
                `Secret setting "${id}" cannot use choices, previews or formatValue because they display its value`,
            );
    }
    const choices = metadata?.choices ?? schemaChoices(schema);
    const editor = settingsEditor({
        editor: metadata?.editor,
        customEditor: metadata?.customEditor,
        choiceSource: metadata?.choiceSource,
        choices,
        schema,
    });
    if (editor === "text" && schema.type !== "string") {
        throw new TypeError(`Text editor requires a string schema for "${id}"`);
    }
    if (editor === "number" && schema.type !== "number" && schema.type !== "integer") {
        throw new TypeError(`Number editor requires a number or integer schema for "${id}"`);
    }
    if (
        (editor === "cycle" && (!choices?.length || metadata?.choiceSource)) ||
        (editor === "select" && !choices?.length && !metadata?.choiceSource)
    ) {
        throw new TypeError(
            `Editor "${editor}" requires ${editor === "cycle" ? "static" : "static or dynamic"} choices for "${id}"`,
        );
    }
    if (metadata?.choiceSource && editor !== "select") {
        throw new TypeError(`Dynamic choices require a select editor for "${id}"`);
    }
    // Reject choices the schema itself refuses before the panel can persist one.
    if (choices?.some(({ value }) => !Value.Check(schema, value))) {
        throw new TypeError(`Invalid choice for setting "${id}"`);
    }
    if (metadata?.choiceSource?.multiple && schema.type !== "array") {
        throw new TypeError(`Multiple choices require an array schema for "${id}"`);
    }
    return { choices, editor };
}

/**
 * Keep headings unambiguous: each group is one adjacent run and ungrouped fields
 * precede all groups, so no field can visually fall under the wrong heading.
 * @internal
 */
export function assertSettingsGroups(fields: readonly { group?: string }[]): void {
    const finished = new Set<string>();
    let current: string | undefined;
    for (const { group } of fields) {
        if (group === current) continue;
        if (group === undefined)
            throw new TypeError(
                `Ungrouped settings must come before group "${current}"; give the field a group or move it up`,
            );
        if (finished.has(group))
            throw new TypeError(`Settings group "${group}" must list its fields together`);
        if (current !== undefined) finished.add(current);
        current = group;
    }
}

/**
 * Adapt top-level Settings keys to a custom section; no acquisition/hooks are installed.
 *
 * fieldOrder restricts visible keys and their order, but callback/preview values still
 * include every schema key at the selected global/project scope. Preview overlays are
 * isolated candidates, not live writes. Duplicate/unknown keys and editor conflicts
 * throw before returning a section. Use createDefinedSettingsSection for tuple paths.
 *
 * The caller owns registry mounting and must detach before releasing manager.
 * This lower-level adapter does not freeze caller-supplied metadata.
 */
export function createSettingsSection<TSchema extends TObject>(
    manager: SettingsView<TSchema>,
    options: {
        id?: string;
        label: string;
        /** When supplied, only these keys are shown, in this order. */
        fieldOrder?: readonly SettingsKey<TSchema>[];
        fields?: {
            [K in SettingsKey<TSchema>]?: SettingsFieldOptions<Static<TSchema>[K], Static<TSchema>>;
        };
    },
): SettingsSection {
    const keys = Object.keys(manager.snapshot()) as SettingsKey<TSchema>[];
    const visibleKeys = options.fieldOrder ?? keys;
    if (
        new Set(visibleKeys).size !== visibleKeys.length ||
        visibleKeys.some((key) => !keys.includes(key))
    ) {
        throw new TypeError("Settings fieldOrder must contain unique schema keys");
    }
    assertSettingsGroups(visibleKeys.map((key) => ({ group: options.fields?.[key]?.group })));
    const fields = visibleKeys.map((key): SettingsPanelField => {
        const schema = manager.field(key).schema as SettingsPanelSchema;
        const metadata = options.fields?.[key];
        const { choices, editor } = resolveSettingsFieldOptions(key, schema, metadata);
        const valuesAtScope = (scope: SettingsScope) =>
            Object.fromEntries(
                keys.map((name) => [name, valueAtScope(manager.inspect(name), scope)]),
            ) as Static<TSchema>;
        const choiceContext = (context: ExtensionContext, scope: SettingsScope) => ({
            context,
            scope,
            values: valuesAtScope(scope),
        });
        return {
            id: key,
            label: metadata?.label ?? schema.title ?? key,
            description: metadata?.description ?? schema.description,
            schema,
            editor,
            group: metadata?.group,
            scopes: manager.field(key).scopes,
            secret: metadata?.secret,
            choices,
            visible: metadata?.visible
                ? (context, scope) => metadata.visible!(choiceContext(context, scope))
                : undefined,
            disabled: metadata?.disabled
                ? (context, scope) => metadata.disabled!(choiceContext(context, scope))
                : undefined,
            customEditor: metadata?.customEditor
                ? (host) =>
                      metadata.customEditor!({
                          ...(host as Omit<
                              SettingsCustomEditorContext<
                                  Static<TSchema>[typeof key],
                                  Static<TSchema>
                              >,
                              "values"
                          >),
                          values: valuesAtScope(host.scope),
                      })
                : undefined,
            formatValue: metadata?.formatValue
                ? (value, context, scope) =>
                      metadata.formatValue!(
                          value as Static<TSchema>[typeof key],
                          choiceContext(context, scope),
                      )
                : undefined,
            choiceSource: metadata?.choiceSource,
            choiceContext,
            inspect: () => manager.inspect(key),
            set: (value, scope) =>
                manager.set(key, value as Static<TSchema>[typeof key], { scope }),
            reset: (scope) => manager.reset(key, { scope }),
            preview: metadata?.preview
                ? (value, theme, scope) => {
                      const values = valuesAtScope(scope);
                      // The unsaved candidate must not be written back into the manager.
                      Object.defineProperty(values, key, {
                          value: Value.Clone(value),
                          enumerable: true,
                      });
                      return metadata.preview!({
                          value: value as Static<TSchema>[typeof key],
                          values: values as Static<TSchema>,
                          theme,
                          scope,
                      });
                  }
                : undefined,
        };
    });
    return {
        id: options.id ?? manager.id,
        label: options.label,
        fields,
        scopes: manager.scopes,
        subscribe: (listener) => manager.subscribe(listener),
        reload: () => manager.reload(),
    };
}
