# Settings Panel

Declarations, registrations, choices and preview types live in
`@lune_99/pi-lune-extensions-core/panel`. Opening the terminal renderer uses
`@lune_99/pi-lune-extensions-core/panel/tui`; importing the declaration entry never loads it.

## Declaration and ownership

`defineSettingsPanel(settingsDefinition, { id?, label, fields? })` returns an immutable
`SettingsPanelDefinition` with a one-way reference to Settings.
ID defaults to the Settings ID; label and ID must be nonempty. Omitted fields expand
all top-level properties; an explicit empty array displays no fields.
Array order is display order. A typed `fields: field => [field(path, options)]` builder
preserves nested-path value inference.

Fields own labels, descriptions, editor choices, static/dynamic choices, formatting
and previews. Editors are inferred from the schema: `cycle` for booleans and literal
choices, `select` for dynamic sources, `text` for strings, `number` for `number`/`integer`
schemas (one finite number), and `json` otherwise; `editor` overrides the inference.
`secret: true` (string fields with the text editor only) masks the value in the list and
while typing, starts editing empty so the stored value is never revealed, and keeps the
value when Enter is pressed on an empty input. Secret fields reject choices, previews and
`formatValue`, because those would display the value. Declarations validate paths, overlap, editor/schema conflicts,
static values and presentation-without-preview errors before mounting.
Schemas, paths, static choice values and candidate-scope lists are snapshotted.
Dynamic callbacks retain identity, not their result data.

`registerSettingsPanel(panel, binding)` verifies matching ID, schema structure and
backend factory. It observes the binding's current ready view, mounts immediately if
registered after startup, and mounts only in TUI. It installs no Pi lifecycle hooks or
view-signal watchers. RPC/print never construct sections/editors/previews or candidate work.
Registration does not acquire another backend token and does not open the UI.
The binding must be live and created by the same Core copy: a retired binding throws
AbortError, and a foreign-copy binding throws TypeError instead of creating an inert handle.

### Trust, global-only and failed sections

- Each section and field carries `scopes`, the persistence scopes it accepts. In an
  untrusted project the project scope is absent: switching to it shows a banner and the
  panel refuses project edits and resets. Custom hosts must supply `scopes` on every `SettingsSection` and
  `SettingsPanelField` (required fields, no default).
- While the project scope is selected, fields for `globalOnly` settings are marked
  "global only" and refuse edits; they can only be changed at the global scope.
- If a binding fails to load (for example a corrupt settings file or a migration error), its
  section stays visible and shows the error with its causes. Fix the file and press Ctrl+S
  to retry loading; the section does not disappear.

Closing an interaction releases its subscriptions/editor/preview, not its registration
or Settings. Disposing a registration unregisters its own section, never Settings.
Duplicate section ownership fails without replacing the first owner. The binding
unpublishes its current view before releasing it, so the section unmounts before Settings
retirement. A replacement ready view mounts a new section; failed or late acquisition
never mounts. Binding disposal unmounts and clears observers. Cleanup failures remain
observable through registration disposal.

## Groups, conditional fields and custom editors

Three field options shape the screen without changing storage.

**`group`** lists fields under a heading; navigation skips headings. A group's fields must
be adjacent and ungrouped fields must come before every group, otherwise
`defineSettingsPanel` throws `TypeError`.

**`visible({ values, scope, context })`** hides a field while it returns false; the stored
value is kept. **`disabled({ values, scope, context })`** returns why the field cannot be
changed right now (or `undefined`); the reason is shown on the row and reported when
editing or resetting is attempted. `values` are the values at the scope being viewed. Both
run on every refresh, so keep them cheap. If `visible` throws, the field stays listed and
the error is shown; if `disabled` throws, editing is blocked and the error is shown.

```ts
fields: [
    { path: "enabled", label: "Enabled" },
    {
        path: "retries",
        label: "Retries",
        group: "Advanced",
        visible: ({ values }) => values.enabled,
    },
    {
        path: "level",
        label: "Level",
        group: "Advanced",
        disabled: ({ values }) => (values.model ? undefined : "Select a model first"),
    },
];
```

**`customEditor(context)`** returns a pi-tui `Component` (`render`, `handleInput`,
`invalidate`; optional `help`, `focused`, `dispose`) that the panel renders in place of its
built-in editors. The context is
`{ value, values, scope, context, theme, submit(value), cancel(), requestRender() }`.
`submit` validates against the schema and saves at the scope fixed when the editor opened:
it closes on success and stays open with an error otherwise. Escape always belongs to the
panel and closes without saving; every other key goes to the component. `help` is shown as
the key hints, followed by "Esc cancel", and `focused` is set when the panel's focus changes. A custom editor cannot be
combined with `choices`, `choiceSource`, `secret` or `preview`.

```ts
{
    path: "tags",
    label: "Tags",
    customEditor: ({ value, submit }) => new TagEditor(value, submit),
}
```

The types `SettingsCustomEditor`, `SettingsCustomEditorContext` and
`SettingsEditorComponent` are exported from `@lune_99/pi-lune-extensions-core/panel`. Custom sections
built for `/panel/host` (the `SettingsPanelField` type from `/panel`) gain the optional `group`,
`visible(ctx, scope)`, `disabled(ctx, scope)` and `customEditor(hostContext)`, where the
host context omits `values`. See the [recipes](recipes.md) for complete examples.

## Opening and keyboard controls

Import `openSettingsPanel` from `/panel/tui`, not `/panel`.
`await openSettingsPanel(ctx, { section? })` is TUI-only. Core's extension entry exposes
the same flow as `/lune-core-settings [section-id]` and registers its own `Core` section
with the reserved ID `core`. Core's Settings and Panel declarations live in `src/core/`;
the empty schema currently provides a placeholder without adding configurable values.
Empty sections display a message until settings are available.

The renderer pins `core` first, then sorts other sections by label using JavaScript
string comparison (`<` / `>`), with case preserved and no locale-dependent collation.
Equal labels are ordered by section ID using the same comparison. Membership changes
reapply this order while preserving the selected section if it remains registered.
The registry itself still returns registration order.

- Main list: Tab/Shift+Tab switch sections; Ctrl+G switches global/project;
  Ctrl+R resets the selected override; Ctrl+S reloads the active section (or retries one that failed to load).
- Editor: Enter saves; Ctrl+S saves and then reloads; Escape discards the candidate.
- Choice list: type to search; Tab switches candidate ranges; Ctrl+R explicitly refreshes
  supported sources; Space toggles multiple selections.
- Preview choices render unsaved candidates; persistence occurs only on confirmation.

The write scope and field identity are captured when an editor opens. Changing model
ranges does not redirect a pending write. Dynamic candidates are schema-checked on
arrival, and the entire field is validated before saving. Committed notification errors
close the editor without pretending the saved value rolled back.

## Choice sources

`load({ context, values, scope, candidateScope?, signal })` receives a required editor-owned
signal and a deeply frozen snapshot for the captured write scope.
It can return choices synchronously or asynchronously.
Starting new discovery/refresh, changing a candidate range, closing, section removal
or view retirement aborts the prior task. Late choices cannot update old UI.

`refresh({ context, values, scope, signal })` is optional and asynchronous.
`multiple`, `rowLayout`, `emptyMessage`, `scopes` and `defaultScope` customize the editor.
Multiple selections preserve stored values absent from the current candidate list.

## Model helper

`modelChoices({ type?, scopes?, specialChoices?, emptyMessage? })` emits provider/id
`ModelReference` values and searchable labels from Pi, without a Core model catalogue.

Chat defaults to scoped/all ranges. Scoped candidates are the available-model intersection
with Pi's scoped order, deduplicated by provider/id. Explicit empty scoped results stay
empty; they do not expand to all. Classifier/image use only all and await
`getAvailableOfType(type, undefined, { signal })`.

Special choices precede models. Their callback receives actual filtered Pi models,
not wrapped catalogue entries. Their semantics, the field schema and thinking policy
belong to the consumer. The helper never changes the session model/thinking level.

Refresh delegates `{ signal, allowNetwork: true, force: true }` to Pi.
Aborted results cancel; provider errors form an AggregateError with provider names.
Load does not refresh, and there is no Core cache, background discovery or provider manager.

Custom UI hosts can use section adapters and registration from `/panel/host`.
Those advanced functions still borrow views; they never own acquisition or release.
