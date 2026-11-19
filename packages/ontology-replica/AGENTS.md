# ontology-replica agent notes

## Scheduling and its tests

Backends without a change journal load outside the sync gate: concurrent fetches, per-row
fetch stamps, an install fence for unsettled actions. A private `scheduling: "serial"`
option keeps the old fully gated path as a reference.

`src/staleCoverage.oracle.test.ts` checks this against the source's own version history.
When you change loads, installs, coverage or the outbox, extend it rather than adding only
example tests:

- **Safety properties** (freshness bound, monotonic row versions, no action shown twice,
  convergence) run under both schedulings. Serial is the reference: a scenario that fails
  only under the default scheduling is a bug in the new path.
- **Progress properties** run with fetch latency in clock time, so polls, edits and
  `revalidate()` land mid-fetch, and require every read to finish within a deadline
  while that interference continues. Serial is excluded there: its queued passes each
  reload every invalidated demand in turn, which is slow by design.
- Each safety property needs a matching progress property. Holds released all at once,
  followed by a convergence check, cannot detect a load that restarts forever.
- Add a new interference source as a scenario operation or dimension, then mutation-check
  the invariant it exercises: temporarily break the guarded code and confirm a property
  fails. Keep a targeted example for any case the generators reach only rarely.
