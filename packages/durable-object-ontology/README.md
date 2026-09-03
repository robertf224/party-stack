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

Create the backend inside `blockConcurrencyWhile` or another exclusively gated
initialization path:

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
