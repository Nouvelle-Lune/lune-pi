## Change

Describe the problem, the resulting behavior, and any affected packages.

## Validation

List the focused checks, the result of `npm run check`, and any relevant Pi validation. Report existing failures separately.

## Branch flow

- Topic branch: `<type>/<description>` using lowercase words and hyphens, without personal, account, assistant, or tool names. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `hotfix`, `sync`.

- [ ] Ordinary change: branch from `dev`, target `dev`, and use Squash and merge.
- [ ] Promotion: `dev` → `main`, use Create a merge commit, and synchronize `main` back into `dev` afterward.
- [ ] Stable hotfix: `hotfix/<description>` from `main`, target `main`, use Create a merge commit, and synchronize afterward.
- [ ] Synchronization: `sync/main-to-dev` from `dev`, merge `main` into that topic branch, target `dev`, and use Create a merge commit.

Select the applicable route. Keep `dev` and `main`; delete merged topic branches.
