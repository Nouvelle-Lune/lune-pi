[Back to the README](../README.md)

# Lune Dock

A compact, keyboard-operated status block below the Pi editor. It shows the model, working
directory and usage statistics, and holds one cell per Lune Pi extension. Select a cell with the
keyboard and press Enter to open its existing interface directly; there is no action menu.

```text
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ○ Shell │ ○ Ask                                                                │ (anthropic) claude-opus-5-5 • max
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   …/local-extensions/pi-recap   (main)      │ R187k │ CH 98.9% │ ↑28k  ↓5.6k │ $0.008  │  27k/1.0M · 2.7%  │ (auto)
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

The dock **replaces Pi's built-in footer**, so every statistic it showed stays visible:

| Row  | Left                                         | Right                                                                                                               |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Dock | Module cells, one per contributing extension | `(provider) model • thinking level`                                                                                 |
| Info | Working directory, git branch, session name  | Cache `W`rite, cache `R`ead, `CH` cache hit, tokens `↑in ↓out`, cost, context use (`used/window · share`), `(auto)` |

Statuses set by other extensions through `ctx.ui.setStatus()` follow on a row of their own.
The statistics sit on a fixed grid against the right edge. Every statistic owns a slot of fixed
width and keeps it whether or not it has data, so no bar or label ever moves while a session runs.
Text starts one column after its bar, with the label attached to its number; a growing number uses
only the padding behind it. A slot with no data yet stays blank: a fresh session shows only context
use and `(auto)`, and the others fill their own columns once Pi reports tokens, cache or cost.
Slots that often stay blank, such as cache writes for providers that do not report them, sit on
the left, so their blank columns join the gap after the directory.

The model starts on one of the info row's bars, so the bar before it continues a bar below. It takes
the rightmost bar that leaves room for it within half the row, drops the provider before it gives up
that alignment, and sits flush right only when no bar fits even the bare model.

Which slots are reserved depends on the terminal width alone: a narrow terminal drops cache writes,
cache reads, hit rate, tokens, cost and `(auto)` in that order, always keeps context use, and gives
the rest to the working directory, which is shortened from the left against the full reservation so
it does not move either. Below 40 columns the model is hidden so the cells keep the whole row.
Provider shows only when more than one is available, and `(auto)` reflects the compaction setting
read when the session starts.

Every cell composes exactly one physical row. Plugins own their complete text, markers and theme
styling. Dock selects a level, allocates horizontal width, separates cells with a dim bar and
highlights the selected contribution. Focus adds `❯` and puts the key hints on the rule under the
cells, so they never change a cell's width allocation. With no contributions the model and info
rows still render.

Pi allows one custom footer: if another extension installs its own after the dock, that footer
replaces the dock's; choose the `classic` style or turn the dock off to avoid the clash. The
folder and branch icons are Nerd Font glyphs.

## Styles

Choose a style in `/dock`; the panel previews it, focused, before you commit.

| Style             | Rows                                              | Notes                                               |
| ----------------- | ------------------------------------------------- | --------------------------------------------------- |
| `ruled` (default) | Rule, dock + model, rule, directory + usage, rule | Key hints ride the rule under the cells             |
| `boxed`           | The same rows in a rounded box                    | Key hints ride the box's middle rule                |
| `compact`         | Dock + model, directory + usage                   | No frame; key hints replace the model while focused |
| `minimal`         | Cells + model + context use                       | One row, plus extension statuses when present       |
| `classic`         | Cells only                                        | Leaves Pi's own footer in place                     |

```text
╭──────────────────────────────────────────────────────────╮
│ ○ Shell │ ○ Ask                      │ model • max       │   boxed
├──────────────────────────────────────────────────────────┤
│  ~/proj  (main)        │ ↑28k  ↓5.6k │  27k/1.0M · 2.7%  │
╰──────────────────────────────────────────────────────────╯

 ○ Shell │ ○ Ask                       │ model • max         compact
  ~/proj  (main)         │ ↑28k  ↓5.6k │  27k/1.0M · 2.7%
```

Every style except `classic` takes over Pi's footer. Three switches trim what those styles
show: model, directory (with branch) and usage. `minimal` ignores the directory and keeps only
context use from the usage counters.

## Installation

Lune Dock and its contributor extensions use the Dock protocol from
`@lune_99/pi-lune-extensions-core/dock`; Core also supplies the shared settings infrastructure.

```sh
pi install npm:@lune_99/pi-dock
```

Reload extensions in an existing Pi session with `/reload`, or start a new session.
The host is optional: removing it from Pi's active packages restores each contributor's
independent dock.

## Settings

Run `/dock` to open the **Dock** section.
Enter or Space cycles a value, Ctrl+G switches between the global and project scope,
and Ctrl+R removes the selected override. Changes apply immediately, including turning Dock
off, which removes the block and its keyboard listener and restores Pi's footer and each plugin's
independent status bar; plugin panels and commands stay usable.

| Setting                                   | Values                                                    | Default            |
| ----------------------------------------- | --------------------------------------------------------- | ------------------ |
| `enabled`                                 | on / off                                                  | on                 |
| `style`                                   | `ruled`, `boxed`, `compact`, `minimal`, `classic`         | `ruled`            |
| `displayMode`                             | `base`, `detail`, `full`                                  | `detail`           |
| `showModel`, `showWorkspace`, `showUsage` | on / off                                                  | on                 |
| `hidden`                                  | plugin ids left out of the dock                           | none               |
| `order`                                   | plugin id → position, smaller first (missing counts as 0) | registration order |

Values live in `~/.pi/agent/lune-settings/pi-dock.json` (`PI_CODING_AGENT_DIR` moves the agent
directory; project overrides are in `<project>/.pi/lune-settings/pi-dock.json`), and only
overrides are stored. Core writes the file owner-only. A project value beats a global one, which
beats the default, and untrusted projects are ignored. Invalid files and failed writes report
errors instead of silently resetting settings.

```json
{
    "style": "boxed",
    "hidden": ["ask-question"],
    "order": { "shell-inspector": 10 }
}
```

## Keyboard interaction

| Context                                           | Key                                      | Result                                                     |
| ------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Main editor, empty and no autocomplete or overlay | Down                                     | Focus the dock                                             |
| Main editor, no autocomplete or overlay           | Super+Down                               | Focus without clearing the text                            |
| Dock                                              | Left / Right                             | Select previous / next module, wrapping at the ends        |
| Dock                                              | Home / End                               | Select the first / last module                             |
| Dock                                              | Enter                                    | Open the selected module directly                          |
| Dock                                              | Up / Esc                                 | Return to the editor without forwarding the navigation key |
| Dock                                              | Typing, paste or an application shortcut | Return to the editor and deliver the input                 |

`Super` is Command on macOS. Delivery depends on the terminal's keyboard protocol and its
own shortcuts. Terminal key-release events are ignored, so releasing a key never hands focus
back to the editor. Ordinary Down always leaves non-empty editor text and other panels alone.
Custom main editors should extend Pi's `CustomEditor`, as recommended by Pi's editor contract.

Closing a panel opened from the dock returns to dock focus. If that module disappears,
selection moves to its nearest remaining neighbor; if all modules disappear, the editor
gets focus. A session shutdown, reload or tree jump invalidates pending focus restoration.

## Plugin presentations

Shell Inspector supplies base identity, a detail summary of running/completed/failed jobs, and
a full summary with the latest command and elapsed time. Unseen failures remain red; running
work uses yellow and completed history uses green. Opening and closing the inspector
acknowledges failures present at open, while later failures remain unseen. Only-failed history
stays red. This is plugin-owned, ephemeral view state.

Ask Question supplies base identity, pending request count in detail (requests, rather than
individual questions), and the next request's subject in full. Enter opens the existing
`/question` panel, including draft persistence on Esc. Both plugins remain registered when idle,
showing only their status marker and name at every display level. Visibility is controlled by
Dock settings and never by plugin state.

The Dock protocol in Core (`@lune_99/pi-lune-extensions-core/dock`, protocol version 1) exposes `LuneDockSnapshot` and
`LuneDockProvider`: `getSnapshot()`, `subscribe(listener)` and `activate()`. Every supplied
Component renders exactly one line. Optional level resolution is deterministic: detail uses
detail or base; full uses full, detail or base. There are no status/count/color fields.
Snapshot updates atomically replace all levels and snapshots are never persisted.

Narrow terminals allocate bounded widths and keep a scrolling window around selection with
neutral counts of contributions outside each edge. Left/Right reaches every visible plugin.
This version uses manual display mode and per-Component clipping; automatic fit-based level
selection remains a future Dock implementation choice.

## Lifecycle and failures

The shared registry lives behind `Symbol.for("nouvelle-lune.lune-protocol.v1")` and is scoped by the
stable `ctx.ui` object for a Pi runner. Multiple installed protocol copies share that registry;
separate UI contexts do not share contributions. The contributor adapter owns registration and host-presence handling. Plugins call
`attach(ctx)` after restoring business state, `detach({ retired: true })` before replacing a
session, `refresh()` on state changes, and `detach()` at shutdown. Host infrastructure uses
the separate `/host` library entry point. Duplicate contribution IDs or active hosts throw.

The host announces presence only after its widget and input listener are installed.
Contributors then clear their own keyed widget; normal detachment restores standalone display.
Contributor updates are coalesced in one microtask, and output-only shell changes do not redraw
the compact row. Invalid single-line output throws a protocol contract error; opening and lifecycle errors
are reported visibly and never trigger a silent switch to standalone mode. Failed initialization releases the ownership it could not finish.

## Validation

```sh
npm run typecheck
npm test
npm run tui:demo
```

The demo uses local fixtures and the real Pi TUI, with no paid model call. Automated tests
cover protocol lifecycle, rendering, keyboard ownership, focus restoration, contributor status,
and coexistence with the existing independent docks. A visual demo is an observation, not
a substitute for those tests.
