# ontology-replica agent notes

Read the code a claim depends on before acting on it. `engine.ts` is large, and a name
found by search is rarely the whole story: check the table definitions and every writer of
the state involved. Each fact below cites where to verify it.

## Sync model

- **Base and overlay.** Each object type has a `base` table (confirmed upstream rows) and
  an overlay of predicted overrides (`views`, built with `overlay(base, …)`). Readers see
  base plus overlay; `confirmed` reads see base only.
- **Outbox and prediction.** Each pending action is an `outbox` row (`PendingAction`).
  `replay` runs the action's `execute` against visible state, stages its writes, and
  records every row it read or wrote in `actionRows` and every query it read in
  `actionQueries` (subsets it read through `loadSubset`). Cache GC protects those rows
  and every row matching those queries, and a source-fed replica asks its source to
  deliver them (`requestedView`), so a replay always finds its inputs.
- **Rebase.** `rebase` clears every overlay and replays all pending actions in sequence
  order until the first `blocked` one. It runs after every base write (installs, watch
  changes, confirmations), so predictions are always recomputed over the current base.
- **Outbox lifecycle.** `queued` → `sending` (claimed, `applyAction` in flight) →
  receipt saved (`acknowledged` with `receipt.outcome === "committed"`) → `confirmReceipt`
  reads back the affected rows, then in one transaction writes them to base, deletes the
  outbox entry and rebases. A failed dispatch goes back to `queued` (with
  `failureOutcome: "unknown"` when it may have committed) or to `blocked`.
- **The double-apply hazard.** A prediction must never be replayed over a base that
  already contains its commit. That is possible while an action is `sending` or committed
  but unconfirmed, and after an unknown-outcome failure. Hence: installs are fenced while
  an action is sending or committed-unconfirmed (`installUnlessUnsettled`), serial and
  journal passes step aside then, and `applyWatchChanges` holds changes. Detached passes
  do not step aside: their fetches may start during a dispatch because the install is
  what the fence checks, under `gate`.
- **Coverage.** A `coverage` row records that a subset was loaded completely, when
  (`updatedAt`, taken when the fetch returned), and whether it is `invalidated` or due
  (`revalidate`). In memory, each type has a coverage generation and each demand a
  revision. A fetch that sees either change while in flight installs its rows but records
  its coverage as invalidated.
- **Fetch stamps.** Loads outside the gate install in any order, so each fetch takes a
  sequence number when it starts and each base row remembers the newest fetch or watch
  change that wrote it (`rowFetches`). An install skips rows that a later fetch wrote.
  Receipt read-backs are fetches too.

## Locks

- **`gate`** (`Semaphore(1)`) serializes base writes: installs, watch changes, outbox
  recovery and drain, and every pass under `scheduling: "serial"`.
- **The outbox holds `gate` while it dispatches and confirms an action** (network
  included), so no install ever sees this session's action `sending`. Without detached
  loads the worker holds it for a whole `drainOutbox`, every queued action in a row.
  With detached loads, `drainInTurns` takes it one action at a time, and before each
  turn it waits for the installs already queued (`withInstallGate` /
  `afterWaitingInstalls`). The background worker and every explicit `syncOnce` can
  drain at once, so `drainTurn` keeps all but one drainer off `gate`; otherwise
  drainers queued earlier take every release and installs wait for each of them.
- **Readers of a detached load return once it settles** (installed rows, reused
  another load, or stepped aside). Only a load cancelled before any of these hands its
  readers to its replacement. Following replacements unconditionally lets a reader
  chase an endless series of loads that polls keep superseding.
- **Receipts drive the double-apply argument.** `ActionReceipt.affected` is complete
  unless `affectedComplete` is false (`ontology-backend/src/index.ts`). The read-back
  fetches start after the commit, so their fetch stamps win over any snapshot that
  started earlier. A fixture whose receipt omits rows it changed breaks that argument
  and tests nothing real.
- **`passGate`** serializes pass planning for detached loads. It is never held while a
  load fetches.
- **`loadPermits`** caps concurrent fetches (`demand.maxConcurrentLoads`).
- **Effect's `Semaphore` is not FIFO.** `release` wakes waiters on a scheduled task, so a
  fiber that releases and immediately takes again keeps the permit. Releasing a lock in a
  loop does not by itself let a waiter in.

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
- Interference sources the oracle models today: source edits, clock jumps, poll ticks,
  held or slow fetches (latency in clock time, or resumed one at a time), held or slow
  dispatches, lost read-backs, `revalidate()`, `invalidate()`, explicit and background
  passes, a steady stream of edits, consumers leaving and returning, cache collection,
  retryable and terminal fetch failures, and restarts on the same storage with the
  device clock corrected forwards or backwards. Deadlines for progress scale with every wait a load can legitimately incur
  (fetch latency and an action's turn), so they flag starvation rather than slowness.
- The oracle judges freshness by the source's clock; the replica runs on a device
  clock that a restart may find corrected. Coverage ages are wall-clock differences, so
  the replica detects a backward correction (`currentTime`) and invalidates every
  age-based confirmation from before it.
- Check that an oracle can fail before trusting a pass: a mutation that survives may
  mean the generator never reaches the case (add a focused generator or an example) or
  that the oracle accepts too much (for example, a state that held for zero time).
- To debug a failing property, print a per-step trace (demand `installed`/`revision`,
  load registry phases, outbox states) only for runs that fail, and reproduce the shrunk
  scenario alone. Aggregate logs mix runs with different settings and mislead.
- Add a new interference source as a scenario operation or dimension, then mutation-check
  the invariant it exercises: temporarily break the guarded code and confirm a property
  fails. Keep a targeted example for any case the generators reach only rarely.
