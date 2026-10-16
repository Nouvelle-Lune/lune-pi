# Settings

Import ordinary contracts from `@lune_99/pi-lune-extensions-core/settings`.

## Definitions and bindings

`defineSettings({ id, schema, migrations?, globalOnly?, backend? })` validates required
top-level properties and schema-valid defaults, clones/freezes the schema, and performs no
I/O or UI registration. Settings definitions never include panel metadata.

- **`id`** names the namespace and its file. It must match
  `/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/`; dots do not imply nested objects. A package or
  panel rename does not change the ID, but changing the ID selects new storage.
- **`schema`** is a TypeBox object whose top-level properties are all required and have
  defaults. Property names starting with `$` are reserved for stored metadata.
- **`migrations`** is an ordered list of `SettingsMigration` functions (see
  [Schema evolution](#schema-evolution)). Cannot be combined with a custom `backend`.
- **`globalOnly`** lists top-level keys that are never read from or written to project
  files, such as API keys or machine-wide choices. Unknown or duplicate keys throw.
- **`backend`** replaces the default JSON files; see [custom-backend.md](custom-backend.md).

`readGlobalSettings(definition)` (also exported from the root) reads global-then-default
values once, for code that runs before `session_start` (factory time) when project trust is
not yet known. It ignores project files and installs no hooks.

`bindSettings(pi, definition)` belongs to one native Pi factory invocation.
Its handle is local to the Core copy that created it; Panel registration must use that
same copy. Host-backed storage sharing does not make binding handles cross-copy compatible.
It listens only for its configuration's `session_start` and `session_shutdown`.
Call `await binding.view(ctx)` in business callbacks to obtain a `SettingsView`.
It validates cwd, session-manager identity and session ID, not callback-context identity.
Initialization failures are not retried silently.

The binding is the sole Settings/Panel owner of Pi session lifecycle hooks. Its internal
readiness observer is not a public API. It unpublishes the current view before release,
so dependent Panels unmount while borrowed Settings are still usable.

Repeated startup retires the old view before acquiring a replacement. Shutdown or
`dispose()` aborts the binding, synchronously invalidates acquired views and subscriptions,
waits for pending acquisition and accepted writes, then releases its backend token.
Late acquisition is cleaned rather than returned. Repeated disposal shares one Promise.
Before-switch/fork/tree/compact events do not retire Settings: Pi may cancel navigation.

## Persistence and values

Each settings ID owns one JSON file per scope:

- Global: `<agentDir>/lune-settings/<id>.json`, where `agentDir` is Pi's agent directory
  (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`).
- Project: `<ctx.cwd>/.pi/lune-settings/<id>.json`.

A file holds that scope's overrides plus an optional `"$version"` marker (present only
above version 1). Effective precedence is project -> global -> default. Missing files mean
no overrides; empty overrides remove the file. Invalid JSON, unknown stored properties and
invalid values fail explicitly and leave the file untouched, and a damaged file only
affects its own namespace. Writes use a same-directory temporary file and atomic rename,
and files are created owner-only (`0600`) because settings may hold secrets such as API
keys.

### Schema evolution

The current version is `migrations.length + 1`. Stored data at version *n* is passed through
`migrations[n - 1]`, then onward, when the file is loaded; the upgraded file is written back
with its new `$version`. A migration receives an isolated copy of one scope's overrides
(no defaults, no `$` metadata) and returns the next version's overrides; keep it
synchronous and pure, append new entries only, and never reorder shipped ones. Results are
validated against the current schema. Missing or empty files hold nothing to upgrade, so
migrations never run for them. A file from a newer version is rejected with an error
naming the file, so a downgrade cannot reinterpret newer data. Failed migrations name the
file and step and leave it untouched. Custom backends own their own upgrades.

### Project trust

`bindSettings` captures `ctx.isProjectTrusted()` for each session. In an untrusted project
the project file is neither read nor written, `view.scopes` is `["global"]`, and project
writes reject. `field.scopes` lists where a particular field can be written: `globalOnly`
keys are always `["global"]`, and a project file that contains one is rejected. Explicit
acquisition (`acquireSettings`) requires the caller to pass `projectTrusted`.

`get(key)`, `inspect(key)`, and `snapshot()` read current in-memory values.
`inspect` reports default/global/project/effective values and the source.
`snapshot({ scope: "global" })` resolves global/default; project or omitted scope resolves
project/global/default. Snapshots are independent, deeply frozen values.

`set(key, value, { scope })` and `reset(key, { scope })` default to global.
Reset removes that scope's override. UI candidate ranges never change the write scope.
`reload()` revalidates external edits before publishing; a failed reload preserves
the last committed view. Subscribers belong to their view, not to a shared backend.

Nested `field(["appearance", "color"])` operations use an atomic backend transaction.
Inheritance remains whole-object at the top-level setting, not leaf-by-leaf.
Resetting a child copies its inherited value into the current parent; if the resulting
parent equals inheritance, its override is removed. Required object paths are supported;
optional branches, array indexes and dynamic record keys are not.

## Lifetimes and errors

A view has `readonly signal: AbortSignal` but no `dispose` or `release`.
After retirement, reads, field operations, subscriptions and new writes reject.
Release waits only for writes already in flight; their errors go to the caller that started
them, not to release. One binding's release cannot close
another consumer's view or subscriptions.

Persistence failure means no successful commit. `SettingsNotificationError` has
`committed === true`: the write succeeded, but one or more observers failed.
Use `isSettingsNotificationError(error)` across package copies, and do not retry that
write as if it had rolled back.

No Panel, Dock, business workflow or resource container is required to use Settings.
Advanced backend and non-Pi acquisition examples are in [custom-backend.md](custom-backend.md).
