# Review workflow

Tooling for measuring and steering how changes get reviewed in this repository.

The workflow exists to hold one invariant: **less human time per change, without more
defects escaping**. It is built from measurements of this repository rather than copied
from a larger team's process: a single author, no review rounds on 22 pull requests, and
most rewrites happening within an hour of the code landing.

## Layout

```
review-workflow/
├── README.md                 this index
├── REVIEW.md                 what failure means here, severity, nits, ignored paths, classes
├── config.json               tiers by path: round caps and independent reviews
├── reviewer/
│   └── CONTRACT.md           the reviewer's role, rules, and output schema
├── scripts/
│   ├── review-metrics.mjs    read-only metrics: deletion age, rework, rewrites, survival
│   ├── review-round.mjs      ledger state machine: rounds, findings, caps, dedupe
│   └── review-cases.mjs      replayable regression cases for the workflow itself
├── ledger/                   one JSON per change; the only state the loop has
├── cases/                    defects the workflow missed, with the diff that contained them
└── docs/
    ├── usage.md              every option, exit code, and worked example
    ├── process.md            layers, tiers, the loop, landing and recovery
    ├── self-improvement.md   how an agent changes the workflow using data
    └── iteration-log.md      one entry per workflow change, with its evidence
```

## The loop

```
verify ─► start ─► next ─► review ─► ingest ─► close ─┬─► next (diff only) ─► ingest [] ─► converged
                                                      └─► cap reached ─► redesign the change
```

1. Run `npm run check` and record the output. Unverified work is not ready for review.
2. `review-round.mjs start --change <id> --intent "<what this does>"` — the tier comes
   from the changed paths.
3. `review-round.mjs next --change <id> --json` — a reviewer session with fresh context
   reads the payload, `REVIEW.md`, and `reviewer/CONTRACT.md`.
4. `review-round.mjs ingest --change <id> --findings <file>` — findings are validated,
   deduplicated, and assigned ids.
5. `close` every finding as `fixed`, `rejected: <reason>`, or `pre-existing`.
6. Round two reviews only the new hunks. A clean round sets the change to `converged`.
7. Land, run `npm run check` on the merged result, push.

The script — not a prompt — enforces the round cap, closure before the next round, and
duplicate suppression. A cap that a prompt can talk its way out of is not a cap.

## Quick start

```bash
# Where does rework actually go?
node review-workflow/scripts/review-metrics.mjs

# Drive one change through the loop.
node review-workflow/scripts/review-round.mjs start --change fix-link-hover --intent "underline only the hovered link"
node review-workflow/scripts/review-round.mjs next --change fix-link-hover --json

# Check the regression set.
node review-workflow/scripts/review-cases.mjs check
```

Agents pass `--json`. Baselines live outside the repository, for example
`/tmp/review-metrics/<date>.json`.

## What is measured

| Signal                                  | Meaning                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `deletions.youngShare`                  | Share of removed lines written under a day earlier: rewrites, not maintenance |
| `selfRework.medianLatencyHours`         | How fast a fix follows the change it repairs, and on which branch             |
| `rewrites.rewrittenBeforeLanded`        | Commits amended or reworded before landing: the local form of a revert        |
| `survival.mean`                         | Share of added lines still present at the analyzed revision                   |
| `stats.medianRounds` / `rejectionShare` | Review convergence and reviewer noise, from the ledgers                       |
| `cases/*.json`                          | Defects the workflow missed, replayable after every change                    |

`review-metrics` reports `caveats` with every run: young history, capped ranges, shallow
clones, and unattributed lines all change what the numbers mean. Read them before
concluding anything.

## Boundaries

- `review-metrics.mjs` and `review-cases.mjs` never write to the repository. The metrics
  script proves it: git runs behind a read-only allowlist with optional locks disabled,
  and git metadata is fingerprinted before and after each run.
- `review-round.mjs` writes only ledger JSON. Its git access is read-only; it cannot
  commit, stage, or reset.
- The reviewer reads and runs read-only checks. It does not edit files.

## Read next

- `docs/process.md` — the layers, tiers, cap behaviour, promotion and recovery path.
- `docs/usage.md` — every option, exit code, and a worked example per script.
- `docs/self-improvement.md` — the loop for changing this workflow with evidence.
- `REVIEW.md` — what a reviewer must treat as failure here.
- `reviewer/CONTRACT.md` — the exact contract a reviewer session follows.

## Adoption order

The order matters. Verification evidence (layer 0) pays off first in a repository like
this one, because most rework is self-repair within the hour. The reviewer adds the
second layer on top of a change that already works:

1. `REVIEW.md` + the evidence habit.
2. `npm run check` as a hard gate.
3. Ledger and rounds for every change.
4. Reviewer sessions, one per round, two for high tier.
5. Cases and the metrics comparison at each workflow change.
