# PostgreSQL concurrency and committed change cursors

Discussed October 30. Future work; this note does not change the PostgreSQL driver.
Native SQL object tables/columns are deferred to the schema/data migration work.

## Current serialization

The SQL Tables driver explicitly obtains
`pg_advisory_xact_lock(hashtext(prefix))` for every read and write transaction.
The lock covers all logical namespaces using that physical Tables prefix. This is
our implementation choice, not an Effect SQL default or PostgreSQL limitation.
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

## Two viable directions

1. **Keep an application journal, narrow coordination.** Establish proper snapshot
   reads and serializable/conflict-safe action transactions, with explicit safe
   retry handling. Coordinate final journal publication per ontology: acquire the
   head row lock after action work, assign the next revision and append journal
   records, then commit while holding the lock. A later publisher cannot finish
   ahead of that holder. Measure the remaining commit bottleneck and avoid lock
   acquisition ordering that can deadlock. This still requires designing the
   exact SQL isolation and head-update primitive; it is not implemented by simply
   moving an existing line or changing a sequence.
2. **PostgreSQL-native change feed.** Decode committed changes from WAL and use an
   opaque commit position as the change cursor. This can remove the application
   revision allocator from the write path and observe external writers. It adds
   snapshot/cursor coordination, receipt correlation, replication-slot lifecycle,
   retention and reset recovery. Consuming WAL does not itself authorize external
   writes or update attachment retention metadata.

For either direction, a snapshot and its cursor must describe a consistent point.
Reading some rows and then obtaining an unrelated later WAL position could skip
changes not present in the snapshot. Logical decoding supports exporting a
snapshot paired with replication setup. Slots also require operational bounds:
unconsumed WAL can be retained, and recovery may redeliver changes. See
[PostgreSQL logical decoding](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html)
and [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

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

Before implementing either option, add real multi-connection tests for reversed
completion order, conflicts, rollback, caught failures, snapshot/cursor agreement,
reconnect and cursor retention. PGlite's current conformance coverage alone is not
a throughput or multi-connection concurrency proof.
