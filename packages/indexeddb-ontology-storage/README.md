# @party-stack/indexeddb-ontology-storage

Ontology-aware storage using the ported Tables driver. Build a storage model from
ontology definitions and generated Effect codecs:

```ts
const model = yield * makeStorageModel({ namespace: "my-app", ir, schemas: objectSchemas });
const storageLayer = IndexedDbStorage.layer(model, { databaseName: "my-app" });
```

Supply `IndexedDb.layerWindow` from `@effect/platform-browser/IndexedDb` in a
browser, or an injected IndexedDb platform in tests. Transactions retain the
existing request scheduling/commit handling and user-space index planner.

The main `make(model, options)` / `layer(model, options)` expose `OntologyStorage`.
The explicit `/tables` entry retains the raw engine `make(options)` / `layer(options)`
for driver conformance and infrastructure composition. Its detailed implementation
and setup reference is in [TABLES.md](./TABLES.md).

See [ontology-storage](../ontology-storage/README.md) for the object API, transactions,
schema drift guards, and the attachment/GC boundary. This initial port does not
provide blob bytes, automatic cache eviction, or schema migrations.
