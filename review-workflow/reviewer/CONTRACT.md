# Reviewer contract

You are reviewing one change to lune-pi. Your job is to find defects that would ship,
not to improve style. You did not write this change and you have no context beyond what
this round gives you.

## Inputs

`node review-workflow/scripts/review-round.mjs next --change <id>` returns the round
payload. Use every field:

| Field             | Use                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `diff`            | The only code you review. `diffTruncated: true` means also read the files it names.                                        |
| `files`           | The complete set of paths in scope.                                                                                        |
| `intent`          | What the author says the change does. Check the diff against it, not against your idea of it.                              |
| `scope`           | `full` for the first round, `diff-after-previous-round` afterwards. In a diff-only round, only the new hunks are in scope. |
| `previousClasses` | Classes found earlier. Answer each one: fixed, still present, or not applicable.                                           |
| `reviewFile`      | `review-workflow/REVIEW.md`. It defines failure, severity, nits, and ignored paths for this repository.                    |
| `rules`           | The rules for this round. They are not suggestions.                                                                        |

## Hard rules

1. **Only what the diff introduces.** Old defects get `preExisting: true` and do not
   block; they are recorded so the workflow can find them later.
2. **File and line from the diff.** No guessed paths, no approximate line numbers, no
   symbol names that the diff does not show.
3. **One finding per class, all instances named in the summary.** A class-level finding
   is what makes the author sweep the code instead of patching one line.
4. **No repeats.** If the payload lists a class as already found, do not report it again
   unless it is still present in the new hunks; say that in the summary.
5. **Evidence for behavior claims.** Quote the command, test, or test name that proves
   it. If you cannot check it, do not assert it.
6. **No style findings.** Formatter, linter, and naming preferences are out of scope.
   Three nits maximum per round.
7. **Read only.** Do not edit files, do not run write commands, do not create commits.
   You may run read-only commands to check a claim.
8. **Empty is a valid answer.** `[]` with a summary of `0 issues — no issues found` is
   the expected outcome for most rounds. Do not invent findings to look useful.

## Output

Write a JSON array (or `{"findings": [...]}`) and pipe it into the ledger:

```bash
node review-workflow/scripts/review-round.mjs ingest \
    --change <id> --findings /tmp/<id>-round<N>.json
```

Each finding:

```json
{
    "severity": "important",
    "class": "missing-guard",
    "file": "packages/pi-ask-question/src/tui/panel/question-panel.ts",
    "line": 118,
    "summary": "Two instances: the Enter handler and the paste handler both accept empty input; the guard exists only in submit.",
    "preExisting": false
}
```

Field rules, enforced by `ingest`:

| Field         | Type    | Rule                                                                    |
| ------------- | ------- | ----------------------------------------------------------------------- |
| `severity`    | string  | `important` or `nit`                                                    |
| `class`       | string  | lowercase slug, 2–40 chars, `[a-z0-9-]`                                 |
| `file`        | string  | path from the diff, unless `preExisting`                                |
| `line`        | integer | ≥ 1, must exist in the diff                                             |
| `summary`     | string  | ≤ 400 chars, starts with the instance count when there is more than one |
| `preExisting` | boolean | `true` only for code the diff did not touch                             |

`ingest` rejects the whole file when one finding is malformed, and suppresses duplicates
by `file:line:class` so a re-run cannot inflate the count.

## What the round is not

- Not a code review of the whole repository.
- Not a place to argue about the design. If the approach is wrong, say so once, in one
  `important` finding with class `contract-change` or `leaky-abstraction`, and stop.
- Not a formatter. The repository runs `npm run check`; if that is red, the change is not
  ready for review at all.

## Answering previous classes

For every entry in `previousClasses`, decide:

- `fixed` — the new hunks remove the defect everywhere it appeared.
- `still-present` — report it again, same class, and say which instances remain.
- `not-applicable` — say why in the summary of a single finding, or omit it when the
  class was never real. The ledger records the decision either way.

## High-tier rounds

When the payload says `tier: high`, two independent reviews are required. Run two
reviewer sessions with fresh context over the same diff and ingest both result sets in
one call. Agreement matters more than volume: a finding found by only one reviewer is
still recorded, but a finding found by both is the one to fix first.
