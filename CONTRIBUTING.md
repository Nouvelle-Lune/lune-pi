# Contributing

## Workspace structure

Each directory under `packages/` is an independently versioned npm package. Keep its public entry points, Pi manifest, documentation, changelog, and tests with the package. The root package is private and owns workspace commands, the shared lockfile, and CI.

Core provides shared infrastructure. Feature packages depend on Core; Core must not depend on feature packages or make decisions based on their names or internal state. Keep business state and feature workflows in their owning extensions. Public APIs should expose deliberate contracts with explicit ownership and lifecycle.

One exception: Core's optional Pi entry also adds local Pi, Codex and Claude Code sessions to Pi's `@` completion, in `src/mention/`. This small editor convenience builds on Pi's own completion and `SessionManager`, reads external transcripts locally, keeps no settings, and its only state is caches: a session index under `<agentDir>/lune-cache/` and caches owned by the current session. It stays out of the SDK exports. Do not add other features to Core on this basis; a feature that needs its own settings, model requests or a state machine belongs in its own package.

Use package imports such as `@lune_99/pi-lune-extensions-core/settings` for cross-package access. Do not import another package's private source files. Internal dependencies use normal semver ranges so the same manifests work in the workspace and in published packages.

## Branch workflow

`dev` is the default branch and integrates daily development through local merges and direct pushes. CI runs after each push; a PR into `dev` is optional. `main` contains validated stable work and is the source for package releases. Keep both branches; create a separate short-lived branch for each change that reaches the repository. Work that is never committed, such as local drafts in a gitignored directory, needs no branch: edit it in place on `dev` and do not stage it.

| Change                                           | Start from     | Integration                                       |
| ------------------------------------------------ | -------------- | ------------------------------------------------- |
| Feature, ordinary fix, refactor, docs or tooling | `origin/dev`   | Merge locally into `dev`, then push               |
| Promote validated development                    | Existing `dev` | PR into `main`, using Create a merge commit       |
| Urgent fix to the stable version                 | `origin/main`  | PR into `main`, using Create a merge commit       |
| Synchronize stable history                       | Latest `dev`   | Merge `origin/main` locally into `dev`, then push |

Create any PR only with explicit prior user consent. Authorization to develop, fix, or continue a task does not authorize PR creation. If a review PR into `dev` is explicitly requested, use a topic branch and normally Squash and merge; direct integration remains available.

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
git switch dev
git merge --ff-only origin/dev
git merge fix/tool-layout
git push origin dev
git branch -d fix/tool-layout
```

Validate the topic branch before integration, resolve any merge conflicts locally, and inspect the push-triggered CI result. `dev` does not require a PR or existing status-check results before accepting a push. CI failures remain visible and must be addressed before promoting the work to `main`.

When the integrated work is ready for a stable release, open a `dev` → `main` PR and validate the complete workspace and the affected extensions in Pi. Use Create a merge commit to preserve shared ancestry; squashing or rebasing promotions causes later PRs to repeat commits. Publish only the intended packages from the resulting `main` revision, then synchronize `main` back into `dev`.

For an urgent stable fix, create `hotfix/<description>` from `origin/main` and open its PR against `main`. This keeps unrelated development out of the stable fix. Merge with Create a merge commit, publish the affected package if needed, and synchronize the fix into `dev` before promoting more work.

Synchronize `main` directly after each promotion or hotfix:

```bash
git fetch --prune origin
git switch dev
git merge --ff-only origin/dev
git merge origin/main
git push origin dev
```

Resolve any conflicts on `dev`, validate the resulting merge, and push directly. Git fast-forwards when possible and otherwise preserves the stable history in a merge commit. No synchronization PR or extra topic branch is required. If `origin/main` is already an ancestor of `origin/dev`, synchronization is complete.

Both long-lived branches prevent deletion and force pushes. Only `main` requires PRs, resolved review threads, and up-to-date passing `Branch policy`, `check (22.19.0)` and `check (24)` checks; these rules apply to administrators and retain the existing zero required approving reviews. `dev` has no PR or pre-push status-check requirement, and its push-triggered CI still runs on both supported Node versions.

For explicitly approved PRs, the branch-policy check enforces topic naming and PR targets. Only this repository's `dev` and `hotfix/<description>` branches can target `main`. Optional PRs into `dev` may come from ordinary topic branches or this repository's `main`; stable hotfixes target `main` first. Fork contributions use topic branches targeting `dev`. CI reruns when a PR is retargeted.

The reviewed GitHub ruleset definitions live in `.github/rulesets/dev.json` and `.github/rulesets/main.json`. The `main` ruleset permits merge commits only; `dev` protects history without a PR or status-check gate. Repository settings use `dev` as the default, enable merge commits and squash merges, disable rebase merges, and automatically delete merged PR topic branches. Delete directly merged local and remote topic branches once their work is integrated. Changes to JSON files do not update GitHub automatically; after reviewing a ruleset change, a repository administrator must apply the matching file to its existing ruleset in GitHub.

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
