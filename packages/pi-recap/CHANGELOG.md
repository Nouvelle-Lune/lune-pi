# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Independent Recap package.** Native Pi lifecycle, commands, business runtime,
  Settings/Panel definitions, tests and offline PTY fixtures move from Core.
  Load this extension explicitly to retain `/recap`.
- **Public Core composition.** Configuration uses `bindSettings`, the Panel uses
  `registerSettingsPanel` and `modelChoices`, and local resources use
  `ResourceScope`; no managed framework or private Core import is required.
- **Visual README.** Introduce the extension with feature highlights, npm installation steps and previews rendered from its real TUI components. Regenerate the SVG and PNG assets with `npm run docs:images`.
- **Configurable silent retries.** Maximum retries defaults to three retries after the initial request for temporary errors identified by Pi. Set it to zero to disable retries; intermediate failures stay silent, and only the final failure warns. Incomplete responses and other non-retryable failures still stop immediately.

### Changed

- **Published Core dependency.** Require `@lune_99/pi-lune-core@^0.1.0` from npm instead of a sibling checkout. Core remains a mandatory runtime dependency for shared infrastructure and settings.

- **Tighter recap prompt.** Recap leads with the active goal, concrete progress
  and the current blocker or limitation, adds at most one supported next step,
  follows the latest correction, and treats a tool-status entry as that
  operation's reported outcome rather than task completion.
- **Stable existing data.** The Settings namespace remains `lune-core.recap`,
  Panel ID remains `recap`, and session metadata remains `lune-core.recap.v1`.
  Package extraction requires no configuration or session-data migration.
- **Substantial-work eligibility.** Automatic recap is measured on the latest
  completed round instead of three completed rounds and requires real work:
  five tool results or sixty seconds from the prompt to the final reply. A
  trivial completed round waits for a substantial one, and an aborted round is
  skipped so the preceding completed round decides.

### Fixed

- **Cached recap redisplay.** Track the mounted widget per runtime instead of
  using persisted display history to suppress it. Cached recaps can reappear
  after reload, branch restoration, or equivalent effective settings changes
  without another model request; active prompts still defer display.
- **Recap after reload.** A saved recap that matches the restored session shows
  again as soon as `/reload` or a session restart finishes, instead of waiting
  for the terminal to lose and regain focus. With automatic recap off, only a
  recap that was already shown returns. Showing a recap again no longer
  appends another session entry.
- **Delay re-arming.** The idle-delay timer re-evaluates its conditions when it
  fires, so a timer that fires a moment before the wall clock reaches the
  deadline re-arms instead of dropping the recap.
- **Pi package discovery.** Add the `pi-package`, `pi`, and `pi-coding-agent` npm keywords. The discovery keyword makes the package eligible for the official Pi package gallery once published.
- **Final failure diagnostics.** Save the actual attempt count, failure time and bounded protocol metadata only after generation ends. Raw provider errors and response content are not persisted, and cancelled or stale requests neither warn nor write failure records.
