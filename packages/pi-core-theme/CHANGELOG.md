# Changelog

All notable changes are documented here using
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Independent Lune appearance.** The theme ships as its own Pi extension, so
  `@lune_99/pi-lune-core` and its consumers no longer install appearance code. A
  default-off `Core theme` switch (`lune-core-theme.enabled`) heads the `Theme`
  section of `/lune-core-settings` and controls every change below.
- **Lune header.** The ice-blue pixel moon, `L U N E` wordmark, theme/Pi versions and
  configured shortcuts fit in five lines and reflow in narrow terminals. Expanded
  startup help follows Pi's tool-output toggle.
- **Moonlight palettes.** `pi-core-dark` and `pi-core-light` are built from the
  header's moon gradient, with sea-glass, rose and pale-gold status tones; thinking
  levels and diff tints follow the same palette. Disabling the theme restores the
  preceding palette, including after `/reload`.
- **Lune tool cards.** `on`/`compact`/`off` display modes render cards, call trees,
  groups and live thinking with one row vocabulary: a moon-phase mark while running,
  `●` when done or failed and `○` when cancelled. Collapsed cards take one row ending in
  `click to show more`; rich edit/write diffs and a full-output browser cover the rest.
- **Markdown and `/context`.** Additional Mermaid dialects, GitHub admonitions and bare
  URLs render while the theme is on, and `/context` browses context usage by category.
- **Theme renderer protocol.** While the theme renders tools, it publishes an
  activity-card renderer under `Symbol.for("nouvelle-lune.lune-theme-renderer.v1")` for
  surfaces Pi's tool-renderer chain does not reach, such as custom messages.
  Consumers keep their own renderer for when it is absent. Passing a stable `key` makes the
  card clickable: its heading and hidden-output rows open it, and clicking an open card closes
  it, like a tool card. An open card shows the last `expandedOutputMaxLines` of each entry's
  output, then `… more output · click to view full output`, which opens the full-output browser.
  An entry whose `output` is only a retained tail can name its complete log in `fullOutputPath`;
  the browser then reads that file.
- **Five more palettes.** Aurora, Eclipse and Nebula (dark) and Dawn and Mist (light) join
  Lune Core Dark and Light under **Style · Color palette**. Each has its own crescent
  gradient, which also tints the header moon and thinking levels, and is a standalone Pi
  theme (`pi-core-aurora`, `pi-core-eclipse`, `pi-core-nebula`, `pi-core-dawn`, `pi-core-mist`).
- **Visual README.** Introduce the extension with feature highlights, npm installation steps and previews rendered from its real TUI components. Regenerate the SVG and PNG assets with `npm run docs:images`.
- **Cmd+click paths and links.** When the terminal supports OSC 8 links, existing file
  paths in messages, path-tool headings and tool output become `file://` links, and URLs in
  tool output become links. Markdown links to local paths, such as `cards.ts:42`, also get
  `file://` targets, so Cmd+click opens them. Terminals without OSC 8 support show the same
  text as before.

### Changed

- **Context presentation.** The centered browser is capped at 100 columns and 24 rows,
  with a Pi usage header and category values that follow the active theme. The solid
  composition bar includes remaining capacity calculated from the category estimates;
  adjustment rows, repeated totals and explanatory footer text are removed.
- **Context browser controls.** `/context` follows Shell Inspector's pane controls:
  Up/Down or the left-pane wheel selects a category, while the right-pane wheel,
  Shift+Up/Down and Page Up/Down scroll its content. Context and full-output text wrap
  to the pane width; horizontal scrolling and Tab navigation are removed, and context
  content is no longer truncated.
- **Published Core dependency.** Require `@lune_99/pi-lune-core@^0.1.0` from npm instead of a sibling checkout. Core remains a mandatory runtime dependency for shared infrastructure and settings.

- **Command-chain summaries.** Tool cards render a pipeline as one command, skip `cd` and
  bare `echo` labels, and stop reading heredoc bodies as further commands, so a long inline
  script no longer hides the commands after it or exhausts the scan limit. Whole commands
  are shown while they fit the 80-column budget, which keeps the hidden-command count from
  being clipped, and `+N args` now agrees in number.
- **Summary caching.** Command summaries are cached per command string so cards stop
  re-summarizing multi-KB scripts on every frame; the cache clears at 64 entries.
- **Startup header reads global settings.** The header decision runs before Pi resolves
  project trust, so `enabled` and `showStartupHeader` come from the global value
  (`readGlobalSettings`) and ignore project overrides for that first frame. The rest of the
  theme still follows project overrides in trusted projects. Settings now live in
  `<agentDir>/lune-settings/lune-core-theme.json`.

### Fixed

- **Context accounting.** `/context` uses Pi's context usage API for the same total and
  percentage as Dock, preserving zero and unknown values. Categories use Pi's token
  estimator, merged system sections and complete current tool declarations, so replaced
  sections and removed tools are no longer counted from history.
- **Expanded panels closing on their own.** A panel stays open when the next assistant round,
  its thinking or its text starts; it closes only when clicked or when another card is opened,
  and Pi's own expand toggle is never undone. A card you opened stays open when the next call
  merges it into a group, and when Pi rebuilds the transcript after compaction or tree
  navigation.
- **Native header flash at startup.** Pi renders its own header before any extension
  receives `session_start`, so the Lune header used to appear one frame late. It now
  replaces the native header as Pi adds it, so the first frame is already Lune's. Pi's
  header stays whenever the theme or `showStartupHeader` is off, or the Pi internals it
  relies on are missing. `/reload` and the palette still apply at `session_start`; set
  Pi's own theme to `pi-core-dark` to avoid a palette flash at startup.
- **Native flash on reload.** Pi resets extension UI and re-applies its saved theme
  between the outgoing and incoming instances, so the native header and palette covered
  the whole rebuild after `/reload` or a session replacement. The outgoing instance now
  leaves its appearance in place, the reset and theme re-apply are countered before a
  frame renders, and the incoming instance adopts it instead of rebuilding it.
- **Dark and light palettes looking swapped.** Pi themes leave the page background to the
  terminal, so `pi-core-light` on a dark profile showed dark text on black, and
  `pi-core-dark` washed out on a light one. While a Lune palette is applied, the theme now
  sets the terminal's default background and text to the palette's (OSC 11/10) and restores
  the profile's colors when the palette is turned off or Pi exits. Turn
  **Style · Palette background** (`paletteBackground`) off to keep the terminal's colors.
- **Style resets in clipped summaries.** Summaries clip plain text instead of
  `truncateToWidth`, whose trailing ANSI reset ended the card's own styling early.
- **Lag in long sessions.** Moving the pointer in fullscreen no longer re-renders every
  collapsed tool group, and `edit`/`write` `+N -M` summaries are computed once per result
  instead of on every re-render, so hovering, startup and theme changes stay fast as history
  grows. The thinking animation now runs at 30 fps through Pi's render throttle instead of
  forcing 120 full-transcript renders per second.
- **Codemode code flash while streaming.** A collapsed codemode card showed the streamed
  script as raw code, then replaced it with the call tree when the first nested call
  started, so the card flashed and jumped. The collapsed card now keeps its heading and
  adds one row per call; expand the card to read the script.
- **Codemode cards counting themselves as a call.** A codemode script that called no
  tools, for example one that only used `ALL_TOOLS`, `searchTools()` or `text()`, showed
  `1 call` with no call row under it, because the heading counted the codemode call
  itself. The heading now counts only nested calls and shows `0 calls` for such a script.
- **Screen jump when grouped tools start.** Bash reports an empty result as it starts,
  and a collapsed group added a blank output row for each running call, then removed the
  rows when the calls finished. In fullscreen this moved the whole transcript up and back
  down on most turns with parallel calls. Groups now skip empty output, as standalone cards do.
