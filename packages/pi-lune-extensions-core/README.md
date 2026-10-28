# Pi Lune Core

[![npm version](https://img.shields.io/npm/v/@lune_99/pi-lune-extensions-core.svg)](https://www.npmjs.com/package/@lune_99/pi-lune-extensions-core) [![npm downloads](https://img.shields.io/npm/dw/@lune_99/pi-lune-extensions-core.svg)](https://www.npmjs.com/package/@lune_99/pi-lune-extensions-core) [![license](https://img.shields.io/npm/l/@lune_99/pi-lune-extensions-core.svg)](LICENSE)

Shared building blocks for [Pi](https://github.com/earendil-works/pi) extensions:

- **Settings** — typed options stored as JSON files, with defaults, a global and a
  per-project level, and upgrades when your options change shape.
- **Settings Panel** — an optional terminal screen (`/lune-core-settings`) where users edit
  those options.
- **Dock** — a one-line status area that several extensions can share.
- **Resource cleanup** — `scopedExtension` and `ResourceScope` undo whatever your extension
  set up when Pi shuts the session down.

Your features stay in your own extension. Core does not replace Pi's factories, events,
commands, model registry or error handling. Core's own Pi entry adds one small feature:
[`@` session mentions](#mentions).

## Quick start

```ts
import { Type } from "typebox";
import {
    bindSettings,
    defineSettings,
    defineSettingsPanel,
    registerSettingsPanel,
    scopedExtension,
} from "@lune_99/pi-lune-extensions-core";

// 1. What can be configured. The id names the storage file.
const settings = defineSettings({
    id: "example",
    schema: Type.Object({ enabled: Type.Boolean({ default: true }) }),
});

// 2. How it looks in the settings screen (optional).
const panel = defineSettingsPanel(settings, {
    label: "Example",
    fields: [{ path: "enabled", label: "Enabled" }],
});

// 3. Wire both into Pi. Everything acquired here is cleaned up on session shutdown.
export default scopedExtension((pi, resources) => {
    const binding = resources.use(bindSettings(pi, settings));
    resources.use(registerSettingsPanel(panel, binding));

    resources.defer(
        pi.on("agent_start", async (_event, ctx) => {
            const view = await binding.view(ctx);
            if (view.get("enabled")) pi.appendEntry("example.started", {});
        }),
    );
});
```

What each piece does:

- `defineSettings` and `defineSettingsPanel` only describe things. They read no files and
  can live at module level.
- `bindSettings(pi, settings)` loads the values when a Pi session starts. The returned
  _binding_ hands you a _view_ with `await binding.view(ctx)`; call it inside your Pi event
  handlers. A view is the session's current values: `view.get(key)`, `view.set(key, value)`,
  `view.snapshot()` and `view.subscribe(listener)`.
- `registerSettingsPanel(panel, binding)` adds the section to the settings screen. It works
  with or without a panel; Settings runs the same in TUI, RPC and print modes, and the panel
  appears only in the TUI.
- `scopedExtension` is a normal Pi factory with one addition: whatever you pass to
  `resources.use(...)` or `resources.defer(...)` is cleaned up in reverse order on
  `session_shutdown`, or immediately if your setup throws. Business events and cancellation
  remain plain Pi.

More copy-pasteable examples (model picker, API keys, migrations, tests, Dock) are in the
[recipes](docs/recipes.md).

### Where settings are stored

Each settings `id` gets its own small JSON file per level, holding only the values a user
changed:

| Level   | File                                                                                      |
| ------- | ----------------------------------------------------------------------------------------- |
| Global  | `<agentDir>/lune-settings/<id>.json` — `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` |
| Project | `<project>/.pi/lune-settings/<id>.json`                                                   |

Project values override global values, which override the defaults in your schema.
A damaged file only affects its own `id`. Because settings may hold secrets such as API
keys, Core writes these files with owner-only permissions (`0600` on POSIX systems); the
values are not encrypted.

**Project trust.** Pi decides per folder whether a project is trusted. In an untrusted
project Core ignores the project file and rejects project writes; `view.scopes` lists the
levels you can actually use (`["global"]` or `["global", "project"]`). Mark a setting
`globalOnly` when a project must never override it — API keys and machine-wide choices
belong there. `$`-prefixed schema keys are reserved and ids must match
`/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/`.

**Changing the schema.** Add a function to `migrations` to rewrite stored data when you
rename or reshape a setting. Files are upgraded on load and written back; a file written by
a newer version is rejected with an error naming it. See
[the migration recipe](docs/recipes.md#rename-or-reshape-a-setting-with-a-migration).

**Reading at factory time.** Code that runs before `session_start` does not know yet whether
the project is trusted, so it can only use global values:
`await readGlobalSettings(settings)`.

## Lifecycle in short

```text
Pi session start → binding loads settings → views and panel sections become available
Pi session shutdown → panel section removed → settings released
```

`bindSettings` alone owns the Settings and Panel session hooks. On replacement or shutdown
it takes its view away first, so the panel section disappears before the underlying storage
is released. A panel registered after startup shows up immediately; one registered against
a binding that failed to load shows the error and offers Ctrl+S to retry. If loading is
still pending, `binding.view(ctx)` waits, and it rejects for contexts from another session.

Import `bindSettings` and `registerSettingsPanel` from the same Core copy: a binding belongs
to the copy that created it, even though compatible copies share storage, panel and Dock
services in one process. Registering a foreign binding throws `TypeError`; registering a
disposed binding throws `AbortError`. Do not keep contexts or views across a reload or
session replacement.

## The settings screen

Importing Core as a dependency provides building blocks; it does not register commands.
Load Core's Pi extension entry to add `/lune-core-settings [section-id]` and the reserved
`Core` placeholder section, or register your own command that calls
`openSettingsPanel(ctx, { section })` from `/panel/tui`.
The screen lists Core first, then sections by label (JavaScript string comparison, section
ID breaking ties). The renderer entry needs `@earendil-works/pi-tui`; declarations and
registration in `/panel` never import it.

Fields pick an editor from the schema: toggles for booleans, cycling for literal unions,
text for strings, a number editor for `number`/`integer`, JSON otherwise. Strings can be
masked with `secret: true`; `globalOnly` rows are marked "global only" in the project view;
untrusted projects show a banner and refuse project edits. Fields can be listed under
group headings, shown or disabled conditionally, and edited with your own pi-tui component
via `customEditor`. Secondary menus open a nested page of fields from one row, for entries
kept outside Settings; see the [recipes](docs/recipes.md) and [Panel guide](docs/panel.md).

Core registers no appearance changes. The Lune header, palettes and tool cards live in the
independent `@lune_99/pi-core-theme` extension, which adds its own `Theme` section.

To develop a consumer against a local checkout, use Node.js **22.19.0 or newer** and npm.
The Pi CLI must be available on `PATH`. Build Core before running a consumer against `dist`:

```sh
cd /path/to/pi-lune-extensions-core
npm ci
npm run build
cd /path/to/your-extension
npm install /path/to/pi-lune-extensions-core typebox
pi --extension /path/to/pi-lune-extensions-core/extension.ts --extension ./src/extension.ts
```

A Pi package can list its own entry in `pi.extensions`. Core's manifest lists
`extension.ts`; the root SDK is not a Pi factory. Pi loads the source entry so `/reload`
replaces handlers; SDK consumers continue using `dist`. Loading the command entry does not
initialize business features or perform model requests.

## Model choices

```ts
import { defineSettingsPanel, modelChoices } from "@lune_99/pi-lune-extensions-core/panel";

const panel = defineSettingsPanel(modelSettings, {
    label: "Model settings",
    fields: [
        {
            path: "model",
            choiceSource: modelChoices({
                specialChoices: [{ value: null, label: "Follow session model" }],
            }),
        },
    ],
});
```

The field schema must accept every choice, including special values. Pi supplies
models, availability, credentials and routing. The helper only builds Panel choices:
searchable provider-qualified identities, scoped/all ranges, refresh, and cancellation.
Business code resolves references directly with `ctx.modelRegistry.find(provider, id)`.
Thinking policy and special-value meanings belong to the consumer. A full example is in
the [recipes](docs/recipes.md#let-users-pick-a-model).

## Dock contributions

The Dock protocol is part of Core. Import
`createDockContribution` and the types from `@lune_99/pi-lune-extensions-core/dock`, and
`getDockRegistry` / `createDockRegistry` for hosts from `@lune_99/pi-lune-extensions-core/dock/host`.

```ts
import { createDockContribution, type DockDefinition } from "@lune_99/pi-lune-extensions-core/dock";
```

A contribution provides a complete one-line `base`, optional `detail` and optional `full`
snapshot. Attach it with the current session context, call `refresh()` after your state
changes, and `detach({ retired: true })` on shutdown. The shared Dock is discovered when you
attach. Without a Dock host, or when the loaded Dock is incompatible, your standalone
renderer stays active; in the incompatible case `attach` also warns through
`ctx.ui.notify` instead of throwing. Core never invents business status or starts a Dock UI.
See [Dock](docs/dock.md).

## Mentions

Core's Pi entry adds local Pi, Codex and Claude Code sessions to the same `@` completion list.

The list after `@` starts with up to three local sessions from every project, newest first.
Each row shows its source (`[pi]`, `[codex]` or `[claude]`), age, project and title.
Type after `@` to filter by source, title, project or id. Files whose name contains what you typed come before
the sessions, so Tab still picks the file you typed. File matches are Pi's own.

Type `@@` to list only sessions from all three tools together. It searches by source, title, project, id and
the text of its messages, and shows up to 50 matches.

```text
继续这个 @@recap
→ [pi]      3d  lune-pi          调查recap现在生成的条件是什么
  [claude]  6d  lune-recap       如果我把recap的焦点检测去掉会怎么样？
```

Picking a row inserts `@session:<id>` for Pi, `@codex:<id>` for Codex or `@claude:<id>` for
Claude Code. The prefixes identify references; both completion lists combine all three sources.
Codex reads `<CODEX_HOME>/sessions/` (default `~/.codex/sessions/`) and Claude Code reads
`<CLAUDE_CONFIG_DIR>/projects/` (default `~/.claude/projects/`). Codex archived sessions and
both tools' subagent sessions are excluded. Codex titles come from its optional
`session_index.jsonl`; Claude Code uses its custom or generated session title.

When you send the prompt, Core saves an exact JSONL copy in the system temporary directory.
Pi rebuilds its active branch with `SessionManager.inMemory()` and `buildSessionProjection()`,
including compaction and context edits. Codex applies compaction replacement history and turn
rollbacks; Claude Code follows the active parent chain and reconnects messages preserved by
compaction. The filtered copy keeps your prompts, assistant text and readable compaction
summaries. Thinking, images, tool calls and output, system context and encrypted compaction
payloads are left out. The result is written to
`<os.tmpdir()>/pi-lune-session-refs/<source>.<session id>.<snapshot hash>.md` (at most 40 KB), and the token
becomes an `@` reference to that file, so the agent reads it only when it needs it.
The Markdown links to the complete `<source>.<session id>.<snapshot hash>.jsonl` copy in the same
directory for details it leaves out; it does not expose the original session file path.
Copies remain available across Pi restarts until the operating system reclaims them; cleanup
timing depends on its temporary-file policy. Mentioning a session again recreates a missing
Markdown or JSONL copy. Changed session contents or titles produce a new pair of copies, preserving
earlier references. Existing copies under `<agentDir>/tmp/session-refs/` can be removed manually when their
old references are no longer needed.

Core leaves both the original session file and the complete JSONL copy unchanged, including
when Pi upgrades an older session format in memory. If an id matches no session or more than one, the
prompt is not sent and your text returns to the editor.

Core loads all three sources into its existing `SessionCatalog` when a session starts, using
Pi's `SessionManager.listAll()` for Pi sessions. Lookups use that list and reload it in the background when it is older
than one minute, so a new session can take up to a minute to appear. Typing never waits for
the list. External files whose inode, size and modification time have not changed reuse their
parsed metadata and searchable text; searching also reuses the existing lower-case text cache.
Unchanged reference snapshots reuse `TranscriptCache`. A typed reference that is not in the
list makes Core reload it before sending the prompt. Invalid or unsupported Codex and Claude
Code files are silently excluded, and failed parses are cached until their files change.
An invalid Codex title index leaves titles derived from the session messages. If an external
session becomes invalid after selection, its reference stays as typed while the rest of the
prompt is sent normally. Parser failures will be recorded in Core Log once it is available.

Mentions are part of Core's Pi entry only; importing the SDK does not activate them.

## API and guides

The root exports `defineSettings`, `bindSettings`, `readGlobalSettings`,
`defineSettingsPanel`, `registerSettingsPanel`, `ResourceScope`, `scopedExtension` and
`createDockContribution`, plus their central types. Importing the root or `/panel` does not
load terminal renderers or the Pi SDK. TypeBox is the required runtime peer; Pi packages are
optional peers needed by the capabilities you use (supported ranges: pi-ai `^1.0.4`,
pi-coding-agent `^1.0.4`, pi-tui `^1.0.0`, typebox `^1.3.27`). The default file backend loads
Pi's path API when settings are first acquired.

| Entry        | Purpose                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| `/settings`  | Definitions, bindings, `readGlobalSettings`, typed views, paths and notification errors |
| `/panel`     | Panel definitions, registrations, choice/preview types and `modelChoices`               |
| `/panel/tui` | `openSettingsPanel` and its terminal renderer                                           |
| `/dock`      | `createDockContribution`, Dock snapshot types and `LUNE_DOCK_PROTOCOL_VERSION`          |
| `/resources` | `ResourceScope`, `scopedExtension` and the disposable contract                          |
| `/testing`   | `createSettingsSandbox` for tests; never import it from production code                 |

Guides:

- [Recipes](docs/recipes.md) — short, copy-pasteable examples
- [Settings and persistence](docs/settings.md)
- [Panels, choices and previews](docs/panel.md)
- [Dock contributions and hosts](docs/dock.md)
- [Custom backend and explicit acquisition](docs/custom-backend.md)
- [Host compatibility, ownership and migration](docs/public-api-design.md)
- [Changelog](CHANGELOG.md)

Advanced entries: `/settings/advanced` (manual acquisition), `/settings/backend`
(custom storage), `/panel/host` and `/dock/host` (custom hosts). Internal files are not public import paths.

## Development

### Prepare the checkout

Run commands from the repository root with Node.js **22.19.0 or newer** and npm:

```sh
npm ci
npm run build
```

`npm ci` installs the locked development environment, including the Pi SDK/TUI peers.
A consumer's runtime requirements remain capability-specific: TypeBox is required, while
Pi peers are optional only when the imported APIs do not need them. The Pi CLI is also
required on `PATH` for `npm run dev` and the interactive demo.

### Find the right module

| Path                                        | Responsibility                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/settings/`                             | Definitions, session binding, leased views, per-namespace file storage and migrations    |
| `src/panel/`                                | Panel declarations, binding projection, choices and terminal rendering                   |
| `src/dock/`                                 | Dock contributions, UI-scoped registry and protocol checks                               |
| `src/resources/`                            | Instance-local reverse-order cleanup and `scopedExtension`, independent of other domains |
| `src/testing/`                              | `createSettingsSandbox`, the public test helper exported as `/testing`                   |
| `src/core/host.ts`                          | The single process-local discovery boundary for shared services                          |
| `src/core/settings.ts`, `src/core/panel.ts` | Core's own configuration and placeholder panel declarations                              |
| `extension.ts`, `src/extension.ts`          | Native Pi entry, the shared settings command and Core's Settings/Panel ownership         |
| `test/harness/`                             | Isolated Settings fixtures and temporary storage                                         |
| `.github/workflows/ci.yml`                  | CI: `npm ci`, typecheck, tests and a package dry run                                     |
| `test/tui/`                                 | The offline interactive demo and its mock provider                                       |

Keep business workflows in their own extensions. Use intentional package exports rather
than private source imports; do not turn binding readiness into a general session framework.
Before changing ownership or shared protocols, review the
[architecture and compatibility guide](docs/public-api-design.md).

### Format and validate

After changing TypeScript or TSX, run the required formatter, then the checks:

```sh
bash .scripts/format-ts.sh
npm run typecheck
npm test
```

The formatter currently uses `/opt/homebrew/bin/node` and
`$HOME/.config/editor-format/format.mjs`. These are local tooling prerequisites, not npm
package dependencies. If either is missing, report the formatter check as blocked; do not
silently skip it or alter the script to make validation pass.

`npm test` performs a fresh build through `pretest`. `npm run typecheck` checks both source
and tests; `npm run build` produces JavaScript and declarations in `dist`. The build clears
`dist` first, so finish it before running consumers or checks that read built files. Do not
run those dependent checks concurrently with a rebuild.

For a focused Settings/Panel or package-boundary change:

```sh
npm run build
node --experimental-strip-types --test \
  test/settings/binding.test.ts \
  test/native-lifecycle.test.ts \
  test/core-host.test.ts \
  test/package-boundaries.test.ts
```

Run the full suite afterward. These checks cover native Pi reload/new/fork/resume, late
acquisition and disposal races, copy-local binding handles, compatible Host sharing,
optional runtime peers, and tracked documentation links. Keep fixtures isolated from
personal settings; a focused pass is not a substitute for the full suite.

### Inspect the terminal UI

```sh
npm run tui:demo -- --help
npm run tui:demo
```

The demo starts Pi offline with a mock provider and temporary agent/project/session files.
It loads only the explicit Core/demo extensions, does not change personal settings, and
removes its temporary workspace on exit. Run `/lune-core-settings`; check section tabs,
global/project edits, save/reset/cancel behavior, previews and narrow-terminal resizing.
See [Panel keyboard controls](docs/panel.md#opening-and-keyboard-controls). Quit with
`/quit` or Ctrl+C. This is a manual interaction check, not an automated smoke-test gate.

`npm run dev` instead loads `extension.ts` in your normal Pi environment. Core alone
registers the settings command and its empty, first-position `Core` section; load consumers
for editable settings, or use the isolated demo. Do not treat the normal development
session as a sandbox.

### Inspect package contents

```sh
npm run build
npm pack --dry-run --ignore-scripts
```

Inspect the package file list without publishing. Public artifacts are `dist`, topic
guides, README, changelog and license; declarations and explicit subpath entries must stay
in sync. Importing the root or `/panel` must not load terminal rendering or the Pi SDK;
`/panel/tui` is the deliberate renderer boundary. Do not expose private implementation
files, add a second Host discovery key, or treat npm version equality as protocol compatibility.
