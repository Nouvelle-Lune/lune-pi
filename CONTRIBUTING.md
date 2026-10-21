# Contributing

## Workspace structure

Each directory under `packages/` is an independently versioned npm package. Keep its public entry points, Pi manifest, documentation, changelog, and tests with the package. The root package is private and owns workspace commands, the shared lockfile, and CI.

Core provides shared infrastructure. Feature packages depend on Core; Core must not depend on feature packages or make decisions based on their names or internal state. Keep business state and feature workflows in their owning extensions. Public APIs should expose deliberate contracts with explicit ownership and lifecycle.

One exception: Core's optional Pi entry also adds earlier sessions to Pi's `@` completion, in `src/mention/`. This small editor convenience builds on Pi's own completion and `SessionManager`, keeps no settings and no state beyond caches owned by the current session, and stays out of the SDK exports. Do not add other features to Core on this basis; a feature that needs its own settings, model requests or a state machine belongs in its own package.

Use package imports such as `@lune_99/pi-lune-extensions-core/settings` for cross-package access. Do not import another package's private source files. Internal dependencies use normal semver ranges so the same manifests work in the workspace and in published packages.

## Branch workflow

`dev` is the default branch and integrates daily development. `main` contains validated stable work and is the source for package releases. Keep both branches; create a separate short-lived branch for each change.

| Change                                           | Start from                             | PR target | Merge method          |
| ------------------------------------------------ | -------------------------------------- | --------- | --------------------- |
| Feature, ordinary fix, refactor, docs or tooling | `origin/dev`                           | `dev`     | Squash and merge      |
| Promote validated development                    | Existing `dev`                         | `main`    | Create a merge commit |
| Urgent fix to the stable version                 | `origin/main`                          | `main`    | Create a merge commit |
| Synchronize stable history                       | `origin/dev`, then merge `origin/main` | `dev`     | Create a merge commit |

Topic branch names describe the change, without personal, account, assistant, or tool names. Use `<type>/<description>` in lowercase, with hyphens between description words:

| Type                        | Example                     |
| --------------------------- | --------------------------- |
| New feature                 | `feat/session-mention`      |
| Ordinary fix                | `fix/link-hover`            |
| Refactor                    | `refactor/settings-state`   |
| Performance improvement     | `perf/transcript-rendering` |
| Documentation               | `docs/development-workflow` |
| Tests                       | `test/session-catalog`      |
| Tooling, dependencies or CI | `chore/branch-workflow`     |
| Urgent stable fix           | `hotfix/startup-crash`      |
| Synchronize stable history  | `sync/main-to-dev`          |

Start ordinary work from the latest remote integration branch:

```bash
git fetch --prune origin
git switch -c fix/tool-layout origin/dev
# Make the change and run focused validation.
npm run check
git push -u origin fix/tool-layout
gh pr create --base dev
```

Merge the PR with Squash and merge after CI succeeds, then delete its topic branch. Start the next task from the latest `origin/dev`, rather than continuing a branch whose commits were squashed.

When the integrated work is ready for a stable release, open a `dev` → `main` PR and validate the complete workspace and the affected extensions in Pi. Use Create a merge commit to preserve shared ancestry; squashing or rebasing promotions causes later PRs to repeat commits. Publish only the intended packages from the resulting `main` revision, then synchronize `main` back into `dev`.

For an urgent stable fix, create `hotfix/<description>` from `origin/main` and open its PR against `main`. This keeps unrelated development out of the stable fix. Merge with Create a merge commit, publish the affected package if needed, and synchronize the fix into `dev` before promoting more work.

Use a fresh synchronization branch after each promotion or hotfix:

```bash
git fetch --prune origin
git switch -c sync/main-to-dev origin/dev
git merge origin/main
git push -u origin sync/main-to-dev
gh pr create --base dev --head sync/main-to-dev
```

Resolve any conflicts on this topic branch, run the required checks, and merge its PR with Create a merge commit. Strict status checks require the PR head to include current `dev`; using a topic branch lets you meet that requirement without putting unreleased development into `main`. If `origin/main` is already an ancestor of `origin/dev`, synchronization is complete and no PR is needed.

Both long-lived branches require PRs, resolved review threads, and up-to-date passing `Branch policy`, `check (22.19.0)` and `check (24)` checks. Rules apply to administrators, prevent deletion and force pushes, and retain the existing zero required approving reviews. The branch-policy check enforces the naming convention and accepts ordinary PRs into `dev`; only this repository's `dev` and `hotfix/<description>` branches can target `main`. Fork contributions target `dev` from a topic branch following the same naming convention. CI reruns when a PR is retargeted.

The reviewed GitHub ruleset definitions live in `.github/rulesets/dev.json` and `.github/rulesets/main.json`. The `main` ruleset permits merge commits only; `dev` also permits Squash and merge for ordinary changes. Repository settings use `dev` as the default, enable merge commits and squash merges, disable rebase merges, and automatically delete merged topic branches. Branch protection keeps `dev` and `main` from being deleted. Changes to JSON files do not update GitHub automatically; after reviewing a ruleset change, a repository administrator must apply the matching file to its existing ruleset in GitHub.

## Setup and validation

Run `npm ci` at the repository root. Commit the root `package-lock.json`; do not create package-level lockfiles. Keep dependency requirements with the package that imports them. Pin Pi SDK development dependencies to `1.3.0` across the workspace so shared classes and branded types resolve to one version. Runtime peer ranges remain package-specific.

```bash
npm run format:check
npm run lint
npm run build
npm run typecheck
npm test
npm run pack:check
```

`npm run check` runs the complete validation sequence, including formatting and linting. CI runs these checks on both supported Node.js versions. Core must be built before consumers resolve its compiled exports; Recap also publishes compiled output. Build products remain untracked and are generated for packing and publication.

Run `npm run format` to apply the repository's Prettier 3.8.3 configuration. It matches the local Zed formatter: four spaces, a 100-column print width, double quotes, semicolons, trailing commas, and LF line endings. Zed's editor-format bridge reads `.prettierrc.json`, so editor saves and CI use the same rules. TypeScript, JavaScript, JSON, YAML, and Markdown are checked; generated assets, npm's lockfile, and immutable package changelogs are excluded in `.prettierignore`.

ESLint checks TypeScript and JavaScript with the ESLint and typescript-eslint recommended rules. Formatting belongs to Prettier; TypeScript's compiler checks types. Lint warnings fail validation. Keep shared tooling dependencies and configuration at the repository root.

For focused work, build Core first and use `--workspace=<package-name-or-path>`. Package-local demo and documentation commands remain available through the same workspace option.

Errors must remain visible. Do not add silent fallbacks, legacy branches, or automatic recovery that changes an unknown state into apparent success. Explain non-obvious lifecycle, protocol, and ordering constraints with short English comments.

## Changes and releases

Keep existing package names and independent versions. Add user-visible changes to the owning package's `CHANGELOG.md` under `Unreleased`; record shared repository tooling in the root `CHANGELOG.md`. Released sections are immutable.

Publish stable packages from a clean, validated `main` revision after its promotion or hotfix PR has merged. Before publishing a package, run the complete checks, inspect its tarball, and update any internal dependency ranges required by its public API. Publish Core before consumers when they require a new Core version. Publish only the intended workspace:

```bash
npm publish --workspace=<package-name> --access public
```

Use package-prefixed release tags, such as `pi-shell-inspector/v1.3.0`, to keep independent releases distinct. Importing the repositories does not publish new npm versions.
