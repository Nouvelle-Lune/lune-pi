# Contributing

## Workspace structure

Each directory under `packages/` is an independently versioned npm package. Keep its public entry points, Pi manifest, documentation, changelog, and tests with the package. The root package is private and owns workspace commands, the shared lockfile, and CI.

Core provides shared infrastructure. Feature packages depend on Core; Core must not depend on feature packages or make decisions based on their names or internal state. Keep business state and feature workflows in their owning extensions. Public APIs should expose deliberate contracts with explicit ownership and lifecycle.

Use package imports such as `@lune_99/pi-lune-extensions-core/settings` for cross-package access. Do not import another package's private source files. Internal dependencies use normal semver ranges so the same manifests work in the workspace and in published packages.

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

Before publishing a package, run the complete checks, inspect its tarball, and update any internal dependency ranges required by its public API. Publish Core before consumers when they require a new Core version. Publish only the intended workspace:

```bash
npm publish --workspace=<package-name> --access public
```

Use package-prefixed release tags, such as `pi-shell-inspector/v1.3.0`, to keep independent releases distinct. Importing the repositories does not publish new npm versions.
