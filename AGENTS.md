Read `CONTRIBUTING.md` before changing code. Preserve package ownership and the dependency direction from features to Core.

## Branches

- `dev` is the default integration branch; `main` is the stable release branch. Keep both long-lived branches.
- Fetch before starting work. Create ordinary topic branches from `origin/dev`, validate the change, then merge locally into `dev` and push directly. Name branches `<type>/<description>` with types `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `hotfix`, or `sync`; use lowercase words and hyphens, without personal, account, assistant, or tool names. Delete merged topic branches.
- Create a PR only with explicit prior user consent. Authorization to develop, fix, or continue work does not authorize PR creation. PRs targeting `dev` are optional.
- Use the user's own Git author identity for commits. Do not add bot or assistant attribution or co-author trailers.
- Promote validated work with a `dev` → `main` PR using a merge commit. Never squash, rebase, force-push, or delete either long-lived branch.
- For urgent stable fixes, create `hotfix/<description>` from `origin/main` and target `main` with a merge commit. Synchronize `main` into `dev` after a promotion or hotfix.
- Synchronize stable history by merging `origin/main` directly into the latest `dev`, then push `dev`. Keep merge ancestry; no synchronization PR or extra topic branch is required.
- `dev` allows direct pushes and runs CI afterward; it prevents force pushes and deletion. Do not push directly to `main`: it requires the branch-policy check, both Node CI checks, an up-to-date PR, and resolved review threads, including for administrators.

## Code

- Use English comments only for non-obvious constraints and reasons.
- Do not add silent fallbacks or compatibility with replaced behavior.
- Keep npm package names, public APIs, and versions stable unless the task changes them explicitly.
- After changing TypeScript in a package with `.scripts/format-ts.sh`, run `bash .scripts/format-ts.sh` from that package directory. Do not modify formatter scripts without an explicit user request.

## Code Comments

Comments explain **why**, not what.

- Prefer clear code over comments.
- Comment only non-obvious constraints: API/protocol behavior, lifecycle or ordering requirements, security concerns, upstream quirks, and intentional workarounds.
- Keep comments short and consistent with surrounding code.
- Do not narrate code, record change history, or leave commented-out code.
- TODO/FIXME must state the unresolved constraint and reference an issue when available.
- Update expired comments promptly.

## Tests

Do not create or modify tests unless the `test-writer` skill is triggered. Existing tests can be run without changing them. Never weaken valid assertions to make an implementation pass.

Run focused checks while working and `npm run check` before completing a workspace-wide change. Report existing failures separately and preserve the failing command and output.

## Changelog

Read [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) before editing a changelog. Put new entries under `Unreleased` in the owning package's `CHANGELOG.md`; record shared repository tooling in the root `CHANGELOG.md`. Never edit released sections.

- Put all new entries under `## [Unreleased]`, in the right subsection (`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`, `### Refactored`). Read the section first and append to existing subsections; never duplicate them.
- Breaking changes are not a separate subsection. Call them out with a `> **⚠️ Breaking: …**` blockquote at the top of the version section, and/or a bold `**BREAKING:**` bullet under `### Changed`, with a migration note.
- Entries are concise — a bold lead-in stating what changed, then a sentence or two on why it changed and anything a user must do about it. Aim for 2–4 sentences; a genuinely intricate change may run longer, but length is never the goal. Do not match the density of older entries, several of which are far too long.
- Cut what the reader doesn't need: narration of the investigation, alternatives considered and rejected, restatements of the diff, and detail recoverable from the code or the linked issue. Name a file or symbol only when it helps someone find the change.
