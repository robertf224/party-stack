# @party-stack/durable-object-ontology

Cloudflare Durable Object composition for `@party-stack/sqlite-ontology`.

This package provides:

- `DurableObjectStorage.sql` and `transactionSync` bindings.
- A provider-neutral R2 attachment-byte store.
- Backend factories that default authoritative attachment bytes to R2.
- Real workerd/Miniflare SQLite and R2 conformance tests.

It does not provide a Party Stack `RuntimeAdapter`, authentication installation,
or application-defined ontology migrations.

## Backend construction

Acquire the ontology inside `blockConcurrencyWhile` or another exclusively gated
initialization path. Backend factories are lazy; schema initialization happens
when their scoped `open` Effect is acquired by the ontology:

```ts
const backend = createDurableObjectOntologyBackend({
    storage: state.storage,
    bucket: environment.BLOBS,
    installationId: state.id.toString(),
    ontologyId: "primary",
});

const ontology = await createLiveOntology({
    ir,
    context: { user: authenticatedUserId },
    backend,
});
```

Each Durable Object SQLite database must host exactly one ontology. The factory
injects an installation-and-ontology-scoped `R2AttachmentBytesStore`; SQL
tables do not add a second logical-ontology namespace.

For small/local installations that intentionally keep attachment bytes inside
SQLite:

```ts
createDurableObjectOntologyBackend({
    storage: state.storage,
    installationId,
    ontologyId,
    attachmentStorage: "sqlite",
});
```

No R2 bucket is required for inline or custom attachment storage.

Delete the complete Durable Object SQL database and its installation-scoped R2
objects with `destroyDurableObjectOntologyStorage`. Its required `quiesce`
callback must close all LiveOntology/backend instances, and destruction must run
under an exclusive Durable Object lifecycle gate. Per-attachment deletion is
available through `R2AttachmentBytesStore.delete`.

## Local fixture

```sh
pnpm --filter @party-stack/durable-object-ontology dev:fixture
```

The fixture runs locally through Wrangler/workerd and does not deploy anything
to Cloudflare. Its `primary` and `secondary` routes resolve to separate Durable
Objects, matching the one-ontology-per-Durable-Object deployment model.

## Alchemy / native ontology storage

The optional `@party-stack/durable-object-ontology/alchemy` export composes the
shared owned backend with SQLite Tables and native blob metadata. R2 bytes use
Alchemy's `ReadWriteBucketClient` directly; Files SDK is not required. The default
package export does not import Alchemy. This integration currently targets
`alchemy@2.0.0-beta.83` and Effect 4.

Acquire `makeAlchemyOntology({ ir, ontologyId, bucket, context, mutators })` in the
inner Alchemy Durable Object constructor. It returns:

- `backend`: the ordinary owned backend and its standard `protocol` source.
- `blobs`: the shared ontology-storage blob service.
- `collectGarbage`: a bounded authoritative orphan-collection pass.

Application rows, attachment references, remote ID mappings, receipts and journal
entries share SQLite transactions. R2 IO uses the shared generation/write/delete
intent machinery. The action transaction validates attachment metadata and updates
its object references atomically. GC uses the same transactional store: a committed
reference prevents collection; an upload collected first causes the action to fail.
There is no extra in-memory GC lock or persistent temporary upload root. Fresh
unreferenced uploads have the shared one-hour grace period.

The type-checked [Alchemy example](./examples/alchemy/alchemy.run.ts) defines a
bucket, a Durable Object, an authenticated Effect RPC endpoint, a Worker forwarding
to one named ontology, and hourly GC through a Durable Object alarm. It leaves an
existing alarm scheduled when the constructor runs again. Adapt the portable
[definition](./examples/alchemy/definition.ts), supply `ONTOLOGY_TOKEN` through the
Alchemy/Effect configuration environment and configure your Cloudflare account
before running Alchemy. The fixture is an authoritative owned server; an
intermediate server composes Replica rather than changing blob retention rules.

Local tests run actual Alchemy R2 binding clients against workerd SQLite/R2. They
do not provision Cloudflare resources. Cloud deployment and isolate-crash recovery
acceptance are still separate verification work. Owner-liveness recovery remains
an explicit storage configuration; unknown owners are conservatively retained.

The adapter streams known-length writes into R2. Reads currently materialize a
Blob; independent staging and streamed attachment RPCs are still pending. The
older default SQLite/DO attachment coordinator is not yet replaced by this path.
