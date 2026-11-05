# Iteration log

One entry per change to the review workflow. Format and rules are in
`review-workflow/docs/self-improvement.md`.

## 2026-10-28 — Establish the workflow and its baseline

- Signal: `review-metrics` on the first thirteen days of history — 74% of removed lines
  were under a day old, 22 commits were rewritten before landing, 32 fix-after-change
  events with a median latency of 1.4 hours, and zero review comments on 22 pull
  requests.
- Change: add the measurement layer, `REVIEW.md`, the reviewer contract, the tier config,
  the ledger state machine, the case set, and the process documents.
- Replay: one case, `case-collapsed-group-live-output`, recorded from a real same-file fix
  pair. It is `open`: no rule catches it yet.
- Metrics: baseline only. The next cycle compares against
  `/tmp/metrics-before.json` from the first run after this lands.
- Decision: keep. The first real test is whether `selfRework.medianLatencyHours` rises
  and `deletions.youngShare` falls once verification evidence is required.

## 2026-10-29 — Revert the in-progress rendering rule

- Signal: `case-collapsed-group-live-output` is the only open case and the workflow's
  leading indicator.
- Change: one `REVIEW.md` failure mode requiring reviewers to state what a collapsed or
  grouped row renders while a tool runs.
- Replay: a fresh-context reviewer stated the mid-call behavior and still passed it,
  reporting only a `version-drift` nit that the real commit's changelog entry disproves;
  it produced no `ui-instability` finding.
- Metrics: the rerun after reverting is byte-identical to the baseline; the run with the
  change in the tree exited 4 on the strict self-check and wrote no report, so it proved
  nothing.
- Decision: revert. The case first needs a diff that matches the reviewed change and an
  expected finding the contract's diff-only scope allows; the rule must require a
  finding, not a description.

## 2026-10-29 — Collapsed rows render settled output only

- Signal: `case-collapsed-group-live-output` stayed open after two rule versions failed
  their replays: the reviewer either described the mid-call row and accepted it, or read
  the symptom as blank rows.
- Change: one `REVIEW.md` failure mode — collapsed cards, group preview rows, and pinned
  footers render settled output only — plus a scope exception that keeps an incomplete
  fix in scope instead of `preExisting`.
- Replay: a fresh-context reviewer produced `important` / `ui-instability` at
  `transcript.ts:398`, citing the rule and the diff's own 3→4 row assertion; the case
  moved to `fixed`.
- Metrics: byte-identical to the baseline; a docs-only rule change moves review behaviour,
  not repository history.
- Decision: keep.
