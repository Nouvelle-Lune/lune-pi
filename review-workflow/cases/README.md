# Cases

A case is one defect the workflow missed, frozen with the diff that contained it and
the finding a good reviewer should have produced. Cases are the regression set for the
review workflow itself: without them, every change to `REVIEW.md`, the reviewer
contract, or the tier config is an opinion.

## When to add one

Add a case whenever one of these happens:

- a reviewer round returns `0 issues` and the defect is found later by you, by a user,
  or by a failing check;
- `review-metrics` shows a same-day rewrite whose cause a reviewer should have caught
  (a `selfRework` pair with a median latency under a few hours);
- a `rejected` finding turns out to have been real;
- an incident, a revert, or a re-published version traces back to a missed defect.

Do not add a case for a defect the reviewer did catch. The set measures misses only.

## Format

Start from `_template.json`. Files starting with `_` are ignored by the tooling.

| Field      | Meaning                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | `case-<slug>`, unique                                                                                                            |
| `status`   | `open` (not yet prevented), `fixed` (rule or check added), `regressed` (the miss happened again), `retired` (no longer relevant) |
| `layer`    | Which layer should have caught it: `verification`, `review`, `ci`, `rules`                                                       |
| `class`    | Finding class, reused from `REVIEW.md` whenever possible                                                                         |
| `signal`   | The metric or event that surfaced the miss                                                                                       |
| `missed`   | Where the defect lived and what it was                                                                                           |
| `expected` | The finding the reviewer should have produced                                                                                    |
| `diff`     | The minimal diff that contains the defect, including hunk headers                                                                |
| `fix`      | Which artifact changed and what changed in it                                                                                    |

## Commands

```bash
node review-workflow/scripts/review-cases.mjs list
node review-workflow/scripts/review-cases.mjs check
node review-workflow/scripts/review-cases.mjs show case-<slug>
node review-workflow/scripts/review-cases.mjs prompt case-<slug>   # replay payload
```

Replay procedure and how to decide whether a workflow change is kept are in
`review-workflow/docs/self-improvement.md`.

## Status discipline

`fixed` means a rule, check, or contract clause now catches this case, and the replay
proves it. Marking a case `fixed` without a replay is how a regression set rots.
`regressed` is the important state: it means a rule that used to work no longer does.
