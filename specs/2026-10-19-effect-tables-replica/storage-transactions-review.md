# Storage and transactions review — 2026-10-29

This is the working review record, not a claim that every possible transaction
schedule has been proved correct. Implementation is unchanged during this review.

## Review checklist

- [x] Public APIs and actual consumers
- [x] Stored data and representation
- [x] Transaction boundaries and commit flow
- [x] Driver ownership, interruption and handle lifetime
- [x] Errors and recovery semantics
- [x] Index/planning paths and scaling limits
- [x] Existing verification and a targeted cross-driver reproduction
- [ ] Agree on failed-operation semantics before implementing the confirmed fix
- [ ] Add regressions for partial failures in composed object/blob operations

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
3. One change-journal commit and revision/head update.
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
- PG currently takes `pg_advisory_xact_lock(hashtext(prefix))` for **read and write**
  transactions. This serializes participating Tables users of the same physical
  prefix, even across different logical ontology namespaces. It is not a claim of
  configured PostgreSQL SERIALIZABLE isolation or coordination with arbitrary SQL
  writers that ignore the advisory lock. Better concurrency remains deferred.
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
- Object retention failures are currently wrapped as `CodecError`, including
  missing authoritative bytes. That obscures the cause category. Preserve the
  distinction when hardening F1 rather than reporting every blob failure as a
  serialization problem.
- `ensureIndex` backfills the full logical table and builds an in-memory entry
  array. It is deliberate setup work, not a bounded online migration. Large late
  index creation can be expensive in a DO or browser.
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

## Verification

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
| `CurrentTransactions` Context Maps                                 | Active Effect transaction context                                                      | Route calls on a particular storage service to the active handle; not a process-global transaction registry. Detached child fibers can retain their inherited context, so callers must join transaction work.      |
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

Memory still clones a touched table Map and changed sorted index arrays. A
structurally shared B-tree (or persistent key map plus ordered indexes) is a
candidate improvement; benchmark small updates to large tables before selecting
an implementation. No B-tree or native SQL schema migration was added here.

Confirmed finding F3: raw/object transaction composition is currently asymmetric.
A fresh memory reproduction showed:

```ts
// Success: the object transaction establishes both contexts.
yield * storage.transaction(() => tables.put(metadata, "key", 1));

// TransactionError { kind: "Nested" }: object operations try to start a new boundary.
yield * tables.transaction(() => storage.put(model.objects.Issue, { id: "one" }));
```

Object service calls reuse the object-context transaction, while raw service calls
reuse the underlying Tables context. With only the latter present, the object
wrapper starts a new raw boundary rather than wrapping the existing transaction.
Current owned backend composition puts the object transaction outside, so its
journal/receipt path works. This is a composability limitation to simplify alongside
transaction-scoped full-query execution; the two transaction-context Maps are
bounded, but their layering is not completely transparent to callers.
