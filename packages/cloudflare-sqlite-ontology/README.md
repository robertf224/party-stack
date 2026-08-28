# @party-stack/cloudflare-sqlite-ontology

Adapts a SQLite-backed Cloudflare Durable Object to
`@party-stack/sqlite-ontology` without exposing Cloudflare types in the core
package.

```ts
import { createDurableObjectSQLiteDatabase } from "@party-stack/cloudflare-sqlite-ontology";
import { createSQLiteBackendInstallation, createSQLiteOntologyRoute } from "@party-stack/sqlite-ontology";

const database = createDurableObjectSQLiteDatabase(state.storage);

state.blockConcurrencyWhile(async () => {
    installation = await createSQLiteBackendInstallation({
        installationId: "tenant-ontology",
        database,
        connections,
        runtime,
        routes: [
            createSQLiteOntologyRoute({
                ontologyId: "host",
                ir: hostOntology,
            }),
        ],
    });
});
```

Installation cleanup and user disconnect/forget operations do not delete owned
ontology rows. Call `database.destroy()` only when deleting the entire Durable
Object installation; it delegates to `DurableObjectStorage.deleteAll()`.
