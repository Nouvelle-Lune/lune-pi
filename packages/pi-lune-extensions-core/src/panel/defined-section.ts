/**
 * Bridge immutable Panel metadata to required paths in one borrowed Settings view.
 *
 * Path validation/atomic nested edits remain Settings responsibilities; this adapter
 * supplies labels, editors and scoped callback snapshots. Previews replace a candidate
 * only in a cloned snapshot, never in storage. Mounting and retirement observation
 * belong to registration.ts, not to the returned section.
 */
import { Value } from "typebox/value";
import type { Static, TObject } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsPanelDefinition } from "./definition.ts";
import type { SettingsView, SettingsScope, SettingsPath } from "../settings/types.ts";
import {
    assertSettingsGroups,
    resolveSettingsFieldOptions,
    type SettingsCustomEditorContext,
    type SettingsSection,
    type SettingsPanelField,
    type SettingsPanelSchema,
    type SettingsFieldOptions,
} from "./section.ts";

/**
 * Adapt a declared Panel to one live view without acquiring or releasing it.
 *
 * Hidden fields remain in formatter/choice/preview snapshots. Nested tuple IDs use
 * JSON encoding so arbitrary property names do not collide with string paths.
 * Release a host registration before releasing the view; using a section afterward
 * fails through the retired Settings capability.
 */
export function createDefinedSettingsSection<T extends TObject>(
    settings: SettingsView<T>,
    definition: SettingsPanelDefinition<T>,
): SettingsSection {
    const declarations =
        definition.fields ?? Object.keys(settings.snapshot()).map((path) => ({ path }));
    assertSettingsGroups(declarations as readonly { group?: string }[]);
    const fields = declarations.map((declaration) => {
        const metadata = declaration as { path: SettingsPath<T> } & SettingsFieldOptions<
            unknown,
            Static<T>
        >;
        const binding = settings.field(metadata.path);
        const schema = binding.schema as SettingsPanelSchema;
        const id =
            typeof metadata.path === "string" ? metadata.path : JSON.stringify(metadata.path);
        const { choices, editor } = resolveSettingsFieldOptions(id, schema, metadata);
        const context = (context: ExtensionContext, scope: SettingsScope) => ({
            context,
            scope,
            values: Value.Clone(settings.snapshot({ scope })) as Static<T>,
        });
        return {
            id,
            schema,
            label: metadata.label ?? schema.title ?? binding.path.at(-1)!,
            description: metadata.description ?? schema.description,
            editor,
            group: metadata.group,
            scopes: binding.scopes,
            secret: metadata.secret,
            choices,
            visible: metadata.visible
                ? (ctx, scope) => metadata.visible!(context(ctx, scope))
                : undefined,
            disabled: metadata.disabled
                ? (ctx, scope) => metadata.disabled!(context(ctx, scope))
                : undefined,
            customEditor: metadata.customEditor
                ? (host) =>
                      metadata.customEditor!({
                          ...(host as Omit<
                              SettingsCustomEditorContext<unknown, Static<T>>,
                              "values"
                          >),
                          values: context(host.context, host.scope).values,
                      })
                : undefined,
            choiceSource: metadata.choiceSource,
            choiceContext: context,
            inspect: () => binding.inspect(),
            set: (value, scope) => binding.set(value as never, { scope }),
            reset: (scope) => binding.reset({ scope }),
            formatValue: metadata.formatValue
                ? (value, ctx, scope) => metadata.formatValue!(value, context(ctx, scope))
                : undefined,
            preview: metadata.preview
                ? (value, theme, scope) => {
                      const values = Value.Clone(settings.snapshot({ scope })) as Static<T>;
                      let parent = values as Record<string, unknown>;
                      for (const key of binding.path.slice(0, -1))
                          parent = parent[key] as Record<string, unknown>;
                      Object.defineProperty(parent, binding.path.at(-1)!, {
                          value: Value.Clone(value),
                          enumerable: true,
                          configurable: true,
                          writable: true,
                      });
                      return metadata.preview!({ value, values, theme, scope });
                  }
                : undefined,
        } satisfies SettingsPanelField;
    });
    return {
        id: definition.id ?? settings.id,
        label: definition.label,
        fields,
        scopes: settings.scopes,
        subscribe: (listener) => settings.subscribe(listener),
        reload: () => settings.reload(),
    };
}
