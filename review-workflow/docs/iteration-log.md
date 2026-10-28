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
