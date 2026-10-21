# Changelog

All notable changes are documented here using
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

> **⚠️ Breaking:** Replace managed extension wrappers with native Pi factories,
> `bindSettings` and `registerSettingsPanel`. Split Panel metadata out of
> `defineSettings`; import model controls from `/panel`, explicit leases from
> `/settings/advanced`, custom section adapters from `/panel/host`, and
> `openSettingsPanel` from `/panel/tui`.
> Runtime, Models and `/tui/settings` entries are removed without compatibility aliases.
> Load business extensions separately.
> Update related dependencies together and restart Pi to replace the old shared registries.
>
> **⚠️ Breaking: API changes.** `acquireSettings` and custom backend factories require
> `projectTrusted`. `SettingsSection` and `SettingsPanelField` implementations for
> custom hosts must declare `scopes`. The Core Host protocol is now 2, so every Core copy
> loaded in one Pi process must be updated together.

### Added

- **Grouped, conditional and custom-edited Panel fields.** `group` lists fields under a
  heading, `visible` hides a field (keeping its stored value), and `disabled` returns the
  reason a field cannot be changed right now. `customEditor` renders your own pi-tui
  component in the panel and saves through `submit`, validated at the scope fixed when it
  opened. Custom section hosts gain the matching optional `SettingsPanelField` members;
  see the [Panel guide](docs/panel.md) and [recipes](docs/recipes.md).
- **Independent Settings and Panel definitions.** Immutable declarations separate
  persistence from presentation. Typed nested paths, dynamic/multiple choices and
  previews remain available without forcing Settings consumers to load a Panel.
- **Settings lifetime binding.** `bindSettings` owns configuration readiness and
  native session retirement; business callbacks still use Pi directly. Views expose
  lifetime signals, and late acquisition is cleaned rather than published.
- **Local resource ownership.** `ResourceScope` provides reverse-order, idempotent
  cleanup and aggregates failures without depending on Settings, UI or Pi.
- **Core settings placeholder.** Core's Pi entry registers an empty `Core` section
  declared in `src/core/`, giving its own configuration a reserved first tab and a
  namespace bound through the same Settings and Panel APIs as any consumer. Empty
  sections report that no settings are available instead of rendering an empty list.
- **Per-namespace settings files.** Each settings id owns its own JSON file per scope
  (`<agentDir>/lune-settings/<id>.json` and `<project>/.pi/lune-settings/<id>.json`), so
  a damaged file only affects its own namespace. Files hold the overrides plus an
  optional `"$version"` marker and are written owner-only (`0600`) because settings may
  hold secrets such as API keys.
- **Schema evolution.** `defineSettings({ migrations })` upgrades stored files in order on
  load and writes them back; the version is `migrations.length + 1`. A file from a newer
  version is rejected with an error naming it. Ids must match
  `/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/`, `$`-prefixed schema keys are reserved, and
  migrations cannot be combined with a custom backend.
- **Project trust and global-only settings.** `bindSettings` captures
  `ctx.isProjectTrusted()`; untrusted projects' settings files are ignored and project
  writes are rejected. `view.scopes` and `field.scopes` list the writable scopes, and
  `globalOnly` keys (API keys, machine-wide choices) are never stored per project.
- **`readGlobalSettings`.** One-shot read of global values for code that runs before
  `session_start`, when trust is not yet known.
- **`scopedExtension`.** Wraps a native Pi factory with a `ResourceScope` that is disposed
  on `session_shutdown`, or immediately if setup fails.
- **Panel editors.** A number editor is inferred for `number`/`integer` schemas, and
  `secret: true` masks string fields (editing starts empty; an empty Enter keeps the
  value). Untrusted projects show a banner and refuse project edits, and global-only rows
  are marked "global only".
- **`@lune_99/pi-lune-core/testing`.** `createSettingsSandbox()` gives tests a temporary
  agent directory and project folder with `writeStored`, `readStored`, `settingsFile`,
  `acquire` and `dispose`.
- **Recipes and CI.** `docs/recipes.md` collects copy-pasteable examples, and a GitHub
  Actions workflow runs typecheck, tests and a package dry run.
- **Arrow keys switch settings tabs.** In the main list, Right and Left move to the next
  and previous section, like Tab and Shift+Tab. Text inputs, choice lists and custom
  editors still receive the arrows while they are open.
- **`@` session mentions.** The `@` list in the editor starts with up to three local
  sessions from every project (`[session]` rows with age, project and title); files whose
  name contains the query stay above them, and file matches are Pi's own. `@@` lists only
  sessions, searching every local session by title, project, id and message text. When you
  send, each `@session:<id>` becomes an `@` reference to a filtered copy under
  `<os.tmpdir()>/pi-lune-session-refs/`, so the agent reads it only when it needs it. The copy
  comes from Pi's `SessionManager.inMemory()` and `buildSessionProjection()` (active branch,
  compaction summary, context edits) and keeps only user prompts, assistant text and the
  compaction summary. The list comes from `SessionManager.listAll()`, reloads in the
  background at most once a minute, and typing never waits for it. An unknown or ambiguous id
  stops the prompt and puts your text back in the editor.

### Changed

- **Session mention copies use the system temporary directory.** Store filtered transcripts
  under `<os.tmpdir()>/pi-lune-session-refs/` so the operating system can reclaim them according
  to its temporary-file policy. Existing copies under `<agentDir>/tmp/session-refs/` can be
  removed manually once their old references are no longer needed.
- **Deterministic settings tabs.** The renderer pins Core first and orders the other
  sections by label using JavaScript string comparison, with section ID breaking ties,
  so tab order no longer follows registration timing. Registration and removal reapply
  that order without replacing the active section or its pending edit.
- **BREAKING: Panel observes Settings readiness.** Call
  `registerSettingsPanel(panel, binding)` without `pi`; no old overload remains.
  SettingsBinding alone owns session lifecycle hooks and unmounts dependent Panels
  before releasing a view. Registration after startup immediately projects the ready view.
- **One compatible Core Host.** Settings namespaces, file queues, Panel and Dock
  discovery share one lazy process-local Host. Compatible package versions reuse
  it; incompatible protocol versions or shapes fail without creating separate state.
- **Model controls belong to Panel.** `modelChoices` consumes Pi registries directly,
  preserves provider/id identities and supports scoped/all ranges, explicit refresh
  and cancellation. Special callbacks receive filtered Pi models; business lookup
  and thinking policy use Pi's native APIs.
- **Deliberate public entries.** The root contains the frequent APIs (`defineSettings`,
  `bindSettings`, `readGlobalSettings`, the Panel pair, `ResourceScope`, `scopedExtension`,
  `createDockContribution`); subsystem
  contracts and advanced lease/storage/host interfaces have separate paths.
  README and topic guides describe native composition instead of a second framework.
- **Configuration semantics preserved.** Global/project precedence, whole-object
  inheritance, atomic nested edits, snapshots, subscriptions and reload keep their
  existing behavior.
- **Dock protocol in Core.** Import `createDockContribution` and the Dock types from
  `@lune_99/pi-lune-core/dock`, and `getDockRegistry` / `createDockRegistry` from
  `/dock/host`. `LUNE_DOCK_PROTOCOL_VERSION` identifies the Dock contract, and the
  shared registry is discovered lazily on `attach`.
- **BREAKING: required project trust and scopes.** `acquireSettings(definition, { cwd,
  projectTrusted })` and custom backend factories (`{ cwd, projectTrusted }`) now take the
  trust decision explicitly. Custom hosts must set `scopes` on `SettingsSection` and
  `SettingsPanelField`; sections may also set `unavailable` to show a load error.
- **Release no longer rethrows write errors.** Releasing a view waits only for writes in
  flight; their errors go to the caller that started them.
- **Compatibility ranges.** Core Host protocol is 2; peer ranges are pi-ai `^1.0.4`,
  pi-coding-agent `^1.0.4`, pi-tui `^1.0.0` and typebox `^1.3.27`.
- **Source-level developer guidance.** Public entries, API contracts and core implementations
  now explain ownership, lifecycle ordering, persistence/compatibility boundaries and
  asynchronous UI constraints in English JSDoc and focused comments. The annotations
  are included in generated declarations; runtime behavior and exports are unchanged.
- **Repository development workflow.** The English README and topic guides explain
  environment setup, module boundaries, validation, isolated TUI checks and package
  inspection. The public README no longer links to the Chinese reference, which now
  lives in the ignored local `.docs/` directory.

### Removed

- **Managed extension framework.** `defineExtension`, `installExtension`,
  managed-event mirrors and session-framework types are removed.
- **Independent model catalogue.** Core no longer exports catalogue wrappers or
  keeps a Models subsystem; model discovery remains Pi-owned.
- **Built-in Recap feature.** Source, configuration declarations, business tests,
  design documentation and PTY fixtures move to independent `lune-recap`.
  Core's Pi entry owns no Recap configuration or runtime.
- **Obsolete refactor task log.** Remove historical progress records that no longer
  describe the implemented lifecycle. Current contracts and development guidance remain
  in the README and topic guides.
- **Shared settings file and its rewrite helper.** `lune-extensions-settings.json` and
  `/settings/migration` (`transformSettingsOverride`) are gone. Core has never been
  released, so no import of the old file is provided.

### Fixed

- **Session mentions expose copies only.** The Markdown reference now points to a complete
  JSONL copy beside it in the system temporary directory, so editing that file cannot modify
  the original session. Projection runs in memory, preserving both files even when Pi upgrades
  an older session format; missing copies are recreated on the next mention.
- **Native source entry.** Pi now loads a TypeScript source entry and implementation,
  so `/reload` replaces Core's handlers; SDK consumers keep compiled exports.
- **Optional runtime peer boundaries.** Root and `/panel` imports no longer load
  terminal renderers or the Pi SDK; the default file backend loads Pi at acquisition.
  `openSettingsPanel` moves to `/panel/tui`, and type-only Pi AI is an optional peer.
- **Independent Dock compatibility.** The shared Dock registry advertises and checks
  its own protocol version before reuse. A missing or mismatched Dock version fails
  without replacing shared state or blocking compatible Settings/Panel services.
- **Reproducible documentation.** Public topic guides are tracked in Git instead of
  depending on ignored local files, so README links and packaged docs survive clean checkout.
- **Owned lifetime cleanup.** Panel removal never releases borrowed Settings,
  stale acquisition/choice results cannot update retired consumers, and shutdown
  preserves cleanup failures while attempting every owned disposer.
- **Committed-write diagnostics and choice validation.** Notification failures
  retain committed-state semantics, and dynamic values are validated before saving.
- **Stable panel layout and search.** Main/editor framing, reserved descriptions,
  responsive previews and provider-qualified model identities remain consistent.
- **Panel registration rejects retired bindings.** Registering against a disposed
  SettingsBinding now throws AbortError instead of returning an inert handle. Binding
  handles are explicitly copy-local; import binding and Panel registration from the
  same Core copy, while compatible Host-backed services remain shared.
- **Failed bindings stay visible.** If a binding cannot load (for example a corrupt file),
  its Panel section shows the error and Ctrl+S retries, instead of the section vanishing.
- **Incompatible Dock no longer breaks contributors.** `attach` keeps the standalone view
  and warns through `ctx.ui.notify` instead of throwing when the shared Dock is incompatible.
