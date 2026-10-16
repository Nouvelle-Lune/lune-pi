# Recipes

Short, copy-pasteable examples. Every snippet uses only exported APIs; see the
[README](../README.md) for the overview and the topic guides for the full contracts.

All extension snippets assume this shape: declarations at module level, wiring inside
`scopedExtension`, which cleans up everything passed to `resources.use` / `resources.defer`
when Pi shuts the session down.

## Add a boolean toggle

```ts
import { Type } from "typebox";
import {
    bindSettings,
    defineSettings,
    defineSettingsPanel,
    registerSettingsPanel,
    scopedExtension,
} from "@lune_99/pi-lune-extensions-core";

const settings = defineSettings({
    id: "my-extension",
    schema: Type.Object({
        verbose: Type.Boolean({ default: false, description: "Log extra detail." }),
    }),
});

const panel = defineSettingsPanel(settings, {
    label: "My extension",
    fields: [{ path: "verbose", label: "Verbose" }],
});

export default scopedExtension((pi, resources) => {
    const binding = resources.use(bindSettings(pi, settings));
    resources.use(registerSettingsPanel(panel, binding));

    resources.defer(
        pi.on("tool_call", async (_event, ctx) => {
            const view = await binding.view(ctx);
            if (view.get("verbose")) ctx.ui.notify("tool call started", "info");
        }),
    );
});
```

Every top-level schema property must be required and carry a `default`. Booleans get an
on/off editor automatically. Load Core's extension entry (or call `openSettingsPanel`)
to give users the screen.

## Let users pick a model

Store a `{ provider, id }` reference, optionally with special values such as `null`:

```ts
import { Type } from "typebox";
import { defineSettings } from "@lune_99/pi-lune-extensions-core";
import { defineSettingsPanel, modelChoices } from "@lune_99/pi-lune-extensions-core/panel";

const settings = defineSettings({
    id: "my-extension.model",
    schema: Type.Object({
        model: Type.Union(
            [Type.Null(), Type.Object({ provider: Type.String(), id: Type.String() })],
            { default: null },
        ),
    }),
});

const panel = defineSettingsPanel(settings, {
    label: "Model",
    fields: [
        {
            path: "model",
            label: "Model",
            choiceSource: modelChoices({
                specialChoices: [{ value: null, label: "Follow session model" }],
            }),
        },
    ],
});
```

The schema must accept every choice, special values included. Resolve the stored
reference with Pi when you use it:

```ts
const reference = view.get("model");
const model = reference
    ? ctx.modelRegistry.find(reference.provider, reference.id)
    : ctx.model; // "Follow session model"
```

## React to changes

`view.subscribe` runs after a value changes (from the panel, `view.set`, `view.reset`, or a reload that picked up edited files)
and returns an unsubscribe function. A view ends with its session, which drops the
subscription for you:

```ts
resources.defer(
    pi.on("session_start", async (_event, ctx) => {
        const view = await binding.view(ctx);
        const apply = () => applyVerbose(view.get("verbose"));
        apply();
        view.subscribe(apply);
    }),
);
```

Do not read the view outside the session that produced it. Fetch a fresh one with
`await binding.view(ctx)` in each Pi handler, or keep it only for the session's duration.

## Rename or reshape a setting with a migration

Stored files are plain JSON, so renaming a key without a migration would make old files
fail validation. Add a function to `migrations`; do not edit the schema alone:

```ts
const settings = defineSettings({
    id: "my-extension",
    schema: Type.Object({
        // v1 stored `timeout` in seconds; v2 stores `timeoutMs`.
        timeoutMs: Type.Integer({ default: 30_000 }),
    }),
    migrations: [
        (overrides) => {
            const { timeout, ...rest } = overrides;
            return typeof timeout === "number" ? { ...rest, timeoutMs: timeout * 1000 } : rest;
        },
    ],
});
```

Rules of thumb:

- The current version is `migrations.length + 1`. Stored data at version *n* passes through
  `migrations[n - 1]`, so append new migrations and never reorder or delete shipped ones.
- A migration receives an isolated copy of one file's overrides (no defaults, no
  `$version`) and returns the overrides for the next version. Keep it synchronous and pure.
- Files are upgraded when loaded and written back. The result must satisfy the current
  schema, so drop keys the schema no longer has.
- A file written by a newer version is rejected with an error naming the file.
- Migrations cannot be combined with a custom backend.

## Store an API key

Use `globalOnly` so a cloned repository can never supply or override the key, and `secret`
so the panel never shows it:

```ts
const settings = defineSettings({
    id: "my-extension.service",
    schema: Type.Object({
        apiKey: Type.String({ default: "" }),
        region: Type.String({ default: "eu" }),
    }),
    globalOnly: ["apiKey"],
});

const panel = defineSettingsPanel(settings, {
    label: "Service",
    fields: [
        { path: "apiKey", label: "API key", secret: true },
        { path: "region", label: "Region" },
    ],
});
```

In the panel a secret is masked in the list, editing starts empty, and pressing Enter on an
empty field keeps the stored value. `globalOnly` rows are marked "global only", and a
project write is rejected. `secret` works only on string fields with the text editor (no
choices, previews or `formatValue`). Core writes settings files with owner-only (`0600`)
permissions, but the value is stored as plain text, not encrypted.

## Read settings at factory time

Code that runs while the factory executes, before `session_start`, does not yet know
whether the project is trusted, so it may only use global values:

```ts
import { readGlobalSettings, scopedExtension } from "@lune_99/pi-lune-extensions-core";

export default scopedExtension(async (pi, resources) => {
    const { startupHeader } = await readGlobalSettings(settings);
    if (startupHeader) installHeader(pi, resources);
    // ...bindSettings and the rest as usual
});
```

The result is a frozen snapshot (global, then defaults), read once. Use
`bindSettings` and `await binding.view(ctx)` for anything that should follow project
overrides or later changes.

## Test with a sandbox

`createSettingsSandbox` points Pi's agent directory at a temporary folder and gives you a
project folder, so tests run against the real file storage without touching personal
settings. Import it from `@lune_99/pi-lune-extensions-core/testing` in tests only. One sandbox may be
active per process; Node's test runner already isolates test files.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { defineSettings } from "@lune_99/pi-lune-extensions-core";
import { createSettingsSandbox } from "@lune_99/pi-lune-extensions-core/testing";

const settings = defineSettings({
    id: "my-extension",
    schema: Type.Object({ level: Type.Integer({ default: 1 }) }),
});

test("reads stored values and persists writes", async (t) => {
    const sandbox = await createSettingsSandbox();
    t.after(() => sandbox.dispose());

    await sandbox.writeStored(settings, "global", { level: 3 });
    const lease = await sandbox.acquire(settings); // trusted project by default
    assert.equal(lease.settings.get("level"), 3);

    await lease.settings.set("level", 5);
    assert.deepEqual(await sandbox.readStored(settings, "global"), { level: 5 });
});
```

`sandbox.writeStored` accepts a raw string too, which is how you stage broken files.
`sandbox.acquire(definition, { projectTrusted: false })` simulates an untrusted folder, and
`sandbox.cwd`, `sandbox.agentDir` and `sandbox.settingsFile(definition, scope)` expose the
paths. `dispose()` releases the leases it handed out, restores `PI_CODING_AGENT_DIR` and
deletes the folders.

## Group fields and show them conditionally

`group` lists fields under a heading, `visible` hides a field (its stored value is kept) and
`disabled` returns the reason a field cannot be changed right now. Ungrouped fields come
first and each group's fields must be adjacent, otherwise `defineSettingsPanel` throws:

```ts
import { Type } from "typebox";
import {
    bindSettings,
    defineSettings,
    defineSettingsPanel,
    registerSettingsPanel,
    scopedExtension,
} from "@lune_99/pi-lune-extensions-core";

const settings = defineSettings({
    id: "my-extension.advanced",
    schema: Type.Object({
        advanced: Type.Boolean({ default: false }),
        retries: Type.Integer({ default: 3, minimum: 0 }),
        timeoutMs: Type.Integer({ default: 30000, minimum: 1 }),
        model: Type.String({ default: "" }),
        thinking: Type.Union([Type.Literal("low"), Type.Literal("high")], { default: "low" }),
    }),
});

const panel = defineSettingsPanel(settings, {
    label: "Advanced",
    fields: [
        { path: "advanced", label: "Advanced options" },
        { path: "model", label: "Model" },
        {
            path: "thinking",
            label: "Thinking level",
            disabled: ({ values }) => (values.model ? undefined : "Select a model first"),
        },
        {
            path: "retries",
            label: "Retries",
            group: "Advanced",
            visible: ({ values }) => values.advanced,
        },
        {
            path: "timeoutMs",
            label: "Timeout (ms)",
            group: "Advanced",
            visible: ({ values }) => values.advanced,
        },
    ],
});

export default scopedExtension((pi, resources) => {
    const binding = resources.use(bindSettings(pi, settings));
    resources.use(registerSettingsPanel(panel, binding));
});
```

`values` are the values at the scope being viewed, so the project view evaluates against the
project's effective settings. A disabled field shows its reason on the row and in the panel
when you try to edit or reset it. Keep both callbacks cheap and pure: they run on every
refresh.

## Write a custom editor

`customEditor` hands editing to your own pi-tui component. This one edits a
`Type.Array(Type.String())` field as a comma-separated line. Enter submits, and Escape
(always handled by the panel) closes without saving:

```ts
import { Input } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    bindSettings,
    defineSettings,
    defineSettingsPanel,
    registerSettingsPanel,
    scopedExtension,
} from "@lune_99/pi-lune-extensions-core";
import type { SettingsEditorComponent } from "@lune_99/pi-lune-extensions-core/panel";

const settings = defineSettings({
    id: "my-extension.tags",
    schema: Type.Object({
        tags: Type.Array(Type.String(), { default: [] }),
    }),
});

class ListEditor implements SettingsEditorComponent {
    readonly help = "Enter save · comma-separated";
    private readonly input = new Input();

    constructor(
        value: readonly string[],
        submit: (value: string[]) => void,
    ) {
        this.input.setValue(value.join(", "));
        this.input.onSubmit = (text) =>
            submit(
                text
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
            );
    }

    set focused(value: boolean) {
        this.input.focused = value;
    }

    get focused(): boolean {
        return this.input.focused;
    }

    handleInput(data: string): void {
        this.input.handleInput(data);
    }

    render(width: number): string[] {
        return this.input.render(width);
    }

    invalidate(): void {
        this.input.invalidate();
    }
}

const panel = defineSettingsPanel(settings, {
    label: "Tags",
    fields: [
        {
            path: "tags",
            label: "Tags",
            customEditor: ({ value, submit }) => new ListEditor(value, submit),
        },
    ],
});

export default scopedExtension((pi, resources) => {
    const binding = resources.use(bindSettings(pi, settings));
    resources.use(registerSettingsPanel(panel, binding));
});
```

`submit` validates the value against the schema and saves at the scope fixed when the editor
opened; it closes the editor on success and leaves it open with an error otherwise. The
context also provides `values`, `scope`, `context`, `theme`, `cancel()` and
`requestRender()` (for async work), and a component may implement `dispose()`. A custom
editor cannot be combined with `choices`, `choiceSource`, `secret` or `preview`.

## Contribute to the Dock

The Dock protocol is part of Core. Contribute a one-line status; Core uses your standalone
renderer when no shared Dock is present.

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { scopedExtension } from "@lune_99/pi-lune-extensions-core";
import { createDockContribution } from "@lune_99/pi-lune-extensions-core/dock";

export default scopedExtension((pi, resources) => {
    let jobs = 0;
    let ui: ExtensionContext["ui"] | undefined;

    const line = (): Component => ({
        render: (width) => [truncateToWidth(`Example: ${jobs} jobs`, width)],
        invalidate() {},
    });

    const dock = createDockContribution({
        id: "example",
        getSnapshot: () => ({ base: line() }),
        activate: (ctx) => ctx.ui.notify(`${jobs} jobs running`, "info"),
        standalone: {
            setCtx: (ctx) => void (ui = ctx?.ui),
            render: () => ui?.setStatus("example", `${jobs} jobs`),
            clear: () => ui?.setStatus("example", undefined),
        },
    });

    resources.defer(() => dock.detach({ retired: true }));
    resources.defer(
        pi.on("session_start", (_event, ctx) => {
            dock.attach(ctx);
        }),
    );
    resources.defer(
        pi.on("agent_start", () => {
            jobs += 1;
            dock.refresh(); // publish a new snapshot after state changes
        }),
    );
});
```

`base` must render exactly one line within the given width; `detail` and `full` are
optional complete alternatives, not appended fragments. If the loaded Dock is incompatible,
`attach` keeps your standalone view and shows a warning through `ctx.ui.notify` instead of
throwing. See [Dock](dock.md) for hosts.
