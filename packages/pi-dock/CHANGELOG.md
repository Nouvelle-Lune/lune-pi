# Changelog

## [Unreleased]

### Added

- **Persistent Dock settings.** `/dock` controls on/off, base/detail/full density, plugin visibility
  and numeric order. Changes apply immediately, restore independent plugin status bars when off,
  and persist across Pi restarts.

- **Unified one-line Lune dock.** Shell Inspector and Ask Question share one below-editor
  row with plugin-owned presentations, keyboard selection and direct panel opening.
  Closing a panel restores dock focus, and disabling the host restores each independent dock.
- **Shared scoped Dock protocol.** Contributors share a registry across installed Core copies,
  with explicit registration and host ownership lifetimes for session changes and reloads.
- **Plugin-owned single-line presentations.** Base/detail/full Components provide increasing
  horizontal information density. Plugins own content, markers and theme styling.
- **Focus marks and key hints.** Focus marks the selected item with `❯` and draws
  `←→ select · enter open · esc back` on the rule under the cells, shortened as the terminal
  narrows, while Home and End jump to the first and last module. Selecting an item never moves
  its neighbors.
- **A steady scrolling window.** A row too wide for its terminal keeps its window and moves it
  only when the selection would leave it, counting the items outside each edge (`‹2` before,
  `3›` after). The window lives on the controller, so it survives Pi recreating the widget component.
- **Model, directory and usage rows.** The dock shows `(provider) model • thinking` beside the
  cells and the working directory, git branch and token, cache, cost and context statistics
  beneath them, all read through Pi's extension API. Each statistic has a fixed-width slot, so
  changing numbers never shift their neighbours, and a slot or counter with no data yet is not
  drawn. Narrow terminals drop whole slots by terminal width alone, then shorten the directory
  from the left.
- **Selectable dock styles.** `ruled`, `boxed`, `compact`, `minimal` and `classic` frame the same
  rows differently, and switches hide the model, directory or usage. The panel previews the
  candidate style, focused, before it is saved.
- **Settings through Pi Lune Core.** Dock settings are a typed Core namespace (`lune-dock`) with
  global and project scopes, and `/dock` opens its section of Core's settings panel.
- **Visual README.** Introduce the extension with feature highlights, npm installation steps and previews rendered from its real TUI components. Regenerate the SVG and PNG assets with `npm run docs:images`; Dock previews use Claude Opus 5.5 as their fixed model example.

- **Response token speed beside the model.** A fixed-width `tok/s` segment shows the latest response's output tokens divided by Pi's measured response duration, dimmed after completion. Generation highlights `— tok/s` because Pi has no reliable cross-provider live token count; missing measurements also stay unknown. Narrow terminals hide the entire segment before truncating the model, without changing the statistics row.

### Fixed

- **Running shells use a yellow marker.** Shell Inspector owns its running, completed and
  failed presentation colors.
- **Returning to the editor with Up does not recall history.** The dock consumes Up after
  restoring editor focus, so the same key cannot also select the previous submitted input.
- **Releasing a key no longer abandons dock Focus.** A terminal key-release event is ignored
  instead of falling through to the editor handoff branch, which treated it as typing.

### Changed

- **The info row keeps every statistic in place.** Each statistic keeps its own columns whether or
  not it has data, so bars and labels no longer move when tokens, cache or cost first arrive, and
  the model on the dock row now starts on one of the info row's bars. Cache writes have their own
  slot on the far left, so providers that never report them leave only blank space there. All
  statistics now need 120 columns instead of 117.

- **Context use reads `used/window · share`.** The cell shows the tokens in use over the window, then
  the share (`209k/272k · 76.8%`), instead of the share over the window. It is 7 columns wider, so
  narrow terminals now drop the cache, hit-rate, token and cost slots a little earlier.

- **Published Core dependency.** Require `@lune_99/pi-lune-core@^0.1.0` from npm instead of a sibling checkout. Core remains a mandatory runtime dependency for shared infrastructure and settings.

- **BREAKING: settings moved to Pi Lune Core.** The `contributions` map and
  `lune-extensions-settings/lune-dock-settings.json` are replaced by `hidden` and `order` in
  `<agentDir>/lune-settings/lune-dock.json`. The old file is not imported: the Dock has never
  been released. The package now needs `@lune_99/pi-lune-core`, `typebox` and
  `@earendil-works/pi-coding-agent` / `pi-tui` 1.0.4 or newer.

- **The dock replaces Pi's built-in footer.** It carries the footer's model, directory and usage
  information itself, and extension statuses set with `ctx.ui.setStatus()` follow on their own row.
  The `classic` style or turning the dock off keeps or restores Pi's footer. Pi allows one custom
  footer, so another extension installing its own replaces the dock's.

- **Dock protocol from Core.** The host uses `@lune_99/pi-lune-core/dock` and
  `/dock/host` for shared contribution registration and host ownership.

- **BREAKING: Lune Protocol v1 Draft 3.** `LuneDockSnapshot` contains required base and optional
  detail/full Components, each rendering exactly one line. Providers expose getSnapshot,
  subscribe and activate; full remains separate from plugin interaction. Remove DockItem,
  status/color/count fields and plugin ordering. Migrate the host and both plugins together;
  the lifecycle adapter now accepts getSnapshot(ctx) and activate(ctx).
- **Snapshot lifecycle.** Complete updates atomically replace all levels, hidden providers keep
  publishing, and invalidation reaches every current Component. Settings persist placement only;
  presentation snapshots remain ephemeral.
- **Cells are separated by a dim vertical bar.** Contributions in one row are joined with ` │ `
  instead of blank padding, so module boundaries stay readable in a wide row.
- **Document dock rendering rules.** Explain how the 12-column estimate limits visible
  cells and how scrolling keeps the selected item in view.
- **The info row keeps the cache hit rate the longest.** Tokens and cost now give way before
  `CH`, so a shrinking row keeps the hit rate beside context use and `(auto)` once cost is gone.
  The drop order is cache writes, cache reads, tokens, cost, hit rate and `(auto)`; the hit-rate
  slot survives down to 80 columns instead of 104, and cost down to 90 instead of 79.
