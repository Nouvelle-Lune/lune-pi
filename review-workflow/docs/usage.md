# Script usage guide

Three scripts, no dependencies, Node >= 22. Run them from anywhere; pass `--repo` when
the current directory is not the repository.

| Script                       | Purpose                                        | Writes              |
| ---------------------------- | ---------------------------------------------- | ------------------- |
| `scripts/review-metrics.mjs` | Measure where rework goes in a commit range    | Nothing (read-only) |
| `scripts/review-round.mjs`   | Drive one change through bounded review rounds | JSON ledgers        |
| `scripts/review-cases.mjs`   | Store and replay review regression cases       | Nothing (read-only) |

All three print human-readable text by default and machine JSON with `--json` (the
round script prints JSON for `start`, `close`, `abandon`, and the review payload).

---

## review-metrics.mjs

### Usage

```bash
node review-workflow/scripts/review-metrics.mjs [options]
```

| Option                              | Default                 | Meaning                                                    |
| ----------------------------------- | ----------------------- | ---------------------------------------------------------- |
| `--repo <path>`                     | current directory       | Repository to measure                                      |
| `--range <a..b>`                    | all history of `--head` | Commit range                                               |
| `--head <rev>`                      | `HEAD`                  | Revision for survival analysis and the default range       |
| `--since <date>` / `--until <date>` | none                    | Passed to `git log`                                        |
| `--json`                            | off                     | Machine-readable report on stdout                          |
| `--output <path>`                   | none                    | Write the JSON report to a file **outside** the repository |
| `--top <n>`                         | 8                       | Examples per section                                       |
| `--rework-window-hours <n>`         | 24                      | Window for fix-after-change pairs                          |
| `--fix-types <list>`                | `fix,hotfix`            | Commit types treated as fixes                              |
| `--exclude <glob>`                  | none                    | Skip a path from deletion/rework analysis; repeatable      |
| `--max-commits <n>`                 | 2000                    | Keep the newest N commits                                  |
| `--max-blame-calls <n>`             | 4000                    | Cap `git blame` calls                                      |
| `--max-file-pairs <n>`              | 2000                    | Cap verified fix-after-change pairs                        |
| `--min-survival-lines <n>`          | 20                      | Minimum added lines for a survival sample                  |
| `--no-rewrites`                     | off                     | Skip the unreachable-commit scan                           |
| `--no-survival`                     | off                     | Skip survival analysis                                     |
| `--self-check <mode>`               | `strict`                | `strict`, `warn`, or `off`                                 |
| `--pull-requests`                   | off                     | Add GitHub PR aggregates (network, requires `gh`)          |
| `--pr-limit <n>`                    | 200                     | PRs fetched with `--pull-requests`                         |
| `--timestamp`                       | off                     | Include `generatedAt` (breaks byte-identical output)       |
| `--quiet`                           | off                     | Suppress progress on stderr                                |

### What the output means

| Field                            | Reading                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `deletions.youngShare`           | Share of removed lines written less than a day earlier. High means changes are rewritten right after landing. |
| `deletions.buckets`              | `lt1h`, `lt6h`, `lt1d`, `lt3d`, `lt7d`, `lt14d`, `gte14d`, `unknown`                                          |
| `deletions.byArea`               | `code`, `docs`, `bookkeeping`, `assets`, `other`                                                              |
| `selfRework.events`              | Fix commits that follow a non-fix commit on the same file inside the window                                   |
| `selfRework.sameBranch`          | Pairs with no merge between them: in-session repair                                                           |
| `rewrites.rewrittenBeforeLanded` | Unreachable commits matched to a landed commit by subject, tree, or author time: amendments and rewords       |
| `rewrites.abandoned`             | Unreachable commits that never landed                                                                         |
| `survival.mean`                  | Share of added lines still present at the analyzed revision                                                   |
| `caveats`                        | Automatic warnings about young history, caps, and unattributed lines                                          |

`caveats` is not decoration. In a repository younger than thirty days every age bucket
covers the whole history, so `youngShare` is only comparable across runs of similar age.

### Examples

```bash
# Baseline before touching the workflow.
node review-workflow/scripts/review-metrics.mjs --json > /tmp/metrics-before.json

# Code only, last 40 commits.
node review-workflow/scripts/review-metrics.mjs --range HEAD~40..HEAD --exclude '*.md'

# Release hygiene, including PR shape.
node review-workflow/scripts/review-metrics.mjs --pull-requests --json > /tmp/prs.json
```

### Exit codes

`0` report produced · `2` usage error · `3` git failure · `4` read-only self-check
failed · `5` `gh` failed.

---

## review-round.mjs

### Lifecycle

```
start ──► next ──► (reviewer) ──► ingest ──► close findings ──┬─► next (diff-only) ──► ingest [] ──► converged
                                                             └─► cap reached ──► needs-redesign
```

One ledger per change: `review-workflow/ledger/<change>.json`. The ledger is the
authority on rounds, findings, and state. Nothing else remembers the loop.

### Commands

| Command                                                    | Purpose                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `start --change <id>`                                      | Create the ledger, resolve the base, pick a tier from the changed paths      |
| `next --change <id>`                                       | Print the round payload: scope, diff, rules, contract path, previous classes |
| `ingest --change <id> --findings <file\|->`                | Validate, dedupe, and record the round's findings                            |
| `close --change <id> --id <finding> --status <s> [--note]` | Resolve one finding                                                          |
| `status --change <id>`                                     | Rounds, findings, open items, state                                          |
| `stats`                                                    | Aggregate across every ledger                                                |
| `abandon --change <id> --reason <text>`                    | Stop a change without converging                                             |

| Option                | Meaning                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `--base <rev>`        | Review base; defaults to the merge base with `origin/dev`, then `dev`, then `HEAD^` |
| `--head <rev>`        | Reviewed revision, default `HEAD`                                                   |
| `--intent <text>`     | What the change is supposed to do; the reviewer checks the diff against it          |
| `--tier <tier>`       | Override the auto tier: `routine`, `standard`, `high`                               |
| `--ledger-dir <path>` | Ledger location, default `<repo>/review-workflow/ledger`                            |
| `--config <path>`     | Config location, default `<repo>/review-workflow/config.json`                       |

### Rules the script enforces

| Rule                                      | Behaviour when violated                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Round cap per tier                        | Refuses the round, sets `needs-redesign`, tells the author to reconsider the approach |
| All findings closed before the next round | Refuses with the open finding ids                                                     |
| One round in flight at a time             | Refuses a second `next` before `ingest`                                               |
| Findings need file, line, class, severity | Rejects the whole findings file                                                       |
| Findings must be inside the round's diff  | Rejects unless `preExisting: true`                                                    |
| No repeats                                | Suppresses by `file:line:class`; writes a reason                                      |
| Rejections need a reason                  | Refuses `rejected` or `pre-existing` without `--note`                                 |

### Worked example

```bash
CHANGE=fix-link-hover
node review-workflow/scripts/review-round.mjs start --change $CHANGE --intent "underline only the hovered link"

# Hand the payload to a reviewer subagent.
node review-workflow/scripts/review-round.mjs next --change $CHANGE --json > /tmp/$CHANGE-round1.json

# The reviewer writes /tmp/$CHANGE-findings.json, then:
node review-workflow/scripts/review-round.mjs ingest --change $CHANGE --findings /tmp/$CHANGE-findings.json

node review-workflow/scripts/review-round.mjs close --change $CHANGE --id F1-1 --status fixed
node review-workflow/scripts/review-round.mjs next --change $CHANGE --json > /tmp/$CHANGE-round2.json
echo '[]' | node review-workflow/scripts/review-round.mjs ingest --change $CHANGE --findings -
node review-workflow/scripts/review-round.mjs status --change $CHANGE
```

### Finding JSON

```json
[
    {
        "severity": "important",
        "class": "missing-guard",
        "file": "packages/pi-dock/src/dock.ts",
        "line": 88,
        "summary": "Two instances: the resize and the restore paths both read the stale width.",
        "preExisting": false
    }
]
```

### Exit codes

`0` done · `2` usage error · `3` git failure · `4` rule refusal (cap, open findings,
invalid finding) · `5` ledger state does not allow the command.

---

## review-cases.mjs

| Command       | Purpose                                                |
| ------------- | ------------------------------------------------------ |
| `list`        | Id, status, class, title                               |
| `check`       | Validate every case file; non-zero when any is invalid |
| `show <id>`   | Full case JSON                                         |
| `prompt <id>` | Replay payload for a reviewer session                  |

```bash
node review-workflow/scripts/review-cases.mjs check
node review-workflow/scripts/review-cases.mjs prompt case-collapsed-group-live-output > /tmp/replay.json
```

Exit codes: `0` ok · `2` usage · `4` invalid or unknown case.

---

## Troubleshooting

| Symptom                       | Cause                                           | Fix                                                                                               |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `round cap reached`           | The loop is not converging                      | Narrow or split the change, start a new change id                                                 |
| `X open finding(s)`           | Findings left open                              | `close` each one; rejections need a reason                                                        |
| `is not part of this round`   | The reviewer named a file outside the diff      | Mark `preExisting: true`, or drop the finding                                                     |
| `read-only self-check failed` | Git metadata changed during the run             | Check for a concurrent git process; rerun with `--self-check warn` only if the change is expected |
| `no ledger for change`        | Wrong `--change`, or a different `--ledger-dir` | `status` needs the same directory the ledger was written to                                       |
| Metrics are all zeros         | Empty range, or a shallow clone                 | Widen `--range`; clones also lose unreachable commits                                             |
