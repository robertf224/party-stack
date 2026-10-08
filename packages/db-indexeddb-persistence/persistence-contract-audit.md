# Persistence contract audit — 2026-10-07

## Upstream coverage

The portable tests are adapted from TanStack/db commit
`2c98b4992c412820f8476325ee6941db5ca9ac0f`. The installed SQLite control remains
core 0.4.5 / Node persistence 0.2.30, matching this branch's dependencies.
[Source, adaptations, exclusions, and MIT notice](src/contracts/NOTICE.md) are
checked in with the tests; runs do not fetch upstream or depend on a temporary checkout.

Thirteen cases run through the same harness on fake IndexedDB, real upstream SQLite,
and native Chromium IndexedDB: stream-position idempotency, rollback, atomic row
and collection metadata, truncate, replay thresholds, metadata-only replay, cursor
boundary ties, ascending/descending/custom-equal collation, numeric/string key
identity, boolean/operator fallback, and typed bigint/Date predicates. Existing adapter tests additionally cover Temporal/bigint storage,
query planning, atomic snapshots, schemas, indexes, bounded history, and migrations.
This is the portable public adapter contract, not a claim that all upstream SQL,
driver, scheduler, source-sync, or platform tests have been transplanted.

## Browser witnesses and fixes

`packages/web-runtime/e2e` opens two real Chromium pages with separate connections.
It uses native IndexedDB, Web Locks, and BroadcastChannel. A wrapper can drop only
application event notifications while leaving election and RPC messages intact.
The tests cover:

- Insert/update/delete propagation to live queries and follower writes.
- Recovery after a missed middle commit when a later sequence arrives.
- A missed final update with no later write, recovered on page resume.
- A missed first insert and final deletion, recovered on return to visibility.
- Leader replacement after a tab closes.
- Twenty concurrent writes split between tabs, then durable collection reopening.
- Actual Chromium page freeze/resume through the DevTools lifecycle command.

The missed-final-update test failed before adding browser resume checks. The shim
now compares durable positions on page show, visible focus, and visible visibility
changes. It locally requests TanStack's active-subset reload when behind. The
first resume is conservative because the subscription does not know the initial
hydration position; unchanged positions thereafter skip row reads. No database
reset, cross-tab reset broadcast, or periodic polling is introduced.

The concurrent-write test found a second issue: all twenty rows were durable at
sequence/version twenty, but the reader's query showed only its own ten rows.
Core `persistCollectionMutationsUnsafe` advances the observed position from a local
mutation response. Queued commit messages then pass through
`processCommittedTxUnsafe`, which ignores sequences already observed, even when
their rows have not been applied. The same test reproduces with TanStack's
`BroadcastCollectionCoordinator` over the identical storage factory, isolating it
from Party Stack's transport. The explicitly expected-failure upstream reference
should be revisited on future dependency upgrades; it is not counted as a passing
upstream correctness law.

Our shim detects commits overlapping local mutation acknowledgements (and
concurrent local consumers of the same collection ID), then requests a local
active-subset reload after the pending mutation burst. This keeps acknowledgement
positions accurate and leaves uncontended writes incremental. Overlapping edits
can incur a reload rather than pure delta replay. Pending envelopes and short
idle-turn timers are transient and removed on completion or last unsubscribe;
unit tests cover cleanup and checks finishing after unsubscribe.

Two adapter bugs also surfaced: synchronous IDB cloning failure could leave an
already-started row request rejection unhandled, and retrying the same term/sequence
with a different transaction ID was not idempotent. Row writes now aggregate
synchronous failures as promises and observe transaction aborts immediately.
Physical database version 3 adds an indexed `(collectionId, term, seq)` lookup,
without scanning retained history on each write. Version-1/2 data is retained;
legacy journal entries continue tx-ID deduplication, and the current stream
position fences retries of the latest commit. Legacy records do not contain enough
information to reconstruct every older term/sequence identity.

## Performance

No persistence-specific benchmark suite was found in the pinned upstream checkout.
Its `scripts/bench/incremental-update.ts` measures in-memory collections, joins,
and materialization. The added workloads are analogous small updates and
pagination against real IndexedDB, not a copy or SQLite speed comparison.

All queries use a fixed 10,000-row dataset. The indexed/fallback pagination paths
are checked for identical ten-row results before timing. Existing equality,
range, AND/OR, IN, LIKE, and fallback benchmarks remain. The incremental-write
workload edits one row while maintaining four persisted indexes and bounded history.

Native headless Chromium / Playwright 1.61.1, local macOS measurements:

| Workload | Observed mean |
| --- | ---: |
| Ordered first ten rows (initial stable run) | 0.87 ms |
| Same page through unindexed fallback | 70.89 ms |
| Empty indexed AND before short circuit | 12.08 ms |
| Empty indexed AND after short circuit | 5.27 ms |
| One-row edit with four indexes | 25.27 ms (high variance) |

The empty-AND change avoids reading the broad 1,000-entry branch after the selective
branch has already returned no candidates. A unit test verifies exactly one lookup
branch is read. The observed reduction is about 2.3x. Ordered pagination's roughly
81x advantage is a comparison of two existing read paths, not a newly achieved
speedup against another backend.

A later full benchmark run while repo checks were also using the machine measured
1.12 ms indexed pagination versus 77.75 ms fallback, and 6.01 ms empty AND. The
write measurement had approximately 26% relative error; it does not establish a
write performance improvement. Timing varies with machine load and browser/GC
scheduling. Operation-count regressions, rather than elapsed-time thresholds,
gate correctness tests. Final benchmark options use a one-second sampling window,
at least five iterations, and a 100-ms/five-iteration warmup.

## Commands and limits

```sh
pnpm --filter @party-stack/db-indexeddb-persistence test
pnpm --filter @party-stack/db-indexeddb-persistence test:browser
pnpm --filter @party-stack/web-runtime test:browser
pnpm --filter @party-stack/db-indexeddb-persistence bench:browser
```

Install Chromium with the web-runtime package's Playwright CLI first. Both native
browser test suites run in CI after the full build/lint/test step. Benchmarks remain
manual, without unstable timing gates. Chromium lifecycle tests do not certify
Safari, Firefox, BFCache eviction, or mobile OS process kills. Standalone IndexedDB
persistence requires a supplied cross-tab coordinator for notifications. Manual
storage edits remain unsupported; they bypass notification, index, and replay
maintenance. Temporal query literals still have upstream remote-subset wire
restrictions, separate from row serialization.
