# Self-improvement

The workflow is data, not doctrine. This document is the loop an agent follows to change
the workflow itself: which signal to look at, which artifact to edit, how to prove the
edit helped, and how to record the decision.

The workflow improving itself is not exempt from the workflow. `review-workflow/scripts/**`
and `review-workflow/config.json` are `high` tier: they are reviewed with two independent
reviews and two rounds. A change to the reviewer is itself reviewed.

## The rule

**One artifact per cycle, one reason per change, one replay before keeping it.**

A cycle changes exactly one of: `REVIEW.md`, the reviewer contract, the tier config, a
script, or a doc. A change without a case or a metric behind it is noise, and noise is
what makes reviewers stop being read.

## Signals

| Signal                                                | Source                     | What it suggests                                                        |
| ----------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `deletions.youngShare` rises                          | `review-metrics.mjs`       | Verification is weak; changes land before they are checked              |
| `deletions.buckets.lt1h` rises                        | same                       | The same defect is being rewritten minutes after it lands               |
| `selfRework.medianLatencyHours` drops                 | same                       | The author is repairing in-session; the reviewer is not the lever       |
| `selfRework.byEarlierType` shifts to `feat`           | same                       | New feature work is under-verified                                      |
| `rewrites.rewrittenBeforeLanded` rises                | same                       | Commits are rewritten instead of reviewed; the ledger is not being used |
| `survival.worst` has a high-line commit under 70%     | same                       | A large change was superseded; check whether review saw it              |
| `stats.medianRounds` rises                            | `review-round.mjs stats`   | Either changes got riskier or reviewer noise grew                       |
| `stats.rejectionShare` rises                          | same                       | Reviewer noise; tighten the contract or the rules                       |
| `stats.findingsPerRound` falls to zero across changes | same                       | The reviewer is rubber-stamping; check the contract against cases       |
| A case stays `open`                                   | `review-cases.mjs list`    | A known miss is still unprevented                                       |
| A case becomes `regressed`                            | same                       | A rule that used to work was weakened or bypassed                       |
| An escaped defect nobody predicted                    | the author's own discovery | A new case, then a rule                                                 |

Signals are lagging by nature. Use cases as the leading indicator: a change that fixes a
case is good before the metrics move.

## Cadence

| Trigger                                           | Cycle                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| A defect escapes review                           | Case, then rule. Do this immediately, while the diff is at hand. |
| A review round produces noise (rejected findings) | Contract or rule, next time you review                           |
| A week of changes lands                           | Metrics comparison, then at most one workflow change             |
| Ten changes have gone through the ledger          | `stats` review: rounds, noise, findings per round                |
| A rule has not fired in twenty rounds             | Consider deleting it; dead rules cost review time                |

## The cycle

1. **Observe.** Pick one signal. Write down its current value, with the command that
   produced it.
2. **Diagnose.** Name the artifact most likely responsible, using the table below. Say
   what the artifact currently does that is wrong.
3. **Change one artifact.** Smallest edit that addresses the diagnosis.
4. **Replay.** Run every case through the changed workflow. The change must not make a
   previously caught case fail.
5. **Measure.** Re-run the metrics over the same range. Compare before and after.
6. **Decide.** Keep, revise, or revert. Write the decision in
   `review-workflow/docs/iteration-log.md` either way.
7. **Propagate.** If a class recurs, decide where it belongs: a `REVIEW.md` rule, a lint
   rule, a test, or a CI check. A rule that only a reviewer can enforce is the most
   expensive option; prefer the mechanical one.

## Diagnosis table

| Symptom                                     | First artifact to change              | Example                                                      |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| Reviewer misses the same class twice        | `REVIEW.md`                           | Add the failure mode to "What failure looks like here"       |
| Reviewer reports style or speculative risks | reviewer contract                     | Tighten "no style findings", restate the evidence rule       |
| Reviewer keeps re-reporting old code        | reviewer contract + `Reviewed scope`  | Reinforce `preExisting` and diff-only scope                  |
| Rounds never converge                       | tier config or the change itself      | Split the change; do not raise the cap                       |
| Findings are too vague to act on            | reviewer contract + ledger validation | Require a line and an instance count                         |
| Routine docs changes cost a full round      | tier config                           | Widen `routine` paths, not the cap                           |
| A high-risk path slipped through            | tier config                           | Add the path to `high` and name why                          |
| The ledger is not used at all               | process doc + `AGENTS.md` pointer     | Make the loop part of the definition of done                 |
| Metrics disagree with your intuition        | metrics script                        | Check `caveats` first; a young repository skews `youngShare` |
| A check can no longer fail                  | CI or test suite                      | Add a negative test; see `cases/` for the pattern            |

## Changing each artifact safely

### `REVIEW.md`

- Add a line only for a defect that escaped. Name the case in the iteration log.
- Rules must be checkable by reading a diff. "Be careful with concurrency" is not a rule.
- Keep the file short. A reviewer that must read a treatise reviews nothing.

### Reviewer contract

- Every clause must change reviewer behaviour in a replay. If two clauses say the same
  thing, delete one.
- Never weaken the evidence requirement to make a finding easier to write.
- Never add a clause that asks the reviewer to be "more thorough"; add a check instead.

### Tier config

- Tiers are paths, not people. A tier change is justified by a path's blast radius.
- When adding a high-tier path, say what the blast radius is in the iteration log.
- Never raise a round cap. If a cap is reached, the change is too big or the approach is
  wrong.

### Scripts

- Scripts are the enforcement layer: caps, closure, dedupe, validation. Anything an agent
  can skip is not enforcement.
- Keep the read-only contract in `review-metrics.mjs` intact; a metrics script that
  writes cannot be trusted as a baseline.
- Bump `schemaVersion` when a report or ledger field changes meaning. Add fields rather
  than renaming them.
- Run the syntax and lint checks after any edit:
  `npx prettier --check review-workflow/ && npx eslint review-workflow/`.

### Docs

- `docs/process.md` describes the loop as implemented. If the implementation changes, the
  doc changes in the same commit.
- A doc that describes an aspirational loop is a defect: agents follow it and get stuck.

## Judging a change

A workflow change is kept when all of these hold:

1. **No case regressed.** Every case that passed still passes.
2. **The target case passes**, or the target metric moved in the intended direction.
3. **Routine changes did not become slower.** A `routine` change still converges in one
   round.
4. **The cap did not move.**
5. **The evidence requirement did not weaken.**

Metrics are lagging; a single week is not a verdict. Record the expected effect and check
it at the next cycle instead of re-running until the number looks good.

## Anti-patterns

- **Adding rules without cases.** Rules invented from imagination add review time and
  catch nothing.
- **Lowering rigour to make the loop converge.** Convergence by weakening the reviewer is
  the failure mode the whole workflow exists to prevent.
- **Prompt-only enforcement.** A cap or a dedupe rule that lives in a prompt will be
  ignored. Put it in `review-round.mjs`.
- **Trusting a metric without `caveats`.** A young repository, a truncated range, or a
  shallow clone changes the meaning of almost every number.
- **Changing several artifacts at once.** You will not know which one worked.
- **Recording nothing.** An unrecorded change repeats in six weeks.

## Agent procedure

```bash
# 1. Baseline.
node review-workflow/scripts/review-metrics.mjs --json > /tmp/metrics-before.json
node review-workflow/scripts/review-round.mjs stats --json > /tmp/ledger-before.json
node review-workflow/scripts/review-cases.mjs check

# 2. Make one change to one artifact (REVIEW.md, contract, config, or a script).

# 3. Replay the cases against the changed workflow.
for id in $(node review-workflow/scripts/review-cases.mjs list | awk '{print $1}'); do
    node review-workflow/scripts/review-cases.mjs prompt "$id" > "/tmp/replay-$id.json"
done

# 4. Measure again over the same range with the same options.
node review-workflow/scripts/review-metrics.mjs --json > /tmp/metrics-after.json

# 5. Compare.
node -e '
const a = require("/tmp/metrics-before.json");
const b = require("/tmp/metrics-after.json");
const pick = (r) => ({
    young: r.deletions.youngShare,
    rework: r.selfRework.events,
    survival: r.survival?.mean,
    rewrites: r.rewrites?.rewrittenBeforeLanded,
});
console.log("before", pick(a));
console.log("after ", pick(b));
'

# 6. Record the decision, keep or revert, then commit.
```

Replay judgement is manual: for each case, the reviewer must produce a finding whose
class matches `expected.class`. A case can only move to `fixed` when its replay produces
that finding and the finding would have blocked the change.

## The log

Every cycle appends one entry to `review-workflow/docs/iteration-log.md`:

```md
## 2026-11-02 — Require instance counts in summaries

- Signal: case-collapsed-group-live-output stayed open; summaries named one line only.
- Change: reviewer contract, summary must start with the instance count when > 1.
- Replay: case passes; 3 previously passing cases still pass.
- Metrics: no change expected in youngShare; ledger findings per round unchanged.
- Decision: keep.
```

An entry without a signal is a change without a reason. An entry without a replay is a
change without evidence.
