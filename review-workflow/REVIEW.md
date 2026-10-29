# Review rules for this repository

This file tells a reviewer what "wrong" means for lune-pi. A review that ignores it is
not a review of this repository; treat a violation of these rules as a finding about
the reviewer itself.

## What failure looks like here

- **A document that lies.** A README, `AGENTS.md`, package README, or `CHANGELOG.md` that
  claims behavior the code does not have, or that stops being true after this change.
- **A setting that misroutes.** In `packages/pi-lune-extensions-core/src/settings/**`, a
  value read from the wrong key, a migration that drops a field, or a default that
  changes without saying so in the changelog. Settings belong to users; losing one is
  worse than a visible bug.
- **Package drift.** A version, `exports`, `files`, or `package.json` entry that no longer
  matches the source, or a changelog entry that does not describe the change.
- **A check that cannot fail.** A test or CI step that passes without exercising the
  behavior, a matrix entry that silently skips a supported Node version, a formatter
  script altered to make output fit.
- **An agent instruction that no longer holds.** `AGENTS.md`, package guides, or this
  workflow's own documents describing a process the repository no longer follows.
- **A silent fallback.** Code that keeps going with a default when the real input is
  missing, unless the fallback is the documented contract.
- **Live output in a collapsed row.** A collapsed card, group preview row, or pinned
  footer must render only settled output. A partial result that adds rows while a tool
  runs and removes them when it settles moves the bottom-pinned transcript; filtering
  blank output is not a fix.

## Severity

| Severity    | Meaning                                                                                      | Effect                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `important` | Would ship a defect, lose user state, publish a broken package, or make documentation false. | Blocks convergence; must be fixed or rejected with a reason.               |
| `nit`       | Improves the change without preventing it.                                                   | At most three per round; a fourth must be folded into one summary finding. |

Anything a formatter, linter, or type checker already enforces is not a finding.

## Scope

Report only what this diff introduces. When the same defect already exists outside the
diff, record it with `preExisting: true`, keep it out of the blocking count, and say so
in the summary. Reviewers that re-litigate old code stall the loop; the metrics script
exists to find that code separately.

An incomplete fix is the one exception. When a change touches a row that moves while a
tool runs, the rows that still appear are in scope and are not `preExisting`: the change
is the place where the movement should have stopped.

## Evidence

- Every finding names a file and a line that appears in the reviewed diff.
- Any claim about behavior quotes the command that was run and its result, or the test
  that covers it. A finding that cannot be checked is not a finding.
- Never guess a path, a line, or a symbol name. If the diff does not show it, leave it
  out.

## Nit discipline

Three nits maximum per round. If a round would exceed that, keep the three that change
behavior most and merge the rest into one summary finding that names the pattern.

## Ignored paths

`dist/`, `coverage/`, `node_modules/`, `package-lock.json`, `docs/previews/capture.json`,
and generated images are reviewable only for drift (for example a lockfile that does not
match a manifest change), never for style.

## Finding classes

Use a short lowercase slug. Reuse an existing class before inventing one:

| Class               | Used for                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `missing-guard`     | A branch, check, or validation that should exist and does not.                                                        |
| `wrong-source`      | Reading state, config, or a model from the wrong place.                                                               |
| `stale-doc`         | Documentation that this change makes false.                                                                           |
| `version-drift`     | Version, manifest, changelog, or export mismatch.                                                                     |
| `silent-fallback`   | Swallowing a failure or defaulting without documenting it.                                                            |
| `test-noise`        | A test that passes without asserting the behavior.                                                                    |
| `contract-change`   | A public API or package behavior change that is not announced.                                                        |
| `leaky-abstraction` | A feature package reaching into another package's internals.                                                          |
| `unhandled-error`   | An error path that crashes, hangs, or loses context.                                                                  |
| `dead-code`         | Code that this change leaves unreachable.                                                                             |
| `ui-instability`    | A render path that changes layout while the user is looking at it: rows growing and shrinking, cursor jumps, flicker. |

Classes are how the workflow turns repetition into leverage: a class that recurs becomes
a rule here, a lint rule, or a check, instead of another review round.

## Output contract

Return a JSON array of findings. An empty array is a valid, expected answer and means
"no issues". Every response starts with a summary whose first token is the count, for
example `2 issues` or `0 issues — no issues found`. See
`review-workflow/reviewer/CONTRACT.md` for the exact shape.

## Tiers

Tiers come from the changed paths (`review-workflow/config.json`), never from who wrote
the change.

| Tier     | Paths                                                                            | Rounds | Independent reviews |
| -------- | -------------------------------------------------------------------------------- | ------ | ------------------- |
| routine  | Markdown, tests, changelogs                                                      | 2      | 1                   |
| standard | Ordinary package source                                                          | 2      | 1                   |
| high     | Manifests, CI, settings storage, subagent model routing and tools, this workflow | 3      | 2                   |

A high-tier change needs two independent reviews of the same diff before the findings
are ingested together. Two reviews by the same agent in the same context count as one.

## How this file changes

Add a line here only after a defect escaped the loop: a case in `review-workflow/cases/`
records what was missed, and this file gains the rule that would have caught it. Rules
that never catch anything are noise; the self-improvement process removes them.
