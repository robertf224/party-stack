# Attachment storage and independent retention

Status: the native client blob implementation now lives under
`@party-stack/ontology-storage/blobs`. Tables own metadata, identity aliases,
write/delete intents and independent retention roots. The runtime blob manager is
an application facade and an on-demand TanStack metadata projection. Replica
outbox enqueue/edit/remove/receipt reconciliation use the same raw transaction
capability for attachment roots. Legacy runtimes without Tables retain the older
implementation during migration.

The native path keeps metadata and aliases when evicting bytes. It uses immutable
generation keys and durable deletion intents; stale deletion cannot target a later
cache fill. Active readers hold transient roots, and action roots survive upload,
retry, ambiguous outcomes, blocked replay and restart. Ontology-aware traversal
covers optional/list/map/struct/union/result values. Object references and encrypted
values remain opaque. Staged sole copies are not age-evicted.

`BlobStorage.in(tx).retain(owner, ids)` replaces an owner's durable roots;
`release(owner)` removes them. External IO always happens outside database
transactions. Write cancellation waits for non-cancelable byte IO before deciding
whether to publish or abandon its generation. Recovery retries deletions and only
abandons foreign writes/readers after their registered owner is known dead;
unknown ownership is conservative. The replica host enables independent cache
maintenance with a five-minute age. Standalone native facades require explicit GC
configuration until their retention integration is established.

Generic inline transactional bytes, graph-based identity/metadata collection,
explicit offline attachment pin APIs and retiring the legacy facade/store remain
future work. Native metadata currently remains durable indefinitely; byte
collection does not imply metadata graph GC. SQLite's authoritative inline/external
attachment coordinator continues to supply its existing backend guarantees.

The design and legacy comparison below describe constraints for subsequent ports.

## Storage composition direction

Move the implementation into an `ontology-storage` subpath with independently
composable byte storage, metadata, remote fetching, and retention services.
Keep a compatibility facade in `@party-stack/blobs` while migrating callers.
The lower storage services must not depend on Runtime or TanStack collections:
the existing blobs -> runtime -> ontology-storage dependency would otherwise
become a cycle. Collection projections belong at the runtime boundary.

The host should own one storage composition and its maintenance scope. SQLite
inline bytes and external stores such as R2 are capabilities of that composition,
with distinct transaction guarantees. Do not merge row and byte eviction policies
or apply replica cache policy to authoritative sole copies.

## Authority is separate from location

A backend database and a durable client-local collection own their records. They
must not automatically evict those records or the sole copy of their attachment
bytes. A synchronized replica can evict data that it can recover from its source.
Being in a browser, SQLite, or IndexedDB does not establish authority.

Authority must be explicit in the engine/backend's storage binding. A single
database can contain authoritative local records, recoverable replica rows,
pending edits, outbox entries, and cached bytes. A database-wide TTL or backend
name is therefore insufficient. Time, size, and access scores only rank already
eligible candidates; they cannot establish eligibility.

This does not prohibit user actions that delete owned data. Authoritative deletion,
replica row eviction, cached-byte eviction, and cleanup of an uncommitted upload
are different operations with different effects.

## Three independently retained resources

| Resource                     | Retention and eviction                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ontology row                 | Owned rows remain durable. Replica rows can be evicted when demand and durable pending work no longer require them.                                       |
| Attachment identity/metadata | Can outlive an ontology row or its locally cached bytes. Retain it while referenced by other rows, pending work, or required identity/remote-ID mappings. |
| Attachment bytes             | Owned/staged sole copies remain durable. Recoverable remote bytes can be evicted independently while their references and metadata remain.                |

Evicting bytes does not delete an attachment reference or its remote source.
Evicting one row does not cascade into deleting its blobs: another row, an upload,
a pending invocation, or an explicit retention policy may still need them.
A reference to an attachment does not necessarily pin its local bytes forever;
the application can keep the row and fetch the bytes on demand.

Remote availability is a source contract, not just the presence of a string ID.
Persist the source identity and enough metadata to fetch again before treating
the local bytes as recoverable. Default to retaining sole copies when uncertain.

## Legacy implementation to preserve during remaining ports

The legacy blobs path has `staged`, `persisted`, and `cached` states,
plus pending/failed stage, cache, and purge operation records. Its collector:

- Considers persisted/cached entries, and skips staged entries and entries with
  an operation record.
- Uses access time and size to rank bounded batches.
- Runs under coordinated leadership with operation IDs and recovery handling.
- Currently purges both bytes and their metadata record. This can also remove a
  local-to-remote ID mapping; preserving identities independently of byte eviction
  is a required correction in the storage port.

Relevant code: `packages/blobs/src/types.ts`,
`packages/blobs/src/gc/collectBlobGarbage.ts`, and
`packages/blobs/src/store/createBlobStore.ts`.

Port these semantics instead of starting a new TTL-only blob collector. Do not
automatically apply the current client blob policy to authoritative backend data.
The native storage path now adds durable invocation and active-reader roots.
Row-demand-to-attachment pinning remains an explicit, independent policy.

Staged state currently prevents cache collection, but it is not a durable
dependency between an invocation and its bytes. Binding a remote ID changes state
to persisted before invocation reconciliation necessarily completes. Failed or
ambiguous dispatch and dependent queued actions can therefore still require those
local bytes or mappings after they become cache-eligible.

## Implemented lifecycle and remaining composition boundary

Store blob metadata, identity aliases, operation intents, and retention roots in
the same Tables namespace/transaction capability used by the Replica. A package
move alone does not make separately opened transactions atomic.

1. Write staged bytes under a unique generation and finalize a durable metadata
   record. For external bytes, retain a recovery intent until finalization; do not
   keep a database transaction open across the byte-store request.
2. In the enqueue transaction, validate each locally required staged generation
   and insert its invocation retention roots alongside the outbox entry, replay
   dependencies, and optimistic state. Resolve attachment handles through ontology
   type definitions, including nested values.
3. Keep roots through offline waits, retries, blocked work, ambiguous outcomes,
   and upload/materialization. Upload completion alone does not establish that
   all invocations depending on the blob or alias are finished.
4. Edit/remove/reconcile operations change invocation roots atomically with their
   outbox transitions. Definite cancellation can release them; uncertain outcomes
   keep them until reconciled. Other row, reader, offline-pin, and invocation roots
   remain independent owners.
5. Separate byte eviction from identity/metadata collection. A retained row can
   keep an attachment identity without pinning recoverable bytes forever. A staged
   sole copy or required pending upload cannot be evicted by age alone.
6. Claim external deletion transactionally after rechecking eligibility. Coordinate
   new readers/pins with that claim and target the exact immutable byte generation.
   Finish and recover deletion through its persisted intent; stale work must never
   delete a newer generation.

Regression cases must cover crashes between staging and enqueue, collection racing
enqueue, successful upload followed by lost action response, restart with pending
work, shared attachments across several actions/rows, changed invocation parameters,
and byte eviction that preserves identity aliases and later remote read-back.

The current sqlite-ontology implementation supports inline BLOB bytes or external
bytes. External storage uses prepared writes, unique storage keys, and an orphan
journal. Durable Objects supply R2 storage and lifecycle composition. Preserve
rollback cleanup, replacement handling, stale-operation fencing, and restart
recovery when porting that path.

## Transaction and recovery boundary

Ontology rows, attachment metadata, references/retention records, operation intents,
and backend receipts/change-log records need to use the same owned database
transaction where their invariants require it. They can use private ontology
object definitions; this need not expose backend bookkeeping in the public ontology.

If inline bytes share that transaction, they may commit atomically with metadata.
An external R2/object-store operation does not share the database transaction:

1. Persist a fenced staging/write intent and write to a unique byte location.
2. Commit the authoritative metadata/reference changes in the database.
3. Finalize the intent and clean up superseded or abandoned locations through
   recoverable, idempotent work.

An external purge likewise needs a durable operation token, eligibility recheck,
and coordination with new reads/pins/writes before deleting bytes. An old worker
must not delete bytes belonging to a newer write or protected reference. Cleanup
failure leaves retryable recovery work rather than an invented atomic commit.
The native client byte-store interface is an Effect service with read/write/delete;
inline transactional-byte capability remains part of the authoritative backend port.

## Replica row eviction

The engine knows query demand, optimistic overlays, invocation dependencies,
receipts, and synchronization coverage. Storage should execute bounded eviction
transactions; it should not independently guess that an old row is disposable.

An eviction transaction must recheck the candidate's eligibility and revision,
remove the cached base row and its secondary-index entries, update retention and
attachment-reference bookkeeping, and invalidate affected subset coverage. It
must not emit an authoritative tombstone, enqueue a remote delete, or claim that
the evicted row is absent on the server.

A row can satisfy several subsets. Losing one subscriber is insufficient evidence
that it is evictable. After eviction, an old global sync cursor or "loaded subset"
marker cannot establish that the local materialization is still complete.
Re-demanding the subset must reload/reconcile its missing data. Pending edits and
replay may need an old base revision even after the UI releases its demand.

The engine needs durable protection information for work that survives restarts;
an in-memory pin count alone is insufficient. Avoid prescribing a particular
refcount/lease representation until the Replica demand and outbox contracts are
implemented. Candidate selection and physical deletion must be fenced against
concurrent changes, including across tabs or coordinators.

## Proposed checkpoints

1. Port ontology-aware rows, schema guards, indexes, and native transactions.
   No automatic GC or attachment-byte cascade. This is the implemented checkpoint.
2. Port attachment metadata/bytes with authoritative versus recoverable retention,
   staging, operation fencing, and crash recovery. Retain current blob conformance
   and sqlite/R2 failure cases.
3. Integrate Replica demand, durable invocation protection, and coverage metadata.
   Implement independently configurable row and byte collectors with bounded
   transactions and explicit eligibility checks.

Required cases include keeping owned data regardless of age; keeping staged and
pending-operation bytes; evicting bytes while preserving row metadata; evicting a
row without deleting shared bytes; overlapping demands; pending optimistic work;
crash recovery during external writes/deletes; and re-demand after eviction.
