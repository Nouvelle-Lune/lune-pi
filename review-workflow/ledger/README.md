# Ledger

One JSON file per change, written by `scripts/review-round.mjs`. It is the only state the
review loop has: rounds, scope, findings, resolutions, and the state machine.

- Name: `<change-id>.json`, lowercase words with hyphens.
- Committed: yes. The ledgers are the corpus the self-improvement loop reads; a fresh
  clone without them cannot compute rounds, noise, or escapes.
- Never edited by hand mid-change. `close` and `ingest` are the only writers; a manual
  edit breaks the invariants the script enforces.
- Abandoned changes keep their ledger. It is evidence about what did not converge.

Inspect without changing anything:

```bash
node review-workflow/scripts/review-round.mjs status --change <id>
node review-workflow/scripts/review-round.mjs stats
```
