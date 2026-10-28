# Changelog

## [Unreleased]

### Added

- **Claude Code agent guide.** Add a root `CLAUDE.md` that imports `AGENTS.md`, so Claude Code sessions start with the same rules as other agents. The rules stay in `AGENTS.md` only.
- **Shared lint and format checks.** Add ESLint for TypeScript and JavaScript and pin Prettier 3.8.3 to the local Zed formatting rules. Run `npm run format` to apply the style, or `npm run check` to validate formatting, lint, types, tests, and package contents; CI enforces the same checks on both supported Node.js versions.
- **Lune monorepo.** Bring Core and the six Lune extensions into one npm workspace with their existing package names and independent versions. A shared lockfile, Pi SDK 1.3.0 development baseline, root validation commands, and GitHub Actions check all seven packages together.
- **Subagent package in the workspace.** Add `@lune_99/pi-subagent` under `packages/pi-subagent` to the npm workspace and the shared lockfile. The root checks now cover it with the other packages, and the root README lists it with the family, its install line and `/agents`.
- **Native workspace recordings.** Add real Ghostty screenshots, a full Pi walkthrough and a GIF extracted from the recording, including all seven current themes. A repeatable capture script drives the actual plugin workflows with an offline model provider.
- **Review-workflow metrics.** Add `review-workflow/scripts/review-metrics.mjs`, which reports deletion age, fix-after-change pairs, rewritten commits, and line survival for a commit range. Git runs behind a read-only command allowlist with optional locks disabled and a metadata fingerprint check, so the script cannot modify the repository it measures, and its versioned JSON report is the baseline every later review change is judged against.
- **Bounded review loop.** Add the ledger state machine, reviewer contract, path-based tiers, replayable cases, and process documents under `review-workflow/`. Round caps, closure before the next round, and duplicate suppression are enforced by `review-round.mjs` rather than by prompts, so the loop converges or stops instead of spiraling, and `REVIEW.md` gives a reviewer a repository-specific definition of failure.

### Changed

- **Development and stable branches.** Use `dev` as the default integration branch, merge ordinary changes and stable history locally, and push directly with CI running afterward. Both branches prevent force pushes and deletion; `main` additionally requires PRs and passing checks for promotions and stable hotfixes. Topic branches use purpose-based `<type>/<description>` names, and every PR requires explicit prior user consent. Local drafts that never enter the repository, such as gitignored notes, need no branch and stay out of commits.
- **Unified package names.** Rename all seven workspaces to `@lune_99/pi-lune-extensions-core`, `@lune_99/pi-core-theme`, `@lune_99/pi-dock`, `@lune_99/pi-ask-question`, `@lune_99/pi-shell-inspector`, `@lune_99/pi-compaction` and `@lune_99/pi-recap`, with matching `packages/` directories.
- **Current CI actions.** Use checkout 7.0.1 and setup-node 7.1.0 so the workflow uses their current supported runtimes.
- **Latest plugin sources.** Synchronize all seven local packages, including current rendering, settings, Dock integration and documentation, into the workspace. Adapt development dependency paths to the shared install and retain the Pi SDK 1.3.0 development baseline.
- **License-only README header.** Keep the MIT license badge and drop the CI status badge.
- **Inspector version aligned.** Return `@lune_99/pi-shell-inspector` to 0.1.0 so all seven workspaces share the version published on npm.
- **Single agent guide.** Consolidate the per-package `AGENTS.md` rules into the root guide, delete the duplicated package copies, and keep the Core agent notes local-only in `.gitignore` and `.npmignore`. The copies had drifted apart while repeating the same rules, so agent instructions now change in one place.
- **Local design drafts.** Ignore `.docs/` so working design notes stay out of commits and need no branch.

- **Preview capture from a local skill.** Move the README screenshot and recording pipeline out of `tools/` into the repository-level `capture-readme-previews` skill, drop the root `docs:previews` script, and point the preview guides at the skill. The capture code regenerates maintainer assets rather than shipping with any package, so it no longer belongs in the workspace.

[Unreleased]: https://github.com/Nouvelle-Lune/lune-pi/commits/dev
