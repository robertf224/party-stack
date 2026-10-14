# Upstream persistence contract cases

Source: [TanStack/db SQLite adapter contract](https://github.com/TanStack/db/blob/2c98b4992c412820f8476325ee6941db5ca9ac0f/packages/db-sqlite-persistence-core/tests/sqlite-core-adapter-oracle.test.ts).
Pinned commit: `2c98b4992c412820f8476325ee6941db5ca9ac0f` (2026-10-07 audit).

These cases run through one harness against our IndexedDB adapter and the installed upstream SQLite adapter (core 0.4.9). They also run against native browser IndexedDB. Assertions and transaction fixtures are retained for stream-position idempotency, atomic rollback, metadata, truncate, replay thresholds, metadata-only replay, cursor ties, custom collation, distinct numeric/string keys, boolean/operator fallback, and typed bigint/Date predicates.

Adaptations: use explicit eager storage targets required by persistence core 0.4.9; replace SQLite driver/table introspection with public stream-position, replay, and metadata assertions; supply a backend-specific serialization failure (the original invalid Date for SQLite, an unsupported function for IndexedDB, which natively accepts invalid Date values); inject adapter creation/cleanup; remove Node imports; require the replay extension in the harness type; acquire typed indexes for the bigint/Date fixture, since unpaginated subset reads may return candidate supersets. SQL compilation, physical table naming, SQLite scheduling/driver admission, binding caps, and platform-specific SQLite bridges are not IndexedDB contracts. Other existing IndexedDB tests cover idempotency, schema policies, bounded histories, resume snapshots, query planning, and index lifecycle.

No upstream persistence-specific benchmark suite was found at this commit. Upstream's incremental-update benchmark targets in-memory collections, joins, and materialization. Our browser benchmarks instead measure actual IndexedDB reads and incremental writes on a fixed 10,000-row dataset; they are not presented as a port of that benchmark or a cross-engine comparison.

## Managed cache generation contracts — 2026-10-14

Additional source: [SQLite resume snapshot oracle](https://github.com/TanStack/db/blob/8660cc0eb4914b8b0d3b2ba159416185f6d956c9/packages/db-sqlite-persistence-core/tests/sqlite-resume-snapshot-oracle.test.ts)
and [persisted runtime oracle](https://github.com/TanStack/db/blob/8660cc0eb4914b8b0d3b2ba159416185f6d956c9/packages/db-sqlite-persistence-core/tests/persisted-oracle.test.ts).
Pinned commit: `8660cc0eb4914b8b0d3b2ba159416185f6d956c9`. Its SQLite adapter
source is identical to installed persistence core 0.4.9 (checked by byte comparison).

`managedCacheContract.ts` ports the relevant public storage and recovery histories
into one factory-driven suite, run unchanged against fake IndexedDB, upstream
SQLite, and native Chromium IndexedDB. The ports retain upstream's operation
ordering, controlled clocks, expiry cuts, expected head selection, and durable
state assertions. SQL catalog/table assertions become backend-specific physical
footprint counts, covering all of each backend's generation-scoped stores.
Indexes use serialized IR supported by both backends instead of SQLite-specific
`row_version` expressions. No upstream checkout or network is required by tests.

Ported source histories:

- Collected managed targets never become eager storage; bare and malformed targets
  are rejected, every implemented storage entry point rejects revoked claims,
  and explicit eager reuse of the same bytes remains a separate valid operation.
- Eager IDs with both current and legacy internal-looking prefixes remain valid.
- Retired storage persists only while another valid claim needs it; last release
  collects rows, metadata, indexes, journals, and generation/claim records.
- The complete finite retired-storage grammar: release/expire/renew for both
  retired peers, zero/two rows, and all six expiry cuts (108 cases per backend).
  This exhaustively enumerates the domain sampled by upstream's fixed-seed and
  random fast-check histories without introducing a property-testing dependency.
- Paused/expired runs recover privately; a current shared cache and its warm
  peers remain claimable and retain their rows and resume metadata.
- Startup metadata returned after its claim expires cannot authorize a source.
- A custom source restarts after claim expiry, and retired callbacks cannot write
  into the replacement generation.
- Old and queued source commits reject after expiry; subsequent source writes
  succeed under the recovered claim.
- Timer-observed claim loss reloads retained demand.
- Explicit scoped recovery moves to a fresh generation and retains a reset marker;
  old and fresh durable rows remain isolated.

`managedCacheRaces.ts` ports SQL registration/revocation checkpoints to IndexedDB:
operations pause before or after collection initialization, then lose their claim
or physical generation. Every implemented read/write/index entry point must reject
without resurrecting storage. These tests also cover stale schema registration
without resetting a valid warm peer, concurrent claims and conditional rotations
across separate connections, and a real v3-to-v4 migration retaining local data.
They run against fake and native IndexedDB. The gated initialization seam replaces
SQL DDL/registry hooks: IndexedDB validates registration and data access inside
transactions containing the generation and claim stores, rather than doing DDL.

Exclusions: SQLite CLI argument transport, physical table creation/trigger/index
SQL, driver admission and scheduling tests have no IndexedDB equivalent. SQLite's
optional `reconcileCommittedTx`, `reserveLeadershipTerm`, and certified key-set
capabilities are not implemented by this adapter and are not claimed as part of
managed cache support. Their SQL-specific oracle cases are not ported. Core-only
mock tests for all timer/retry/scheduler interleavings remain owned by the installed
upstream wrapper; this suite adds real-adapter receiving histories rather than
copying unrelated wrapper implementations or the entire 32,000-line oracle.

## License

MIT License

Copyright (c) 2025 Kyle Mathews

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
