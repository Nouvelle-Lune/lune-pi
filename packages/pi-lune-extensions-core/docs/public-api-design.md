# Public API, native lifecycle and Core Host

This document describes the implemented breaking architecture, not the removed managed
extension framework.

## Boundaries and entries

Core contains four reusable domains: Settings, optional Panel, Dock and ResourceScope,
plus a `/testing` helper for consumers' tests.
Settings has no UI metadata or direct Panel/TUI dependency. Panel borrows Settings views.
Resources knows neither Pi nor any subsystem. Business state and model requests belong
to independent plugins.

Root APIs are the high-frequency constructors/adapters: `defineSettings`, `bindSettings`,
`readGlobalSettings`, `defineSettingsPanel`, `registerSettingsPanel`, `ResourceScope`,
`scopedExtension` and `createDockContribution`. Subsystem entries expose their
stable consumer contracts. Explicit leases, backend/migration and custom host interfaces
live only in advanced entries. There are no runtime/Models entries, event mirrors,
deprecated aliases or private-file export wildcards.

The root exports Panel constructors directly, not through a renderer barrel.
`/panel` has no runtime Pi peer imports; `/panel/tui` explicitly owns terminal rendering.
The default file backend imports Pi's path API only when acquired. TypeBox is the required
runtime peer; Pi AI, SDK and TUI remain optional peers for relevant runtime capabilities
and public declaration resolution.

Plugins use native Pi factories, `pi.on` and `pi.registerCommand`.
Core never intercepts arbitrary events, defines before-event fallbacks or substitutes
a general `onError` policy. Pi owns event dispatch. Only SettingsBinding subscribes to
Pi's Settings/Panel session lifecycle; Panel projects its current ready view through an
internal observer, without another lifecycle owner or public subscription API.

## Initialization and ownership

| Resource                                               | Owner                           | Retirement                               |
| ------------------------------------------------------ | ------------------------------- | ---------------------------------------- |
| Static Settings/Panel definitions                      | Declaring plugin                | No runtime resources                     |
| Binding listeners and pending acquisition              | SettingsBinding                 | Shutdown/explicit dispose                |
| View, subscriptions and backend token                  | Binding or explicit lease owner | Session retirement                       |
| Shared namespaces and file queues                      | Core Host                       | Last reference/queue settlement          |
| Panel section and binding subscription                 | SettingsPanelRegistration       | Dispose/binding retirement               |
| Editor, choices, preview and interaction subscriptions | Open Panel interaction          | Close/section removal/view retirement    |
| Business timers, requests and local objects            | Plugin                          | Its native lifecycle and business policy |

`scopedExtension((pi, resources) => ...)` is the preferred wrapper: it creates the
ResourceScope, registers its `session_shutdown` disposer first, runs setup, and disposes
everything acquired so far if setup throws (aggregating a cleanup failure with the setup
error). Without it, a plugin registers its own shutdown disposer first, then acquires
a local ResourceScope's Settings binding, Panel registration and business objects in that
order. Reverse cleanup closes business → Panel → Settings. The binding unpublishes its
view before release, so Panels also unmount first when it is disposed directly.
Settings shutdown remains idempotent; lifetime signals synchronously fence stale access.

Pending initialization is owned immediately. Late backend results are released instead of
published. Callers observe startup errors through Pi and access errors through `view(ctx)`.
Cleanup tries all owned resources, aggregates failures and shares its disposal result.
A view signal is a configuration lifetime boundary, not an agent-turn or operation signal.

Pi reload/session replacement creates new factory instances. Old contexts are unusable.
Repeated startup within one instance can replace its view safely. Before-navigation hooks,
tree branch changes and model changes do not define Settings lifetime; plugins still cancel
their own work when those changes invalidate business results.

## One process-local Host

Discovery is lazy at `Symbol.for("@lune_99/pi-lune-extensions-core/host")` on `globalThis`.
Only the internal Host module owns this process-global discovery key:

```text
Core Host protocol 2
├── settings.namespaces
├── settings.fileQueues
├── panel registry
└── dock registry
```

ResourceScope stays instance-local. Registry factories do not perform discovery; the Host
composes them without circular imports. Subsystems retrieve services from this boundary,
not from independent registry globals. Namespace keys include the resolved global file
(`<agentDir>/lune-settings/<id>.json`); project entries are keyed by resolved project file
(`<project>/.pi/lune-settings/<id>.json`), and untrusted projects share one global-only entry.
Each ID owns its own file, so damage stays inside one namespace. Namespace declarations
must agree on schema, version and `globalOnly` list or acquisition fails. UI registries use
weakly scoped UI objects. Sharing discovery does not merge different projects or runners.

An independent plugin resolving its own `node_modules` Core copy calls the same public
APIs. Host-backed services discover the same Host in that JS process. No central extension
loader, Core bootstrap wrapper, npm deduplication or package-class identity is necessary
for those shared services.

SettingsBinding handles are local to the Core copy that created them; only Host-backed
services are cross-copy interoperable. Import `bindSettings` and `registerSettingsPanel`
from the same Core copy. Registering a foreign binding fails with TypeError even when
both copies implement compatible Host protocols.
Loading Core's Pi entry adds its shared settings command and Core's own placeholder
section; SDK services do not require it. Core's configuration and Panel declarations
remain in `src/core/`, composed through the same binding/registration APIs as consumers.
Separate processes/workers are separate hosts; files still remain persistence, not IPC.

## Compatibility boundary

The npm package version records releases, not runtime compatibility.
Different minor versions can coexist when they implement Host protocol 2.
Host discovery checks protocol version and the structural service/map operations before
reuse. Absent/wrong versions and invalid service shapes fail explicitly without replacing
the original Host or constructing another registry world.

Changes to shared namespace ownership/schema conflict rules, file-queue semantics,
registration/release contracts or required structural operations require assessing Host
protocol compatibility. Removing required operations or changing their meaning incompatibly
requires a new protocol version. Ordinary internal refactors and compatible API additions
do not. Dock has an additional independent boundary: the shared Dock registry advertises
`LUNE_DOCK_PROTOCOL_VERSION`, and `/dock/host` checks it before returning the service.
The Dock protocol lives in Core.
A missing or mismatched Dock version rejects Dock use without replacing its registry
or preventing compatible Settings/Panel access. Changes to Dock snapshots or service
semantics require bumping the Dock protocol; changes to the outer Host discovery or
structural service contract require a separate Host protocol assessment.

Tests copy built Core into two physical dependency installations with distinct minor
versions, import through each plugin's package exports and verify shared Settings values,
notifications, release rights, Panel and Dock discovery. Incompatibility tests preserve
existing state and ensure no second discovery symbol is created. A physical Core copy
with a different Dock protocol is rejected while its Settings/Panel still reuse the Host.

## Migration

- Replace managed extension wrappers with native factories/events and domain-specific
  `bindSettings` / `registerSettingsPanel(panel, binding)`; Panel no longer takes `pi`.
  Wrap the factory in `scopedExtension` for owned resources.
- Split the old definition's panel into `defineSettingsPanel(definition, options)`.
- Import `modelChoices` and choice types from `/panel`; special callbacks receive Pi
  models directly. Resolve business references with Pi's model registry.
- Move explicit acquisition/types to `/settings/advanced` and storage to
  `/settings/backend`. `acquireSettings` and custom backend factories now receive
  `projectTrusted` (required), mirroring `ctx.isProjectTrusted()`. Custom section adapters
  and registrations are in `/panel/host`; custom `SettingsSection` and
  `SettingsPanelField` implementations must now declare `scopes`.
- Settings are stored in one file per namespace
  (`<agentDir>/lune-settings/<id>.json` and `<project>/.pi/lune-settings/<id>.json`);
  use `defineSettings({ migrations })` when a schema changes between versions.
- Replace old runtime/Models/TUI import paths in every consumer; no shim remains.
- Load independently extracted business packages explicitly. Core registers its shared
  settings command and its own placeholder section, not business features.
- Update related dependencies together and restart/reload Pi; an incompatible already
  loaded Host is rejected, never silently adapted.
