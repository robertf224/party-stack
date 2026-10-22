# @party-stack/durable-object-ontology-storage

Cloudflare platform bridges for the shared SQL ontology storage and blob services.
The package replaces the previous Durable Object/SQLite attachment coordinator;
there is no separate DO action, retention, or garbage-collection implementation.

## Storage composition

The root export provides:

- `sqlLayer(state.storage)`: Effect `SqlClient` over DO SQLite and native transactions.
- `makeR2Bytes` / `r2BytesLayer`: `BlobBytes` backed by Alchemy's `ReadWriteBucketClient`.
- `makeDurableObjectOntologyStorage`: shared SQL Tables and authoritative BlobStorage,
  with an optional byte service. Omitting `bytes` uses inline SQLite bytes.
- `destroyDurableObjectOntologyStorage`: whole-installation destruction, after the
  caller closes every storage user inside an exclusive lifecycle gate.

For example, inside a scoped Effect with Alchemy's RuntimeContext available:

```ts
const bytes =
    yield *
    makeR2Bytes({
        bucket, // Alchemy ReadWriteBucketClient
        installationId: state.id.toString(),
        ontologyId: "primary",
    });
const storage =
    yield *
    makeDurableObjectOntologyStorage({
        storage: state.storage,
        ontologyId: "primary",
        bytes,
    });
const backend =
    yield *
    makeStorageOntologyBackend({
        ir,
        namespace: "primary",
        ...storage,
    });
```

Supply another `BlobBytes` service to use another byte store. The SQL and R2
layers can also be composed independently; attachment metadata always belongs to
the same Tables service as application rows. One Durable Object hosts one ontology.
This package targets `alchemy@2.0.0-beta.83` and Effect 4.

## Alchemy construction

`@party-stack/durable-object-ontology-storage/alchemy` adds
`makeAlchemyOntology({ ir, ontologyId, bucket, context, mutators })`. Acquire it in
Alchemy's inner Durable Object constructor. It uses the same root SQL/R2 bridges
and returns the shared owned `backend`, `blobs`, and a bounded `collectGarbage`
Effect. It does not declare or deploy a Cloudflare resource itself.

The type-checked [Alchemy resource example](./examples/alchemy/alchemy.run.ts)
provides the full wiring: bucket, DO class, authenticated Effect RPC endpoint,
forwarding Worker, and hourly GC alarm. Existing alarms survive constructor reentry.
Adapt its definition and authorization for your application. The example is an
owned server; an intermediate server composes Replica with the same storage.

Rows, attachment references, ID mappings, receipts, and journal entries share SQL
transactions. R2 IO uses the common write/delete intents. An action validates its
attachments and writes references transactionally, so GC either observes the
reference or wins first and the action fails. Fresh unreferenced uploads have the
shared one-hour grace period. There is no additional upload lease or GC mutex.

DO-exclusive ownership lets recovery identify owners from a previous incarnation;
it does not infer death from an elapsed timeout. Other platforms must supply their
own liveness proof or conservatively retain unknown owners.

R2 writes stream with a known length. Reads currently materialize a Blob;
range caching, resumable uploads and direct byte grants remain future work.

## Local verification

```sh
pnpm exec vp run -F @party-stack/durable-object-ontology-storage test
pnpm --filter @party-stack/durable-object-ontology-storage dev:fixture
```

The inline SQLite fixture routes ontologies to separate DOs. Workerd/Miniflare
conformance tests also exercise the real Alchemy R2 clients. They do not deploy or
provision Cloudflare resources.
