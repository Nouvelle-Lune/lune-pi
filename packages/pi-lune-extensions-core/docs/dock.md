# Dock

The Dock protocol is part of Core. Contributors import `createDockContribution` and the
types from `@lune_99/pi-lune-extensions-core/dock`; hosts import `getDockRegistry` and
`createDockRegistry` from `@lune_99/pi-lune-extensions-core/dock/host`.
A plugin supplies complete one-line `base`, optional `detail` and optional `full`
components through a `LuneDockSnapshot`. Higher levels are complete presentations,
not append-only fragments. Core knows no business-state meanings.

```ts
import { createDockContribution, type DockDefinition } from "@lune_99/pi-lune-extensions-core/dock";

const definition: DockDefinition = {
    id: "example",
    getSnapshot: () => ({
        base: { render: () => ["Example: idle"], invalidate() {} },
    }),
    activate() {},
    standalone: {
        setCtx(ctx) { renderer.setContext(ctx); },
        render() { renderer.render(); },
        clear() { renderer.clear(); },
    },
};
const contribution = createDockContribution(definition);
```

The example's `renderer` is consumer-owned. Attach with a current native context
on session startup, refresh after state changes, and call `detach({ retired: true })`
on shutdown. Retired cleanup stops standalone timers without writing to the old UI.
Non-TUI attachment never contributes to a terminal Dock.

Construction attaches nothing and cannot fail on protocol grounds. The shared Dock registry
is discovered lazily on `attach`. If it is incompatible (a different Dock protocol version
is already loaded), `attach` keeps the standalone view and warns through `ctx.ui.notify`
rather than throwing, so the feature stays usable.

No host: standalone rendering remains active. Host attachment clears standalone UI
and takes the current snapshot. Host removal restores standalone rendering.
Contributions, host attachment, subscriptions and stale release tokens have separate
ownership. Duplicate contributor IDs or host attachment in the same UI scope fail.

Advanced hosts import `getDockRegistry` from `/dock/host`, call
`attachHost(ctx.ui, { invalidate })`, read `getContributions(ctx.ui)`, and retain
the detach handle. Registry scopes are isolated by the stable UI object.
Dock discovery uses the one Core Host; it does not have a second global discovery symbol.

`LUNE_DOCK_PROTOCOL_VERSION` (exported from `/dock`) governs the shared Dock service and
presentation contract independently of the internal Core Host protocol and npm version.
The shared registry stores its own
`protocolVersion`. `getDockRegistry()` checks that version before any consumer can register
or attach through it and throws on a mismatch; `createDockContribution` turns that failure
into the standalone fallback described above, while a host should surface it. The original
Host and Dock state are never replaced or adapted, and compatible Settings/Panel services
remain available when only the Dock protocol differs.
A Core import does not itself create a Dock UI, background renderer, model request
or business snapshot.
