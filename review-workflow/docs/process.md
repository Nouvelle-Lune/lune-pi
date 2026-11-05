# The review process

The process exists to hold one invariant: **less human time per change, without more
defects escaping**. Every artifact here serves that invariant, and anything that only
looks like review — approvals, ceremony, "someone read it" — is left out.

Review is a chain, not a gate. Each layer catches different defects; none of them alone
is a checkpoint. The measured state of this repository (a single author, no review
rounds, most rewrites happening within a day) decides which layers carry weight.

## Layers and their artifacts

| Layer           | Artifact                                                       | What it does                                                  | When it runs                            |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| 0. Verification | Commands the author must run and show                          | Proves the change works before anyone reviews it              | Before `start`                          |
| 1. Rules        | `review-workflow/REVIEW.md`                                    | Defines failure, severity, nit caps, ignored paths, classes   | Loaded by every round                   |
| 2. Reviewer     | `review-workflow/reviewer/CONTRACT.md` + a fresh-context agent | Finds defects in the diff, class-level, with evidence         | Every round                             |
| 3. Tiers        | `review-workflow/config.json`                                  | Sets round cap and independent reviews from the changed paths | At `start`                              |
| 4. Checks       | `npm run check`                                                | Format, lint, types, tests, package contents                  | Before review, and on the merged result |
| 5. Convergence  | `scripts/review-round.mjs` + the ledger                        | Caps rounds, forces closure, suppresses repeats               | Every round                             |
| 6. Recovery     | Small changes, `git revert`, versioned releases                | Undo in minutes                                               | After landing                           |

Layer 4 is not optional and not part of review: a change with a red `npm run check` is
not ready to be reviewed. Layer 0 is the highest-leverage layer in this repository,
because most rework here is self-repair within the hour, not a defect a reviewer would
have caught.

## What evidence means

Before `start`, the author states what was run and what it returned:

```
command: npm run check
result:  format, lint, typecheck, 7 workspaces' tests, pack check — all pass
command: node review-workflow/scripts/review-metrics.mjs --range HEAD~1..HEAD
result: 0.9 young share, 1 fix-after-change event
```

Claims without a command and its result are treated as unverified. Screenshots qualify
for TUI changes; a sentence in the task description does not.

## The standard loop

```
verify ─► start ─► next ─► review ─► ingest ─► close ─┬─► next ─► ingest [] ─► done
                                                      └─► cap ─► redesign
```

1. **Verify.** Run the checks. Record the output.
2. **Start.** `review-round start --change <id> --intent "<what this does>"`. The base is
   the merge base with `dev`; the tier comes from the changed paths.
3. **Next.** `review-round next --change <id> --json` returns the payload: diff, scope,
   intent, previous classes, rules, and paths to `REVIEW.md` and the contract.
4. **Review.** One fresh-context agent per independent review. For `high` tier, two.
5. **Ingest.** `review-round ingest --change <id> --findings <file>`. Malformed findings
   are rejected; duplicates are suppressed with a reason.
6. **Close.** Every finding gets `fixed`, `rejected: <reason>`, or `pre-existing`. The
   script refuses the next round while anything is open.
7. **Re-review.** Round 2 onward inspects only the new hunks. A clean round sets the
   change to `converged`.
8. **Land.** Merge into `dev`, run `npm run check` on the merged result, push.

A round that returns `0 issues` is a success, not a wasted round. The ledger records it.

## Tiers

| Tier       | Paths                                                                            | Rounds | Independent reviews |
| ---------- | -------------------------------------------------------------------------------- | ------ | ------------------- |
| `routine`  | Markdown, tests, changelogs                                                      | 2      | 1                   |
| `standard` | Ordinary package source                                                          | 2      | 1                   |
| `high`     | Manifests, CI, settings storage, subagent model routing and tools, this workflow | 3      | 2                   |

Tiers are computed from the diff, never from who wrote it. Two independent reviews mean
two separate reviewer sessions with fresh context; the same agent reviewing twice in one
context is one review.

## When the cap is reached

The script refuses the round and sets `needs-redesign`. That is the whole point of the
cap: the loop stops instead of spiraling. At that moment:

- if the diff keeps growing, split the change;
- if the same class keeps returning, the approach is wrong, not the code;
- if findings are noise, fix the rule (`REVIEW.md`), not the cap;
- start a new change id for the new approach; the old ledger stays as evidence.

Do not raise the cap to get past it. A cap that moves is not a cap.

## Landing and recovery

- Changes stay small so `git revert` is cheap and a review is meaningful.
- `dev` is the integration branch. `main` is stable and receives `dev` through a
  promotion PR with a merge commit.
- A promotion is mechanical: run `npm run check` on the promoted revision, verify the
  changelog and versions, and do not review the whole promotion diff. A
  twenty-thousand-line promotion cannot be reviewed; it can only be checked.
- Releases are versioned and reversible: republish the previous version if a release
  misbehaves.

## What this workflow intentionally does not do

- No approval counts as a person's approval. A reviewer agent can never satisfy a
  human-approval slot, because there is no human-approval slot here.
- No mandatory PR for ordinary changes; the repository allows direct integration into
  `dev`, so review attaches to a change, not to a pull request.
- No line-by-line reading of every change. Reading is spent where the tier says the risk
  is.
- No whole-repository nightly review. The repository is small; the metrics script
  answers repository-wide questions better than another review would.

## Invariants

These must stay true through any change to the workflow:

1. Metrics are read-only and self-checked.
2. Round caps are enforced by the script, not by a prompt.
3. Findings need file, line, class, and severity; nothing is accepted on prose.
4. Every finding ends in `fixed`, `rejected` with a reason, or `pre-existing`.
5. Rules are added because a case exists, not because a reviewer imagined a risk.
6. The ledger is the only state; no agent memory is required to continue a change.
