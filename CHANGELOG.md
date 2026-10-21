# Changelog

## [Unreleased]

### Added

- **Shared lint and format checks.** Add ESLint for TypeScript and JavaScript and pin Prettier 3.8.3 to the local Zed formatting rules. Run `npm run format` to apply the style, or `npm run check` to validate formatting, lint, types, tests, and package contents; CI enforces the same checks on both supported Node.js versions.
- **Lune monorepo.** Bring Core and the six Lune extensions into one npm workspace with their existing package names and independent versions. A shared lockfile, Pi SDK 1.3.0 development baseline, root validation commands, and GitHub Actions check all seven packages together.
- **Native workspace recordings.** Add real Ghostty screenshots, a full Pi walkthrough and a GIF extracted from the recording, including all seven current themes. A repeatable capture script drives the actual plugin workflows with an offline model provider.

### Changed

- **Development and stable branches.** Use `dev` as the default integration branch and promote validated work to `main` with merge commits. Topic branches use purpose-based `<type>/<description>` names; CI enforces naming and PR targets, while reviewed rulesets require passing checks and protect their history. Create ordinary branches from `origin/dev` and reserve `main` for promotions and stable hotfixes.
- **Unified package names.** Rename all seven workspaces to `@lune_99/pi-lune-extensions-core`, `@lune_99/pi-core-theme`, `@lune_99/pi-dock`, `@lune_99/pi-ask-question`, `@lune_99/pi-shell-inspector`, `@lune_99/pi-compaction` and `@lune_99/pi-recap`, with matching `packages/` directories.
- **Current CI actions.** Use checkout 7.0.1 and setup-node 7.1.0 so the workflow uses their current supported runtimes.
- **Latest plugin sources.** Synchronize all seven local packages, including current rendering, settings, Dock integration and documentation, into the workspace. Adapt development dependency paths to the shared install and retain the Pi SDK 1.3.0 development baseline.
- **License-only README header.** Keep the MIT license badge and drop the CI status badge.
- **Inspector version aligned.** Return `@lune_99/pi-shell-inspector` to 0.1.0 so all seven workspaces share the version published on npm.
- **Single agent guide.** Consolidate the per-package `AGENTS.md` rules into the root guide, delete the duplicated package copies, and keep the Core agent notes local-only in `.gitignore` and `.npmignore`. The copies had drifted apart while repeating the same rules, so agent instructions now change in one place.

[Unreleased]: https://github.com/Nouvelle-Lune/lune-pi/commits/dev
