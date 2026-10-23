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

`@party-stack/durable-object-ontology-storage/alchemy` provides a DO resource factory:

```ts
import { OntologyDurableObject } from "@party-stack/durable-object-ontology-storage/alchemy";
import { Bucket } from "alchemy/Cloudflare/R2/Bucket";
import { authorizeRequest } from "./authorization.js";
import { ir } from "./ontology.js";

export const Notes = OntologyDurableObject("Notes", {
    ir,
    bucket: Bucket("Attachments"),
    authorize: authorizeRequest,
});
```

Yield `Notes` in your Alchemy Worker's initialization to obtain its namespace, then
forward requests with `notes.getByName("primary").fetch(request)`. Alchemy registers
the binding and exported DO class; application code does not extend DurableObject.
The factory supplies native SQL/R2 storage, the owned backend, authenticated Effect
RPC, a stable encryption key provisioned through Alchemy/Cloudflare Secrets Store,
and a bounded hourly GC alarm. Authorization is required for every RPC operation.
`ontologyId` defaults to the resource name; each DO instance has isolated SQL state
and its own R2 key prefix.

Options may also be an Effect resolved during Alchemy initialization, for example to
read `Config.Redacted` and construct the authorization function. `context`, `mutators`
and `queryFunctions` pass through to the shared backend. Optional `gc` settings are
`intervalMs`, `orphanGraceMs` and `limit`; `gc: false` disables collection/scheduling.
Supply `encryptionKeyring` to override the default key service. The generated 256-bit
key is retained in Alchemy deployment state and Cloudflare Secrets Store; protect both.
Do not replace/delete it while retaining ciphertext without a key-rotation plan.
There is no automatic rotation yet. The runtime imports it with WebCrypto as a
non-extractable AES-GCM key.

The default orphan grace is one hour. Reconstruction preserves an existing alarm.

The [complete Alchemy example](./examples/alchemy/alchemy.run.ts) adds a forwarding
Worker and Stack. It is an owned server. For custom handlers or replica-server
composition, `makeAlchemyOntology({ ir, ontologyId, bucket, context, mutators })`
remains available: acquire it in an Alchemy DO's inner constructor to get the shared
`backend`, `blobs` and `collectGarbage` Effect. Both entrypoints use the same services.
Declaring the resource does not deploy it; deployment remains an Alchemy operation.

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

## Supplying keys and rotating them

The default generated key is convenient for initial setup. To own its lifecycle,
supply pre-provisioned Alchemy Secrets Store resources instead:

```ts
export const Notes = OntologyDurableObject("Notes", {
    ir,
    bucket: Bucket("Attachments"),
    authorize: authorizeRequest,
    encryptionKeys: {
        active: "2026-11",
        secrets: {
            "2026-10": OldEncryptionSecret,
            "2026-11": NewEncryptionSecret,
        },
    },
});
```

Each value is a Secret resource or an Effect that resolves one, using Alchemy's
ordinary `Secret(...)` construction or `Secret.ref(...)` for an existing resource.
Secret values must contain 32 random bytes encoded as 64 hexadecimal characters.
The IDs in this map are persisted in ciphertext envelopes. All keys are read and
imported when an instance initializes; active must name a configured key. An
application can alternatively supply the lower-level `encryptionKeyring`; these
two options are mutually exclusive. Supplied keys do not create the default
Random/Secret resources.

A rotation is an explicit rollout: provision a new secret, deploy readers with
both keys while writes still use the old ID, then switch active to the new ID.
Re-encrypt current rows through ordinary journaled storage transactions in bounded
batches. Retain old keys while retained journal/outbox data, offline clients or
backups still require their ciphertext. Remove the old key only after that
retention/migration decision. Restart/reconstruct instances to load a changed key
configuration. There is no automatic row migration or key retirement.

Do not overwrite a secret's value while keeping its key ID. Alchemy should manage
the supplied resources consistently; updating a generated resource manually can
be undone by a later deployment. The first transition away from the default must
also preserve its existing v1 key/resource until its ciphertext is retired. Use
Alchemy's resource move/retention mechanisms when changing infrastructure ownership.
