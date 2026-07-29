# Blob resource layer

## Responsibility

`@party-stack/blobs` manages storage, resolution, and caching of immutable byte
resources across local and remote backends.

It owns:

- Local staging and byte persistence.
- Blob metadata and local/remote ID relationships.
- Pull-through reads from remote sources.
- Cache reconciliation and time-based GC.
- Eventually range reads, streams, and backend capability pushdown.

It does not own:

- Durable upload intent.
- Upload progress or resumable transfer state.
- Retry/backoff and network scheduling.
- FIFO action execution.
- Relationships between transfers and queued ontology actions.

Those operation-specific concerns belong to outbox transfer jobs. Stable facts
produced by a completed transfer, such as a remote ID mapping, belong back on
the blob resource.

## Target public manager

```ts
interface BlobManager {
    readonly collection: Collection<BlobRef, string>;
    stage(id: string, blob: Blob | File): Promise<BlobRef>;
    metadata(
        id: string,
        options?: BlobReadOptions
    ): Promise<BlobRemoteMetadata>;
    read(
        id: string,
        options?: BlobReadOptions
    ): Promise<Blob>;
    bindRemoteId(
        localId: string,
        remoteId: string
    ): Promise<BlobRef>;
    cleanup(): Promise<void>;
}
```

`bindRemoteId` describes a stable resource relationship rather than an upload
workflow transition. If one local blob can target multiple remote namespaces,
replace the single `remoteId` with destination-keyed mappings.

## Internal store

The internal `BlobStore` owns a plain TanStack metadata collection plus
explicit byte-lifecycle operations:

```text
BlobStore
    collection: Collection<BlobRef>
    stage
    cache
    find
    read
    mark/bind remote mapping
    purge
    reconcile
```

Metadata collection mutations use `optimistic: false`; callers await local
durability. Typed blob coordination service methods fence operations that span
byte and metadata stores, such as stage/cache/purge/reconciliation; blob
consumers do not acquire per-blob Web Locks.

`queryOnce` handles:

- Local-ID or remote-ID resolution.
- GC candidate filtering.
- Recency/size ordering.

## Lifecycle and recovery

`BlobState` contains only stable states: `staged`, `persisted`, and `cached`.
The stable state is optional while a brand-new blob is being staged. A separate
discriminated `BlobOperation` records `stage`, `cache`, or `purge` work as
`pending` or `failed`; failed operations carry their error. This keeps the last
usable stable state independent from an interrupted operation.

Bytes and metadata cannot share one transaction, so every operation records its
intent durably before changing bytes:

```text
write stage/pending metadata
write bytes
write staged metadata and clear operation

write cache/pending metadata (preserving stable state)
write bytes
write cached metadata and clear operation

write purge/pending metadata (preserving stable state)
delete bytes
delete metadata
```

For a newly discovered remote blob, cache intent starts from `persisted`.
Binding a server-confirmed remote ID directly sets `persisted`, clears any
operation, and leaves local bytes available for reads.

Startup reconciliation is metadata-driven. It scans pending operations through
the leader-owned blob coordination service. Interrupted stage and cache writes
delete potentially partial bytes and become failed operations without guessing
from byte size or contents. Interrupted purges finish byte and metadata
deletion; deletion failures become failed purge operations. Stable and
already-failed records are unchanged.

`BlobBytesStore` only writes, reads, and deletes by ID; it does not enumerate
keys. Orphan bytes are therefore not adopted during startup. GC treats
completed `cached` and `persisted` blobs as purge candidates, while `staged`
blobs and active/failed operations are retained. `BlobManagerOptions.gcTime`
defaults to five minutes. Eligible blobs are ordered in TanStack DB by
Chromium's size-aware disk-cache score, `age * (size + 512 bytes)`,
prioritizing blobs that are both older and larger, and then purged in bounded
batches.

## Outbox integration

An ontology action outbox entry references local blob IDs. Separate transfer
jobs:

- Read bytes from `BlobManager`.
- Upload with stable idempotency keys.
- Persist progress/resumable tokens.
- Bind resulting remote IDs.
- Retain bytes until every referencing action settles.

Transfers may execute concurrently. Action submission remains FIFO and waits
for its required transfers.

The blob package no longer owns durable upload records or
`withUploadTracking`. Outbox transfer jobs own upload execution and progress;
the blob manager only records completed remote ID mappings.
