# Collection persistence and schema evolution

## Status and scope

Draft proposal for Party Stack. The APIs below are proposed, not shipped.

The selected immediate implementation keeps TanStack's full
`PersistedCollectionPersistence` object on the runtime, including collection/mode
resolvers. Node and Expo retain their factory results; IndexedDB provides an
equivalent resolver over one shared connection. Our coordinator binds selected
adapters by collection ID and releases bindings on last unsubscribe. SQLite retains
its upstream version/policy adapter caches. IndexedDB instead creates collection
adapter views over a shared connection, with no retained historical adapter cache.

The function-provider API below is a future alternative for stronger collection
ownership and bounded retention; it is not the interface being implemented in this
PR. Live migrations, installation-level ontology reopening, application data
migrations, and backend-derived object versions are also future work.

This complements [Standalone coordination](../2026-07-26-coordination/README.md).
Persistence, outbox, and blobs continue using one generic coordination system.
This proposal does not introduce a separate persistence election or transport.

## Identities and versions

Keep three concepts distinct:

| Concept | Meaning | Example |
| --- | --- | --- |
| Logical collection ID | Which dataset consumers address | `objects:Task` within an owner/namespace |
| Compatibility version | Which persisted representation readers and writers support | `1` versus an incompatible `2` |
| Migration revision | Which transformations have been applied within a compatibility version | Backfill revisions `1`, `2`, `3` |

Initially, the provider's `schemaVersion` supplies TanStack's existing expected
schema version. Treat it as a representation compatibility boundary, not the
version of Party Stack or SQLite itself. TanStack currently exposes one such
version; a separate migration revision is a future Party Stack extension.

A compatible optional-field addition or backfill need not create a new logical
collection. An incompatible field rename or encoding change may require a new
compatibility version. Compatibility includes writes from older clients, not
only their ability to read new rows.

Object collections initially request version `1` separately for every object
type. Later, the ontology backend can provide a per-type compatibility version
and migration revision. Do not blindly use every backend migration number as a
breaking version, or use an arbitrary schema hash where ordered versions are
required.

## Future alternative: runtime provider and lifetime

A future alternative to retaining `PersistedCollectionPersistence` is a function:

```ts
type CollectionPersistenceProvider = (options: {
    collectionId: string;
    schemaVersion: number;
    mode: "sync-present" | "sync-absent";
}) => {
    adapter: PersistenceAdapter;
    cleanup(): void | Promise<void>;
};
```

Acquisition is synchronous; storage initialization remains asynchronous inside
adapter operations. The runtime owns shared connections/drivers and closes them
at runtime shutdown.

The provider retains adapters only for active collection owners. Compatible
acquisitions for the same collection ID share an adapter and increment ownership.
Compatibility requires the same expected version and effective mismatch policy.
Different collection IDs may freely have different versions.

Overlapping ontology instances, direct local collection construction, or delayed
cleanup can acquire the same ID more than once. Each returned handle has an
idempotent `cleanup()`. The last cleanup removes active registrations and
provider-held adapter references; it does not close a shared database or delete
persisted data. Avoid a lifetime cache keyed by every version/policy ever seen.

Reject conflicting acquisitions for an active collection ID. An ordinary
acquisition must not silently reset or migrate data underneath existing owners.
This check is local to the provider; cross-context safety still requires shared
coordination and storage-level stale-adapter checks.

TanStack's `PersistenceAdapter` has no general `cleanup()` or `close()` method.
The returned cleanup belongs to Party Stack's ownership handle, not an assumed
upstream adapter API.

## Integration with TanStack and ontology

Under the future provider design, `createLocalCollection` and
`createLiveOntologyObjectCollection` acquire using
the final collection ID, requested version, and sync mode. They pass
`{ adapter, coordinator: ourShim }` to `persistedCollectionOptions` and release
the handle after TanStack persistence teardown finishes. Release on construction
failure too, preserving the original error if cleanup also fails.

Local collections retain their existing requested versions. Object construction
passes version `1` today; replacing that input with a per-type version later must
not require another provider interface change.

Platform providers adapt to TanStack's concrete APIs:

- `createNodeSQLitePersistence` / `createExpoSQLitePersistence` return
  `PersistedCollectionPersistence` objects. Their
  `resolvePersistenceForCollection({ collectionId, mode, schemaVersion })`
  selects a configured `.adapter`.
- `createSQLiteCorePersistenceAdapter({ driver, schemaVersion,
  schemaMismatchPolicy })` can construct an adapter directly where a suitable
  driver is available.
- Use collection-owned configuration without retaining the factories' entire
  version/policy caches indefinitely. Verify transaction sharing for each platform
  rather than assuming separate drivers automatically share execution state.
- Our shim implements `setAdapterForCollection(collectionId, adapter)` for
  leader-side dispatch, with ownership-aware registration cleanup. Provider and
  coordinator lifetimes must agree, including repeated owners and failure paths.

Refetchable synced caches may reset on mismatch; local-only data must be preserved
and report an error until a migration exists. Preserve row, metadata, resume-state,
and index consistency when resetting. Never globally reset unrelated collections.

## IndexedDB connection ownership

Extract connection opening, database upgrades, version-change events, and closing
into one shared connection owner. Collection adapters retain independent expected
versions, mismatch policies, and bounded bookkeeping over that connection.

Collection cleanup discards its adapter state while other collections remain
usable. Runtime shutdown closes the connection and prevents reopening. Direct,
standalone adapter construction continues to work without Party Stack imports;
that adapter owns its own connection. A full SQL-style driver abstraction is not
required merely to share an IndexedDB connection.

## Future live upgrade operation

Support upgrading one collection while the rest of a live ontology stays active
through an explicit coordinated operation, not a conflicting acquisition:

1. Obtain exclusive upgrade ownership across all contexts. Stop new acquisitions
   and pause that collection's sync/writes. Settle, transform, or explicitly reject
   pending optimistic mutations and queued outbox work; do not discard them.
2. Apply migrations through a dedicated storage interface before normal adapter
   mismatch checks can reset/reject the old representation. Include affected
   metadata, resume checkpoints, and indexes, not only rows.
3. Commit transformed data and version/revision records atomically where the
   backend supports it. On failure preserve the previous state. Large multi-batch
   migrations need staging or a recoverable journal; do not claim whole-migration
   rollback from independent batch transactions.
4. Fence stale adapters and rebuild or replace the in-memory collection. Explicitly
   reconnect dependent queries and release old owners; migrating disk does not
   migrate in-memory rows, indexes, or optimistic state.
5. Resume sync/writes and notify other contexts of the new generation. Handle
   unsupported older clients explicitly rather than letting them downgrade data.

Migration steps must support skipped releases, deterministic ordering, and crash
recovery. A compatible live backfill may avoid full replacement only when old and
new readers/writers are demonstrably compatible and all changes are published to
live consumers. Exact APIs and publication semantics remain open.

## Optional versioned storage identity

Keep logical identity stable by default. For incompatible representations, a
future explicit mapping could use `Task:v1` and `Task:v2` as separate storage
identities. This allows coexistence, but creates separate stores: data must be
copied or refetched, consumers and pending writes switched deliberately, and old
stores eventually collected. Including a version in an ID is not a migration.
Do not automatically append every migration revision to `collection.id`.

## Validation and open decisions

Immediate tests: mixed versions across collection IDs; compatible repeated
acquisitions; rejected conflicting configurations; idempotent cleanup; last-owner
release; cleanup/reopening; construction failure; mismatch preservation/reset;
stale access; shared connection shutdown and close-during-open.

Future migration tests: interrupted upgrades, cross-context ownership and stale
clients, skipped revisions, pending mutations/outbox entries, metadata/index
consistency, query handoff, and failed migrations preserving prior state.

Open decisions: backend version source; public upgrade/migration APIs; whether
compatibility version and migration revision become separate stored fields;
generation notification and query handoff; and when versioned storage is preferable
to an in-place upgrade. These do not block the immediate full-persistence-object integration.

## Upstream context

- [TanStack DB #865](https://github.com/TanStack/db/issues/865) discusses schema
  evolution through migrations, application hooks, or wipe/resync.
- [#1589](https://github.com/TanStack/db/issues/1589) documents schema reset and
  stale resume-state failures, plus shape-identity versioning as a workaround.
- [PR #1845](https://github.com/TanStack/db/pull/1845) addresses per-collection
  coordinator routing and committed-transaction ownership.
- [#1991](https://github.com/TanStack/db/issues/1991) reports dependent live queries
  retaining an old collection after same-ID instance replacement. A future upgrade
  must explicitly verify consumer handoff against the versions we use.

These discussions motivate this proposal; they do not establish an upstream live
migration API or endorse Party Stack's proposed compatibility/revision split.
