# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Follow session model**: Add a default summary-model choice that inherits the current session model and effort at the start of each compaction. Selecting a separate model retains independent thinking-level configuration.
- **Dedicated summary model**: Run manual, threshold and overflow compaction with a separately selected Pi model and thinking level, without changing the session model. Pi's native `compact()` still owns prompts, split turns, previous-summary updates, file operations and checkpoint writing.
- **Tool history review**: Optionally ask a Pi-registered classifier whether each fragment of an eligible tool result is safe to drop before summarizing. A call and its result are removed only when every fragment meets the drop confidence (default `0.7`); fragments exceeding the classifier window keep their arguments and are replaced with placeholders or preserved, while any other classification failure cancels the compaction.
- **Explicit cancellation**: Any summary or classification failure returns a cancel result instead of falling back to native compaction. `abortCompaction()`, session switches and leaf changes stop pending requests, and late results can never commit a checkpoint.
- **Lune settings section**: Configure the summary model, thinking level, classifier, drop confidence and deletable tools in the unified Lune panel with global and project scopes. Interception is on by default; Pi owns provider authentication and model capabilities.
- **Review notice and checkpoint metadata**: Pin a notice above the editor with the classifier, reviewed and protected calls, disjoint removal counts and the summary-input size. Each checkpoint records the summary model, effective thinking level and review statistics under `details.luneCompaction`.
- **Embedding API**: `installCompaction` and `createCompactionExtension` accept resolved options from the host instead of reading settings; returning `null` leaves native Pi compaction untouched. `CompactionController.getRun()` returns an isolated snapshot of the current run.
- **Visual README.** Introduce the extension with feature highlights, npm installation steps and previews rendered from its real TUI components. Regenerate the SVG and PNG assets with `npm run docs:images`.

### Changed

- **Published Core dependency.** Require `@lune_99/pi-lune-core@^0.1.0` from npm instead of a sibling checkout. Core remains a mandatory runtime dependency for shared infrastructure and settings.

- **Native Settings and Panel composition**: The configured installer binds Core
  Settings and independently registers its Panel through native Pi lifecycle callbacks.
  ResourceScope owns reverse cleanup; compaction cancellation stays plugin-owned.
  Models resolve directly through Pi, while selectors use Core's `/panel` helper.
  Existing settings IDs, policy controls and embedded-options contracts are unchanged.

- **Summary enabled by default**: Lune compaction now runs without an explicitly selected summary model and follows the session model and effort. Existing global and project overrides still apply, so select a model to keep summaries separate and turn Lune compaction off to keep Pi's native summary.
- **Pinned review notice**: The review notice is now a widget above the editor instead of a transcript notification, which Pi removed when the checkpoint committed. It shows request progress during the review and keeps the result until the next compaction or session change. The size change is split into per-result truncation and classifier drops, and drops inside fully removed calls no longer inflate the fragment count.
- **Reviewed `codemode` results**: A result that ran nested tools is now a review candidate when its nested record is complete, every nested call succeeded and every nested tool is in **Deletable tools**; otherwise it stays protected with a specific reason. Pi lists file operations before the review, so `readFiles`, `modifiedFiles` and the summary's file lists can still name files that only a removed call touched, as for removed `read` calls.

### Fixed

- **Pi package discovery.** Add the `pi-package`, `pi`, and `pi-coding-agent` npm keywords. The discovery keyword makes the package eligible for the official Pi package gallery once published.
