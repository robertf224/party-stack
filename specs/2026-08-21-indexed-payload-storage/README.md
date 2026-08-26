# Indexed payload storage

## BLUF

Explore a reusable storage primitive for data split across:

1. an enumerable, transactional local collection containing metadata and an
   operation journal; and
2. a non-enumerable or independently persisted payload store containing opaque
   bytes or secrets.

This pattern already exists in the blob layer and is emerging in OAuth for
credential indexes plus `SecretStore`. Do not extract it yet. First harden the
OAuth implementation using the same recoverable operation protocol, compare
both implementations, and extract only the stable shared mechanics.

The abstraction belongs below blobs, OAuth, and connections. It is a better
solution to dangling secrets than persisting provider-specific state inside
`ConnectionManager`.

## Background

### Blob storage

The blob layer coordinates:

```text
ordinary local collection
    blob metadata
    lifecycle state
    pending/failed operation journal
              |
              v
BlobBytesStore
    opaque bytes
```

Blob writes persist intent before writing bytes, commit metadata afterward, and
recover interrupted operations under coordination leadership. Metadata also
provides enumeration for garbage collection because the bytes store is not the
authoritative index.

### OAuth storage

The OAuth layer currently coordinates:

```text
ordinary local collections
    pending state -> secret key
    userId -> secret key
              |
              v
SecretStore
    PKCE verifier
    access token
    refresh token
    scope and expiry
```

The ordinary indexes are needed because `SecretStore` intentionally exposes
only `get`, `set`, and `delete`; it cannot enumerate keys. Pending authorization
also exists before a `Connection.userId` is known.

`ConnectionManager` persists only the safe, provider-neutral projection:

```text
userId
connection status
expiration metadata
```

It must not persist tokens, PKCE verifiers, cookies, or provider client handles.

### Consistency gap

The metadata collection and opaque payload store cannot participate in one
transaction. Write ordering must therefore make every interrupted state
discoverable and recoverable.

Writing the payload before its enumerable index can orphan a payload if the
process crashes between writes. A safer protocol writes recoverable metadata
intent first.

## Proposal

### Conceptual primitive

Use a generic indexed payload store:

```ts
interface PayloadStore<Value> {
    read(key: string): Promise<Value>;
    write(key: string, value: Value): Promise<void>;
    delete(key: string): Promise<void>;
}

type IndexedPayloadOperation =
    | {
          id: string;
          kind: "write" | "delete";
          status: "pending";
      }
    | {
          id: string;
          kind: "write" | "delete";
          status: "failed";
          error: string;
      };

interface IndexedPayloadRecord<Metadata> {
    id: string;
    metadata: Metadata;
    operation?: IndexedPayloadOperation;
}

interface IndexedPayloadStore<Metadata, Payload> {
    readonly collection: Collection<
        IndexedPayloadRecord<Metadata>,
        string
    >;

    write(
        id: string,
        metadata: Metadata,
        payload: Payload
    ): Promise<void>;

    read(id: string): Promise<
        | {
              metadata: Metadata;
              payload: Payload;
          }
        | undefined
    >;

    delete(id: string): Promise<void>;
    recover(signal?: AbortSignal): Promise<void>;
    cleanup(): Promise<void>;
}
```

Names are provisional. Possible names include:

- `IndexedPayloadStore`;
- `RecoverablePayloadStore`;
- `PairedStore`;
- `ExternalPayloadStore`.

`IndexedPayloadStore` currently communicates the core requirement most
directly.

### Write protocol

```text
persist pending write intent in index
    -> write opaque payload
    -> commit metadata and clear operation
```

Recovery of an interrupted write:

```text
index exists, payload missing
    -> remove or mark failed index

index exists, payload may be partial
    -> delete payload
    -> mark failed or remove index
```

The protocol must avoid payload-without-index outcomes for newly created
records.

### Delete protocol

```text
mark delete pending in index
    -> delete payload
    -> delete index record
```

Recovery retries payload deletion before removing the index.

### Coordination

The implementation should use `RuntimeAdapter.coordination` for:

- serializing writes for one key;
- avoiding concurrent recovery;
- assigning one recovery leader where required;
- preventing refresh-token rotation or blob-write races across processes.

The exact service contract should be derived from the existing blob
coordination protocol rather than invented independently.

### Payload adapters

Domain packages adapt platform stores:

```ts
const secretPayloadStore: PayloadStore<string> = {
    read: async (key) => {
        const value = await runtime.secrets?.get(key);
        if (value === undefined) throw new Error("Secret unavailable");
        return value;
    },
    write: (key, value) => runtime.secrets!.set(key, value),
    delete: (key) => runtime.secrets!.delete(key),
};
```

```ts
const blobPayloadStore: PayloadStore<Blob> = {
    read: (key) => runtime.blobBytes.read(key),
    write: (key, value) => runtime.blobBytes.write(key, value),
    delete: (key) => runtime.blobBytes.delete(key),
};
```

### Domain layers remain responsible

The generic store must not absorb domain policy.

The blob layer continues to own:

- staged, cached, and persisted states;
- remote IDs;
- dimensions and media metadata;
- last-access tracking;
- blob garbage-collection policy.

The OAuth layer continues to own:

- PKCE state expiry;
- token serialization;
- token refresh and rotation;
- user identity resolution;
- OAuth session restoration.

The connections layer continues to own:

- safe reactive `Connection` records;
- active/inactive/needs-auth state;
- refresh scheduling;
- live session capability lifetime.

## Testing

Add shared conformance tests for every payload adapter:

- successful write/read/delete;
- failure before payload write;
- failure during payload write;
- failure after payload write but before metadata commit;
- interrupted delete;
- concurrent writes to one key;
- recovery idempotency;
- cleanup while an operation is pending;
- missing payload for a committed index;
- payload deletion failure.

OAuth-specific tests should additionally cover:

- stale pending PKCE cleanup;
- refresh-token rotation;
- callback completion after process restart;
- credential index without secret payload;
- no secret payload without a discoverable index after simulated crashes.

Blob tests remain responsible for domain-specific cache and GC behavior.

## Rollout

1. Change OAuth first-write ordering so the index is recoverable before the
   secret payload is written.
2. Add explicit OAuth recovery tests using the existing concrete code.
3. Compare the resulting OAuth protocol with blob `beginWrite`, `commitWrite`,
   `failWrite`, `purge`, and leader recovery.
4. Extract the smallest common operation journal and payload adapter surface.
5. Migrate OAuth to the shared primitive.
6. Consider migrating blob internals only if doing so reduces code without
   weakening blob-specific invariants.

Do not block current authentication work on this extraction.

## Open Questions

1. Should failed writes remain inspectable or be removed immediately?
2. Does recovery always delete partial payloads, or may domains resume writes?
3. Should payload reads update generic access metadata, or is that always
   domain-specific?
4. Does the abstraction own coordination service registration?
5. Should index records wrap domain metadata or merge operation fields into the
   domain record?
6. What guarantees can each platform `SecretStore` and `BlobBytesStore` make
   about atomic replacement of one payload?
7. Should secure stores gain namespace deletion or enumeration, or should the
   index remain the portable answer?
8. Where should the primitive live: `@party-stack/runtime`,
   `@party-stack/storage`, or a narrower internal package?

## Alternatives Considered

### Persist OAuth custom state in `ConnectionManager`

Rejected as the primary solution. Pending OAuth exists before `userId`, secrets
must not enter ordinary connection persistence, and opaque adapter state would
leak provider concerns into the generic reactive collection. It also would not
make writes to a separate `SecretStore` transactional.

### Add `list()` to `SecretStore`

This could remove a separate index on platforms that support enumeration, but
many secure stores do not provide it. Enumeration alone also does not provide
cross-store transactions or recovery.

### Store all OAuth credentials in one secret manifest

One manifest avoids separate index pointers but introduces lost-update risks,
coordination requirements, and secure-store value-size limits. Updating one
account rewrites every account's credentials.

### Keep independent ad hoc implementations

Acceptable in the short term. It becomes undesirable once OAuth and blobs have
independently implemented the same operation journal, recovery, and
coordination machinery.

## Future Work

- filesystem metadata plus opaque file contents;
- encrypted records with queryable plaintext indexes;
- downloaded local-model metadata plus model weights;
- attachment thumbnails and derived media artifacts;
- durable browser or agent artifacts indexed in ordinary persistence;
- remote object metadata paired with locally cached payloads.
