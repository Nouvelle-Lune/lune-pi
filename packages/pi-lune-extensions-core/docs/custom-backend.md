# Advanced Settings acquisition and storage

Ordinary Pi consumers should use `bindSettings`. These interfaces are for explicit
non-Pi lifetime ownership or custom storage, not a second extension lifecycle.

## Explicit acquisition

```ts
import { acquireSettings } from "@lune_99/pi-lune-extensions-core/settings/advanced";

// projectTrusted mirrors Pi's ctx.isProjectTrusted(); it is required, never guessed.
const lease = await acquireSettings(definition, { cwd, projectTrusted });
try {
    const values = lease.settings.snapshot();
    await consume(values);
} finally {
    await lease.release();
}
```

Only the lease owner calls release. The view has no backend/schema mutation or shared
release authority. Releasing one view aborts its lifetime and subscriptions, waits for
writes already in flight, and releases only its token. Those writes' errors are reported to
the callers that started them, not re-thrown from `release`. The last file-backend token closes
the shared entry; acquisition waits for an entry already closing.

## Custom backend

Import `SettingsBackend` and `SettingsBackendFactory` from `/settings/backend`.
A factory accepts `{ cwd, projectTrusted }` and returns, synchronously or asynchronously,
`{ backend, release }`. Settings owns that returned release right exactly once.
If you share custom storage across results, the factory owns its reference-count policy.

The structural backend supplies:

- `id` and validated `settingSchema`, matching its definition;
- `inspect`, `set`, `reset`, `reload`, and `subscribe`;
- optional atomic `update` for nested-field editing.

When `projectTrusted` is false the backend must neither read nor write project state.
The view enforces the same rule (and the definition's `globalOnly` keys) on top of the
backend, so a custom backend cannot leak project values into an untrusted session.
`migrations` cannot be combined with a custom backend: the backend owns upgrading its
own stored data.

It owns validation, committed values, global/project resolution and notifications.
A mismatch or failed view construction releases the acquired result; acquisition
and cleanup failures are aggregated. No `instanceof` backend identity is required.
Nested edits reject a backend without atomic update rather than doing read-then-set.

## Custom Panel host

`/panel/host` exports `createDefinedSettingsSection(view, panelDefinition)`,
`createSettingsSection(view, options)`, `registerSettingsSection(ui, section)`
and registry contracts. A custom `SettingsSection` must supply `scopes` (the scopes its view
can use) and every `SettingsPanelField` must supply `scopes` (where that field can be
written); renderers block edits at any other scope. A section may set `unavailable` to a
message when its settings failed to load. Retain registration handles and unregister before releasing
the borrowed lease. Adapters and interactions never release Settings.
For normal Pi plugins, use `registerSettingsPanel` instead.
