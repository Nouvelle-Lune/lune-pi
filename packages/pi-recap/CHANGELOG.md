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
- **Delay re-arming.** The idle-delay timer re-evaluates its conditions when it
  fires, so a timer that fires a moment before the wall clock reaches the
  deadline re-arms instead of dropping the recap.
- **Pi package discovery.** Add the `pi-package`, `pi`, and `pi-coding-agent` npm keywords. The discovery keyword makes the package eligible for the official Pi package gallery once published.
