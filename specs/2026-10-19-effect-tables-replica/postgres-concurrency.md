# PostgreSQL concurrency and committed change cursors

Implemented and measured October 30. Native WAL capture remains future work.
Native SQL object tables/columns are deferred to the schema/data migration work.

## Previous serialization

Before this checkpoint the SQL Tables driver obtained
`pg_advisory_xact_lock(hashtext(prefix))` for every read and write transaction.
The lock covers all logical namespaces using that physical Tables prefix. This is
an implementation choice, not an Effect SQL default or PostgreSQL limitation.
The owned backend also reads and updates a per-namespace journal-head row when
appending a commit. Removing the coarse lock alone would not make revision
allocation or action read/check/write semantics safe.

The in-process mutation semaphore discussed in the storage review is separate:
it groups an object's row and retention writes within one physical transaction.
It is not the cross-connection advisory lock.

## Allocation order is not commit order

Consider replacing the journal head with an ordinary sequence:

| Step | Transaction A                | Transaction B                         | Replication reader                       |
| ---- | ---------------------------- | ------------------------------------- | ---------------------------------------- |
| 1    | Reserves 10, updates issue A |                                       |                                          |
| 2    | Still running                | Reserves 11, updates issue B, commits |                                          |
| 3    | Still running                |                                       | Sees committed entry 11; saves cursor 11 |
| 4    | Commits entry 10             |                                       |                                          |
| 5    |                              |                                       | Loads entries greater than 11; misses A  |

A cursor must mean a consumed prefix of published changes, not merely the largest
allocated ID observed. Sequence gaps can also reflect rolled-back transactions;
waiting for every missing ID indefinitely is not a solution. PostgreSQL sequence
values are not reclaimed on transaction rollback. See
[sequence semantics](https://www.postgresql.org/docs/current/functions-sequence.html).

## Shipped coordination

Snapshot readers use `REPEATABLE READ READ ONLY` and no application locks.
Writers use `READ COMMITTED` plus strict two-phase advisory coordination:

- Point reads hold shared key locks, including when a row is absent.
- Writes hold exclusive key locks. `get(..., { forUpdate: true })` acquires this
  intent before reading; it is used for the owned backend's idempotency receipt.
- All point access shares a logical-table guard. Predicate reads, clears and
  index changes exclusively acquire that guard, protecting against phantoms and
  stale index projections. Read-only snapshot queries do not acquire it.
- Locks last until native COMMIT/ROLLBACK. Separate clients/processes coordinate
  through PostgreSQL, without a runtime ownership service or in-memory lock map.

This gives cooperating Tables operations serializable behavior; it is not native
PostgreSQL `SERIALIZABLE` isolation. Direct SQL writers must not bypass the guards
and expect action read/check/write guarantees. Predicate reads in write
transactions are intentionally conservative and may serialize an entire logical
table. Finer range locks can be added without changing action/backend interfaces.

An evaluated native `SERIALIZABLE` implementation suffered false dependencies
between unrelated keys on the shared physical B-tree pages. Forcing indexed plans
was insufficient. It was not retained, and the shipped driver does not change
PostgreSQL planner settings or require server predicate-lock tuning.

Confirmed `40001`/`40P01` aborts retry the complete database callback, up to eight
retries with exponential backoff. Escaped handles from prior attempts are closed.
Connection errors and lost COMMIT replies are not automatically replayed.
Mutators and trusted transaction callbacks must be replay-safe; external uploads
are staged before entering the database transaction.

## Shared portable journal

Tables now provides `insert` (no replacement; false on a uniqueness conflict),
write-intent `get`, and `allocateRevision(stream, minimum?)`. Drivers that already
serialize transactions share portable implementations. PostgreSQL supplies native
atomic insertion and per-stream sequence allocation under a short transaction
advisory lock. Allocation happens after business work, and the lock is held through
commit. This is why the sequence is safe here while the uncoordinated sequence
example above is not. Rollbacks may leave gaps.

The owned backend uses the same journal implementation for all stores. It inserts
one committed batch and saves the receipt in the same transaction as object and
attachment-reference mutations. It derives the committed head from the latest
retained entry and its archived head marker. It does not update an MVCC head row
on every commit. Age-based pruning advances the archive marker before deleting
entries, so removing the entire journal cannot move the cursor backward.
`maxCommits` bounds a revision window; rollback gaps can cause earlier expiry than
that many successful commits. It is an upper bound, not a minimum replay promise.

New SQL rows use atomic insertion before a uniqueness diagnostic is needed, and
unchanged unique values avoid redundant range reads. These optimizations are in
the shared Tables engine. Empty owned-backend maintenance first probes a read-only
snapshot; only actual candidates enter a write transaction, which rechecks the
conditions. Routine empty cleanup therefore does not take predicate guards
against in-flight actions.

## Native WAL follow-up

Keep query/transaction storage separate from the source of committed changes at
owned-backend composition. A future matched PostgreSQL provider must coordinate
snapshot bootstrap, commit positions, operation correlation, durable progress,
slot retention and reset recovery. Consuming WAL does not itself authorize
external writes or maintain our attachment/encryption semantics.

Reading rows and then obtaining an unrelated later WAL position can skip changes.
Logical decoding supports exported snapshots paired with replication setup.
Consumers must bound retained WAL and tolerate redelivery after recovery. See
[PostgreSQL logical decoding](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html).

## What Zero does

Zero's PostgreSQL change source converts the upstream `commitLsn` into both its
begin `commitWatermark` and commit `watermark`. Its acknowledgment handling waits
for downstream transaction persistence before acknowledging the pending commit
watermark. The position comes from PostgreSQL's committed change stream, rather
than an application sequence allocated before commit. The downstream log's own
persistence/ownership coordination still matters; WAL is not a claim that all
coordination disappears.

Source inspected:
[PostgreSQL change source](https://github.com/rocicorp/mono/blob/main/packages/zero-cache/src/services/change-source/pg/change-source.ts),
particularly `#makeChanges` and `#expectDownstreamAck`.
[Zero's PostgreSQL setup](https://zero.rocicorp.dev/docs/connecting-to-postgres)
documents the logical replication requirement.

## Verification and measurement

Real PostgreSQL tests cover overlapping independent writers, repeatable snapshots
while writes commit, contended counters, predicate write skew, actual cross-key
deadlock recovery, caught statement failures, lost COMMIT replies, ordered
publication, duplicate actions, parallel action batches and full journal expiry.
The portable contract also checks insertion conflicts and revision clocks across
memory, IndexedDB, SQLite and PGlite. Vitest global setup starts and stops PostgreSQL 18 through Testcontainers, both locally and in CI; the normal package test task includes these tests.

Controlled local Docker PostgreSQL 18 measurements (two runs of three rounds, 16 independent
existing Counter rows, concurrency eight, pool size twelve):

| Transaction body        | Previous coordination median | Current median | Mutator executions |
| ----------------------- | ---------------------------: | -------------: | -----------------: |
| No injected delay       |                       190 ms |          99 ms |   16 on both paths |
| 20 ms replay-safe delay |                       754 ms |         133 ms |   16 on both paths |

Values are the median ranges across the two runs. This isolates coordination/journal changes: the old SQL driver and owned journal
come from `faa2bdbb`, and both use the current portable core. Setup is outside the
timed region; final row counts and values are checked. The delay models work
inside a transaction, not an application throughput claim. These are local small
samples, not production capacity estimates or improvements for contended keys.

Reproduce after building `@party-stack/sql-ontology-storage`, from that package:

```sh
node benchmarks/postgres.mjs faa2bdbb
```

The script starts a managed PostgreSQL container, uses an isolated temporary
schema, and removes the container, schema and baseline source fixtures afterward.
An optional `PARTY_STACK_TEST_POSTGRES_URL` targets an existing disposable database. Native columns/migrations and WAL capture remain
separate future checkpoints.

Final validation: workspace `vp run ci` passed 133/133 tasks; the explicit real
PostgreSQL run passed 8/8 concurrency/recovery tests (18/18 SQL package tests), and
native Chromium IndexedDB passed 3/3 tests. Worker-safe bundle verification and
native Durable Object crash/transaction tests also passed through CI.

Further PostgreSQL work includes finer predicate guards and lock-budget handling
for very large bulk transactions. Cross-process advisory coordination does not
broadcast the owned backend's in-process wakeups: multi-host live notification
needs polling, LISTEN/NOTIFY or the future native feed. The v0 deployment remains
one designated server owner per ontology, with concurrent requests/connections.
