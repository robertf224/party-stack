# Attachment storage and retention

## Implemented storage checkpoint

`@party-stack/ontology-storage/blobs` owns attachment metadata, local/remote identity
bindings, reverse references, write intents and deletion intents. All of those use
Tables. The separate `@party-stack/blobs` package and its TanStack metadata
collection have been removed. Ontology keeps a small application facade for remote
fetching and metadata inspection; it has no collection lifecycle of its own.

An attachment reference has two independent retention effects:

- An ordinary object row retains the attachment identity. Recoverable cached bytes
  may still be evicted. Staged sole copies remain while that row references them.
- An outbox entry or explicit byte pin retains both identity and bytes. Completing,
  editing or removing the entry changes its roots in the outbox transaction.
- A reader temporarily retains both for the lifetime of byte consumption.

These are indexed reverse references, not an incremented reference count. Replacing
an owner's references is transactional. Metadata eligibility hints are derived from
those references in the same transaction; GC rechecks the references before
removing anything.

`makeOntologyStorage(model, tables, { blobs })` discovers attachments from the
existing ontology definitions on every put/delete. Discovery follows optional,
list, map, struct, union, result and named types; object references and encrypted
values remain opaque. The owned-backend constructor accepts this service too.
Replica base snapshots, journal writes, optimistic replay and row GC maintain their
own reverse references in their existing transactions. Clearing an object type's
snapshot or optimistic overlays releases the corresponding group of references.
There is no scan of all application rows during blob GC.

## Drafts remain ordinary ontology objects

There is no draft-specific API, schema kind, lease API or source-routing rule in
this checkpoint. An application can define a Draft object with an action identity,
action version and typed parameters containing attachments. As long as the row is
retained, its attachments remain referenced. Application policy decides whether a
draft persists indefinitely, expires, is submitted or is deleted. Updating/deleting
the row updates its attachment references transactionally.

Recording action identity/version leaves room for future lenses over saved action
parameters. Defining draft object types, migrating their parameters and choosing
local versus remote routing remain application/schema-composition work. An opaque
JSON payload will not reveal attachment references; use declared ontology types.

## Collection policies

`collectGarbage({ olderThanMs, orphanGraceMs?, limit? })` has two bounded phases:

1. Select unreferenced identities whose grace period has elapsed, using the
   `unreferencedAt` index. Remove metadata and queue their exact byte generation for
   deletion. The default orphan grace is one hour, including raw staged uploads.
2. For replica bindings, select old recoverable byte caches using the access index,
   excluding byte-pinned and staged records. Detach bytes while preserving the
   identity and alias. Identity-only row references do not prevent this phase.

Each phase examines at most `limit` candidates. The result counts records removed
or whose cached bytes were detached. External deletion IO is a separate bounded
step and is retried from durable intents. Releasing the last reference starts a
new orphan grace period. The caller may request zero grace for an explicit sweep;
there is no automatic short-lived lease for raw attachment creation.

A storage binding with `mode: "authoritative"` only collects unreferenced orphans;
access age cannot evict referenced authoritative bytes. Authority belongs to the
binding and namespace, not to SQLite, IndexedDB or the device where it runs. Do not
share a blob namespace between independent authority/cache policies.

The replica host runs cache maintenance with a five-minute access age and the
one-hour orphan grace. Enqueue checks staged availability and inserts its roots in
the enqueue transaction, so safety does not depend on an assumed tiny time gap
between attachment creation and action submission.

## Atomic mappings and crash recovery

Receipt bindings normally commit with acknowledgement in the same transaction.
A receipt can arrive after a concurrent read has already created the remote cache
identity; binding merges that placeholder and its references into the staged
identity. Two independently staged identities are a conflict. An active reader of
a generation that would be detached postpones merging.

If a local binding fails, save the successful remote receipt without the binding
and stop settlement. Recovery retries binding before journal catch-up or receipt
confirmation. It must never submit the action again merely because local mapping
failed. A regression test covers that race, scope closure and restart.

External writes use fresh immutable generation keys. Metadata first records an
intent, byte IO happens outside the transaction, and publication checks the token.
Cancellation waits for non-cancelable IO to settle before publishing or abandoning
that generation. Deletion detaches the exact generation before IO, so an older
collector cannot delete a later cache fill. Owner liveness controls recovery of
abandoned writes and readers; unknown owners remain protected.

`readScoped(id)` keeps a reader root until its Effect scope closes. A consumer may
stream the returned file-backed Blob inside that scope. `read(id)` materializes a
standalone Blob before releasing the root, so a caller can safely consume it after
the call returns.

## Action execution and collection

Action/object writes validate attachment metadata and establish reverse references
inside the same Tables transaction as the application rows. Authoritative storage
rejects references whose byte generation is unavailable; replica storage may keep
remote identities without a local byte cache. GC checks references and removes
orphan metadata transactionally before scheduling external byte deletion. If the
action commits first, its references prevent GC. If GC commits first, the action
fails instead of recreating a placeholder and committing a dangling reference.
Uploads before the action transaction use the ordinary orphan grace period.
No additional in-memory GC lock or persistent temporary upload roots are needed.
SQLite and IndexedDB serialize writers; SQL Tables already serializes PostgreSQL
transactions across connections sharing a prefix with a transaction advisory lock.

The optional Durable Object Alchemy integration composes the same owned backend,
SQLite Tables and native BlobStorage with Alchemy's R2 client. The example's DO
alarm schedules bounded collection; it does not replace the shared GC algorithm.
An existing alarm is preserved across constructor runs. Native R2 writes stream
with a known length; the Blob read boundary currently materializes the response.

## Platform composition and transfers

The legacy SQLite attachment coordinator and `sqlite-ontology` package are removed.
`sql-ontology-storage/sqlite` supplies SQL Tables and replaceable byte IO; ontology's
`makeStorageOntologyBackend` supplies the common authoritative action/query helpers.
`durable-object-ontology-storage` supplies native DO SQL and Alchemy R2 bridges.
Its `/alchemy` constructor composes those same services; the example declares the
actual Alchemy resources, authenticated endpoint and GC alarm.

The DO bridge configures `exclusiveOwnerLiveness` using the platform storage object's
incarnation. Concurrent services on that incarnation share live-owner registration;
unknown persisted owners after a reset belong to the previous incarnation. Workerd
tests abort a DO after R2 write/before publication and during a scoped read, then
reopen the same object and verify recovery, collection and subsequent writes.
Other environments still require explicit liveness evidence for unknown owners.
Cloud deployment is separate from this local acceptance.

Attachment helper RPCs now stream downloads and upload progress/completion.
Effect RPC does not stream request payloads, so uploads send ordered, acknowledged
64 KiB chunks while a response stream owns a bounded queue. Cancelling that stream
removes the transfer and rejects further chunks. Authorization runs before allocation
and on each chunk; declared size/sequence validation prevents partial publication.
HTTP and MessagePort transports use the same contract. Owned servers can bind the
helpers directly to a backend; intermediate servers bind their LiveOntology facade.

These are scoped transfers, not resumable upload sessions. Blob APIs still materialize
complete content at the storage boundary, so this is not constant-memory end-to-end
IO. Offline query policies, range caching, durable resumability, direct byte grants
and optional integrations are tracked in [blob-future-work.md](./blob-future-work.md).

Do not add workflow orchestration merely for the current intents: an external byte
store still cannot join the metadata transaction. Effect scopes, retry and recovery
execute the durable intents; a workflow engine would not remove that boundary.

Conformance covers transaction rollback, schema-derived draft references and orphan
cleanup on Memory, IndexedDB and SQL. Focused tests cover grace renewal, independent
identity/byte retention, authoritative safety, mapping races, reader protection,
interruption, deletion retry and immutable-generation fencing.
