# @party-stack/sqlite-ontology

Provider-neutral authoritative SQLite backend for Party Stack ontologies.

## Installations and namespaces

`createSQLiteBackendInstallation` composes the generic
`createOntologyBackendInstallation` contract with one or more
`createSQLiteOntologyRoute` definitions. Route-generated SQL namespaces use an
injective UTF-8 encoding, so IDs such as `a-b` and `a_x2d_b` cannot share
tables. A manually supplied safe adapter `name` keeps its legacy table
namespace; the database namespace registry rejects conflicting claims.

## Storage migrations

Routes accept ordered `migrations` and a target `storageVersion`:

```ts
createSQLiteOntologyRoute({
    ontologyId: "host",
    ir: hostIR,
    storageVersion: 2,
    migrations: [
        { version: 1, name: "initial", up() {} },
        {
            version: 2,
            name: "normalize-records",
            up({ database, objectTableName }) {
                database
                    .prepare(`UPDATE "${objectTableName("Record")}" SET data = ? WHERE id = ?`)
                    .run(nextData, id);
            },
        },
    ],
});
```

Applied versions are stored in `party_stack_migrations` by SQL namespace. The
migration, schema signature update, and ledger row are committed atomically.
Failures roll back and remain retryable. `PRAGMA user_version` is not used.
Changing an object schema without a newly applied migration is rejected.

## Attachments

Inline SQLite BLOBs are the default. To use an external authoritative store,
pass `attachmentStorage.external.bytes`, which implements the provider-neutral
`BlobBytesStore` contract. Bytes upload before the SQL transaction. A failed SQL
commit leaves an entry in `party_stack_attachment_orphans`; call
`collectSQLiteAttachmentOrphans` to remove unreferenced external bytes.
Collectors use exclusive claim tokens. After an isolate failure, call
`recoverSQLiteAttachmentOrphanClaims` during exclusive initialization before
resuming collection.

Attachment identity is `(ontology namespace, attachment ID)`, allowing the same
ID in multiple logical ontologies. Legacy rows without an ontology require an
explicit `legacyAttachmentSqlNamespace`; initialization never assigns them
according to route startup order.

## Lenses

`lensBindings` expose source object tables through PR #106 lens projection.
Schema and runtime values project to the target model while source rows remain
unchanged. Target query paths can be mapped with
`mapTargetPathToSourceWithLens`. Reverse writes are rejected explicitly until a
write-capable inverse lens contract exists.
