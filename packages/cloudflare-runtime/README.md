# @party-stack/cloudflare-runtime

Cloudflare Durable Object runtime services for Party Stack. This package owns
runtime-local persistence, single-isolate coordination, namespace-scoped
secrets, and R2-backed `BlobBytesStore` instances. Ontology SQL remains in
`@party-stack/sqlite-ontology`; the Durable Object SQL port remains in
`@party-stack/cloudflare-sqlite-ontology`.

Runtime collection persistence delegates to
`@tanstack/cloudflare-durable-objects-db-sqlite-persistence`; Party Stack adds
collision-safe owner/namespace scoping and surgical namespace destruction.

## Durable Object construction

Create the runtime and authenticated installation under
`blockConcurrencyWhile` so migrations and restored connections complete before
requests are accepted:

```ts
import { DurableObject } from "cloudflare:workers";
import { createBetterAuthConnectionAdapter } from "@party-stack/better-auth";
import {
    createCloudflareSQLiteBackendInstallation,
    createCloudflareSQLiteOntologyRoute,
} from "@party-stack/cloudflare-runtime";

export class OntologyCellDO extends DurableObject<Env> {
    private readonly installation = this.ctx.blockConcurrencyWhile(() =>
        createCloudflareSQLiteBackendInstallation({
            installationId: this.ctx.id.toString(),
            storage: this.ctx.storage,
            bucket: this.env.BLOBS,
            connections: createBetterAuthConnectionAdapter({
                client: this.env.AUTH_CLIENT,
            }),
            routes: ["primary", "secondary"].map((ontologyId) =>
                createCloudflareSQLiteOntologyRoute({
                    ontologyId,
                    ir: ontologyId === "primary" ? primaryIR : secondaryIR,
                    storageVersion: 2,
                    migrations: ontologyMigrations,
                })
            ),
        })
    );
}
```

`context.user` always comes from the active backend connection. Database
selection receives only the logical ontology ID, so Better Auth sessions and
physical SQLite placement remain separate.
The high-level factory defaults every route to authoritative R2 attachment
bytes. Set `attachmentStorage: "sqlite"` on a route only when inline SQLite
BLOBs are intentional.

## Storage and lifecycle

- Runtime collections are persisted in the Durable Object SQLite database and
  reconstructed after isolate eviction.
- A runtime host grants one active lease per `(owner, namespace)`. Reusing a
  scope requires cleaning up its previous lease first, preventing duplicate
  hosted coordination services.
- Every runtime `(owner, namespace)` receives independent R2 keys, secrets, and
  `SingleProcessCoordination`.
- `runtime.cleanup()` releases in-memory coordination only.
- `runtime.destroy()` deletes only that runtime namespace's collection rows,
  secrets, and R2 objects. It never calls `deleteAll()`.
- `host.destroyInstallation()` deletes all installation R2 objects and then
  calls `DurableObjectStorage.deleteAll()`. Reserve it for deleting the complete
  Durable Object installation.

## SQLite migrations and attachments

`createSQLiteOntologyRoute` derives an injective SQL namespace from the logical
ontology ID. Explicit safe adapter names retain their existing table names.
Legacy global attachment rows require
`attachmentStorage.legacyAttachmentSqlNamespace`; they are never assigned based
on route startup order.

Ontology storage migrations use `party_stack_migrations`, keyed by SQL namespace
and ordered integer version. A migration and its ledger row run in the same
synchronous SQLite transaction. Failed migrations roll back and can be retried.
Changing an IR without applying a new migration remains an error.

Inline SQLite bytes remain the default. External authoritative bytes use this
consistency protocol:

1. Journal the deterministic external key in
   `party_stack_attachment_orphans`.
2. Upload bytes idempotently to the configured `BlobBytesStore`.
3. Commit attachment metadata, object references, and orphan-journal removal in
   one SQLite transaction.
4. Run `collectSQLiteAttachmentOrphans` to delete unreferenced bytes safely.

SQL and R2 cannot form one atomic transaction. The pre-upload journal makes
crashes and either-side failures recoverable; deterministic keys make retries
idempotent.

## Local fixture

Run the complete installation/runtime path locally with workerd, Durable Object
SQLite, and Miniflare R2:

```sh
pnpm --filter @party-stack/cloudflare-runtime dev:fixture
```

Then create and query a note:

```sh
curl -X POST http://localhost:8787/cells/acme/ontologies/primary/notes \
  -H 'content-type: application/json' \
  -H 'x-user-id: alice' \
  -d '{"id":"note-1","title":"Local Durable Object"}'

curl http://localhost:8787/cells/acme/ontologies/primary/notes \
  -H 'x-user-id: bob'
```

Stop and restart the command to verify reconstruction from persisted local
state. The fixture never deploys to Cloudflare.
