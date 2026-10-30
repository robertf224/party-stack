# Storage and transactions review — 2026-10-29

Updated October 30. This working record preserves the initial findings and the
subsequent fixes; it is not a claim that every possible transaction schedule has
been proved correct. The October 30 follow-up records the implemented changes.

## Review checklist

- [x] Public APIs and actual consumers
- [x] Stored data and representation
- [x] Transaction boundaries and commit flow
- [x] Driver ownership, interruption and handle lifetime
- [x] Errors and recovery semantics
- [x] Index/planning paths and scaling limits
- [x] Existing verification and a targeted cross-driver reproduction
- [x] Define failed-object-mutation semantics and implement rollback-only protection
- [x] Add cross-driver regressions for caught/uncaught object/blob failures and concurrent mutations
- [x] Unify ambient raw/object transaction composition (F3), preserving explicit nesting rejection
- [x] Preserve attachment-retention failures and normalize downstream recovery categories
- [x] Stream transactional index backfills and clean up caught partial failures

Pure helper expected-error boundaries (F2) remain recorded below; the review
explicitly deferred that pass. Structural sharing, SQL concurrency, native schema
migrations, broader SQL query compilation and online/resumable index creation remain
separate follow-ups rather than new correctness claims.

## 1. Public API and responsibility

There are two intentionally different interfaces in the same package:

| Interface                | Responsibility                                                                                                                                                        | Current consumers                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `TablesService`          | Arbitrary keyed records, explicit table codecs/versions, secondary indexes, transactions                                                                              | Replica base/inherited/overlay/outbox/coverage, blob metadata, Connect and owned-backend bookkeeping |
| `OntologyStorageService` | Object tokens derived from ontology definitions, object/key validation, key derivation, declared field validation, definition guard and optional attachment retention | Owned backend's object access; explicit schema-aware storage compositions                            |

This does not require authors to define a second schema: `makeStorageModel`
compiles or accepts Effect codecs for the existing ontology IR. The object wrapper
uses the same Tables service; it does not own a second database or transaction.

Both interfaces expose `get`, `put`, `delete`, `query`, `ensureIndex`,
`withTransaction`, `withReadTransaction`, `transaction` and `read`. Raw Tables
also exposes `clear`. The key difference is `tables.put(table, key, value)` versus
`storage.put(object, value)`, which derives the key from the primary-key property.

A transaction callback is explicit-handle composition; `withTransaction(effect)`
lets ordinary service calls reuse the current transaction through Effect Context.
These are two entry styles for the same mechanism. Nested explicit boundaries
are rejected rather than implemented as savepoints. Read transactions reject
writes. Concurrent operations through a raw transaction are serialized; callers
must join child work before leaving the transaction.

## 2. Physical storage

| Implementation      | Persistent state                                                                                  | Execution / locking                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Memory              | Maps of encoded rows, definitions and sorted index entries                                        | One semaphore per service; copy-on-write working state published on success                                        |
| IndexedDB           | Three fixed stores: rows, definitions, index entries                                              | Native transaction across all three stores; queued requests and a keepalive request permit Effect scheduler yields |
| SQLite / PostgreSQL | Shared rows and definitions tables; each row contains encoded data and sortable index projections | Effect SqlClient transactions; native expression indexes and database query planning                               |
| Durable Object      | The same SQLite Tables composition, optionally with R2 or inline SQLite bytes                     | DO-native async transaction bridge; no separate object mutation or journal engine                                  |

SQL is **not** one application table with readable native columns per object type.
Data still uses the portable value-tree codec; projection values are sortable
encodings. Schema-aware validation is already implemented, while native physical
schema generation/migrations remain deferred.

IndexedDB logical indexes do not trigger database-version upgrades. Scalar indexes
also have lowercase companion entries. SQL uses native expression indexes; PG
scalar-array membership can use GIN, while SQLite uses `json_each`. SQL does not
import the memory/IndexedDB query planner. Residual evaluation precedes pagination.

The raw codec supports JSON-shaped values plus undefined, bigint, Date,
Temporal.Instant/PlainDate, Map and Set. Ontology object values are restricted by
the ontology's own supported types and codecs. Copies are encoded values, not
persistent references to caller-owned mutable objects.

## 3. One authoritative write

For an owned backend, an action's transaction contains:

1. Authorization/bind/reference checks that depend on the transaction's reads.
2. Object mutations, including indexes and attachment-reference roots.
3. One change-journal commit with a revision allocated under coordination held through commit.
4. The action receipt when retained for idempotent recovery.

The object wrapper's calls and raw metadata-table calls participate in the same
physical transaction. Notifications publish after successful commit. Raw storage
writes alone do not journal themselves; the owned backend's mutation wrapper is
responsible for collecting changes. Its trusted transaction API uses that wrapper.

Multiple changes to the same object within a mutation collapse to its last
recorded put/delete in the commit map. This is not general before/after net-change
elimination: create-then-delete is still recorded as a final delete.

External byte IO is outside the database transaction. Blob metadata and durable
write/delete intents share Tables; physical files/object storage are recovered
separately. Even inline SQLite bytes currently follow that common protocol rather
than becoming part of the object mutation's database transaction.

## 4. Isolation, ownership and cancellation

- Memory transactions serialize all reads/writes through the service gate. Failed
  bodies discard their working copy.
- IndexedDB acquisition is scoped. Interruption aborts the transaction and waits
  for native completion/abort; escaped transaction handles reject later access.
  Keepalive means a transaction can survive yields, not that network work belongs
  inside it. Long external waits keep the database transaction occupied.
- SQL acquisition is owned by the supplied SqlClient Layer. The synchronous
  SQLite bridge borrows the database rather than closing it. Its connection gate
  spans a transaction; DO-native rollback is awaited before release.
- PostgreSQL snapshot readers use repeatable-read transactions without application
  advisory locks. Writers coordinate point reads/writes by key and predicate reads
  by logical table, holding locks through commit. Write-intent reads avoid lock
  upgrade deadlocks; confirmed aborts retry the entire callback. Journal publication
  has its own short per-stream lock and sequence. No namespace-wide transaction
  lock remains. Arbitrary external SQL writers do not participate in these rules.
  See [the measured concurrency checkpoint](./postgres-concurrency.md).
- Transaction errors preserve the callback's typed error channel. Defects and
  interruption also roll back. A success is returned only after commit completes.
- Catching an Effect failure converts that subprogram into success. It does not
  automatically undo earlier successful statements. This matters for finding F1.

## 5. Confirmed finding F1: caught object-write failure can corrupt retention

Priority: correctness / possible attachment loss. Fixed in the October 30 follow-up below.

Location: `ontology-storage/src/ontology/storage.ts`, object `put`, lines 139–150.
The wrapper changes blob retention **before** `tx.put` performs unique-index
validation. The raw table implementation deliberately checks uniqueness before
mutating its row/index entries, so that failure is safe to catch at the raw layer.
The earlier blob changes are outside that raw put's validation boundary.

Reproduction:

```ts
// Initial Issue one: slug="one", file=old. Issue two already owns slug="two".
yield *
    storage.transaction((tx) =>
        Effect.result(tx.put(issues, { id: "one", slug: "two", file: { id: "new" } }))
    );
// Caller caught UniqueConstraint, so the enclosing transaction succeeds.
// Issue one still references old; its root now retains new instead.
yield * blobs.collectGarbage({ olderThanMs: 0, orphanGraceMs: 0 });
// The still-referenced old attachment is deleted.
```

Fresh reproductions against memory, native SQLite, PG via PGlite, and fake
IndexedDB all returned the same result:

```json
{ "failure": "UniqueConstraint", "rowFile": "old", "collected": 1, "oldStillExists": false }
```

A normal uncaught failure rolls back correctly. Existing tests cover normal
object/root rollback and caught raw-table uniqueness failures separately; they
miss their composition here.

Recommendation: define failed multi-step object mutations as making the enclosing
transaction rollback-only when any step may have mutated state. Retain the
original typed failure at transaction completion even if the callback catches it.
This is a conservative first solution that does not require cross-driver
savepoints. It needs explicit tests/documentation because in-transaction retry
loops cannot then recover from such a failed operation. A future fully preflighted
mutation plan could permit recovery without this restriction. Merely reversing
row-write and root-write order moves the bug to attachment validation failures.

The regression should check both directions: failed row/index validation must not
release the old attachment, and failed attachment validation must not publish a
new row. It should cover caught/uncaught errors and shared raw/object service
composition. Concurrent multi-step object writes also deserve a schedule test;
serialization of each raw table call does not prove whole-object-operation
isolation within a transaction.

## 6. Boundaries and scaling work to discuss

- The logical Query IR and physical storage filters are still different ASTs.
  Logical Subset uses Expression and page; physical Query uses Field/Scalar
  predicates and limit/offset/after. The backend query executor lowers supported
  logical predicates to storage filters and rechecks residuals. Keeping physical
  plans small is reasonable, but operator semantics and lowering need parity
  tests; this is not yet literally a shared Subset type.
- Attachment retention now preserves BlobStorageError or existing storage errors;
  it is no longer classified as a codec error. The backend maps NotFound to a
  nonretryable missing attachment, Busy to retryable Conflict, and Bytes to
  Unavailable. Parameter/property attribution remains an action-layer concern.
- `ensureIndex` now streams rows within the same transaction, without a table-sized
  entries array or uniqueness Set. Memory iterates its map with bounded chunks;
  IndexedDB and SQL use 128-row keyset batches. Memory/IndexedDB build provisional
  entries; SQL prepares portable projections in batches and uses native grouping
  and CREATE INDEX. Partial failed builds are cleaned before a caught retry;
  cleanup failure makes the transaction rollback-only. This bounds scan buffers,
  not total index size, transaction duration or database-engine workspace.
- Unindexed/residual queries can hydrate a broad candidate set. Limit does not
  guarantee a bounded scan when filtering/sorting is residual.
- Memory first-write copies a changed table's map and changed index buckets.
  It is a simple serialized transaction implementation, not MVCC or an STM-backed
  store. Large caches need measurement and memory budgets.
- There is no general drop-table/drop-index/migration API. Names/version stamps
  and index definitions persist until their owning database is destroyed or an
  explicit future migration removes them. Fixed infrastructure tables are bounded
  by their declared set; applications inventing new names forever are not.
- Object definitions guard physical representation; the separate full definition
  signature used by replica/backend protocols has broader compatibility meaning.
  These two stamps should remain explicitly named/documented rather than confused.

## Initial verification, before the fix

The existing storage/SQL/IndexedDB task graph passed 15/15 tasks from unchanged
input caches. This is baseline coverage, not evidence that F1 is safe. The fresh
four-driver reproduction above demonstrates the missing invariant despite those
passing tests. Native Chromium IndexedDB contract, planner and keyring checks also
passed 3/3 tests (11/11 tasks including prerequisites). That existing browser
contract includes ordinary blob-retention rollback, but not the caught-failure
composition in F1. No production fix or new regression has been applied yet.

## October 30 follow-up: in-memory state inventory

| State                                                              | Lifetime / bound                                                                       | Purpose and assessment                                                                                                                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Memory driver row/definition/index Maps                            | Life of the memory Tables instance; size follows stored data                           | The database itself, not a second cache. A semaphore serializes transactions. First write copies the changed table map/index bucket; successful completion publishes working state, failure discards it.           |
| Raw transaction `knownDefinitions`                                 | One transaction; one entry per table touched                                           | Avoid repeated metadata decoding/reads. Released with the transaction.                                                                                                                                             |
| Shared `CurrentTransactions` Context Map                           | Active Effect transaction context                                                      | Route calls on a particular storage service to the active handle; not a process-global transaction registry. Detached child fibers can retain their inherited context, so callers must join transaction work.      |
| `compiled` WeakMap                                                 | Lifetime of reachable StorageModel keys                                                | Stores compiled model metadata without keeping discarded models alive. Its per-model object-token Map has one entry per defined object type. It is private model implementation state, not a row or request cache. |
| Blob `owners` WeakMap                                              | Lifetime of storage identity keys; values contain active scoped blob-service owner IDs | Scope registration/release maintains the Set. Unknown owners are considered dead only under the documented exclusive-process-owner assumption. This is not cross-process liveness or tab/client session tracking.  |
| Planner hydration cache, overlay key merge, query-index collection | One query/helper execution                                                             | Deduplicate hydrated rows, merge sparse layers or collect declarations. Temporary does not imply small: broad scans or loading all override rows can still require significant memory.                             |
| Attachment collection Maps                                         | One collection call                                                                    | Deduplicate handles by ID.                                                                                                                                                                                         |
| Value decoder `new Map`                                            | Returned application value                                                             | Reconstructs a persisted Map value; not service bookkeeping.                                                                                                                                                       |

WeakMap alone does not bound the contents associated with a live key. The owner
Set therefore still needs its Scope finalizers; model Maps are bounded by the
model's definitions. These Maps generally have a concrete purpose. Avoid replacing
pure local Maps with Effect services merely to make their syntax Effectful.

## October 30 follow-up: Effect error boundaries

A pure synchronous helper may throw and remain useful to non-Effect callers.
The relevant question is whether a caller converts expected invalid input into a
typed Effect failure with `Effect.try`. A throw escaping an Effect generator,
`Effect.sync` or `Effect.map` becomes a defect. `Effect.die` explicitly constructs
that defect effect. A throw that happens before the Effect is constructed is an
ordinary immediate JavaScript exception instead.

The expected-error path is `Effect.fail(error)` (or yielding a yieldable tagged
error). `Effect.catch`/`Effect.result` handle that typed channel; defect handling
requires inspecting the Cause or an explicit defect handler.

Confirmed finding F2: `ontology/src/live/actions/prepareActionParameters.ts:27`
calls `collectActionAttachments` directly in its generator. An unknown action
throws TypeError from `ontology-storage/src/blobs/attachments.ts:62`. A fresh
`Effect.exit` reproduction produced a `Die` reason, not a typed BackendError.
The multipart attachment HTTP path also calls the pure collector directly; it
must classify unknown request names before, or at, that boundary. Object attachment
collection can also fail through reference resolution and needs call-site review.

Do not blanket-convert every TypeError to an expected request error or return an
empty attachment list. Invalid caller requests, invalid configuration and broken
internal invariants have different meanings; silently missing retention references
would be worse than the original error. The pass should cover pure helper callers,
not just grep for throw statements inside this package. Infrastructure Promise
bridges such as crypto/native byte IO are legitimate when wrapped by Effects and
owned cancellation/finalizers; their presence alone is not a migration failure.

Status: findings recorded, implementation unchanged.

## October 30 follow-up: full-query execution placement

Implemented after review:

1. Both Tables and OntologyStorage now execute full QueryDocument IR. Raw Tables
   takes explicit source-to-table bindings and dynamically typed row fields;
   OntologyStorage supplies object definitions and relationships automatically.
2. Both expose `.query`; `.loadSubset` is removed from these services. Typed
   `.query(table/object, scan)` remains a single-source shorthand. Backend adapters
   retain loadSubset as a replication capability, and the executor retains a
   reader abstraction for lowering and authorization.
3. The shared generic finite executor lives in ontology-storage/query. The backend
   wraps its error factory to preserve BackendError classification; storage uses
   OntologyStorageError. No backend dependency or second executor was introduced.
4. Memory/IndexedDB retain their index planner; SQL plans lowered source queries.
   Native full-query SQL compilation and query IVM remain future work.
5. `lookup` replaces `objectLookup` consistently in authored IR, code generation,
   validation and execution. Raw Tables rejects ontology-specific shortcuts but
   supports explicit correlations and all schema-independent expression forms.

F1 is fixed by making failed object mutations rollback-only, preserving the first
failure cause at transaction completion even when caught. A transaction-local gate
serializes complete object mutations, including their attachment root changes.
The shared blob contract tests caught/uncaught uniqueness and missing-attachment
failures, the original row/root, and unrelated raw writes rolling back together.
The query contract covers raw and ontology documents on all drivers, including
correlation, pagination, computed/conditional selections, inputs and expired handles.

Verification after these changes: workspace CI passed 133/133 tasks; real Chromium
IndexedDB contract/planner/keyring coverage passed 3/3 tests (11/11 task graph).
The shared contract ran on memory, native SQLite, PostgreSQL via PGlite, fake
IndexedDB and native Chromium IndexedDB; the workspace also checked the DO bridge.

Memory still clones a touched table Map and changed sorted index arrays. A
structurally shared B-tree (or persistent key map plus ordered indexes) is a
candidate improvement; benchmark small updates to large tables before selecting
an implementation. No B-tree or native SQL schema migration was added here.

Initial finding F3: raw/object transaction composition was asymmetric. It is now
fixed by sharing physical transaction state and per-storage wrapper bindings.
The initial reproduction was:

```ts
// Success: the object transaction establishes both contexts.
yield * storage.transaction(() => tables.put(metadata, "key", 1));

// TransactionError { kind: "Nested" }: object operations try to start a new boundary.
yield * tables.transaction(() => storage.put(model.objects.Issue, { id: "one" }));
```

Both service-call directions now reuse the same physical transaction. The former
separate object transaction Context Map is gone. Rollback-only state and complete
object mutation serialization live at the physical boundary, including when
multiple wrappers join it. Explicit nested transaction callbacks still reject;
joining a read-only transaction cannot promote it to a write. Owned delivery
capture no longer needs a nesting-order adapter. Shared driver contracts cover
both directions, service spreads, read-only behavior, rollback and caught failures.

## Future work: structural sharing and rebase checkpoints

Deferred after the October 30 review; not a v0 requirement or an implementation
commitment. Keep the current base/outbox/sparse-overlay model while investigating:

- **Memory driver first.** Benchmark a structurally shared B-tree or persistent
  key map plus ordered indexes against the current touched-table Map clones and
  sorted-array index maintenance. Measure small writes to large tables, allocation,
  rollback and range queries; maintain the existing cross-driver contract.
- **Overlay reads and rebase.** Measure the cost of merging sparse overrides and
  clearing/replaying the pending outbox. Consider indexed visible-state branches,
  cheap snapshot roots and structural diffs only where measurements justify them.
  Versioned branches could reduce snapshot/diff work, but do not by themselves
  remove the need to rerun actions against changed upstream state.
- **Correctness before replay reuse.** Reusing earlier action results requires
  accounting for key reads, query membership/negative reads, action ordering and
  execution context. Existing retention dependencies alone do not establish that
  a replay can safely be skipped. Compare any optimization with full replay using
  generated operation sequences and the existing oracle approach.
- **Version lifetime.** Any retained roots/checkpoints need explicit scope,
  retention, crash recovery and GC, including index and attachment dependencies.
  Measure peak memory/disk and write amplification as well as latency.
- **Preserve driver choices.** Do not require SQL storage to become an opaque
  versioned B-tree. Keep native database transactions and indexes, and investigate
  application-level historical branches separately from the memory-driver change.

Reference: [Replicache's versioned rebase model](https://doc.replicache.dev/concepts/how-it-works).
