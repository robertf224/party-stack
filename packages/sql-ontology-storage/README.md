# @party-stack/sql-ontology-storage

Ontology-aware storage using the ported Tables driver. Build a storage model from
ontology definitions and generated Effect codecs:

```ts
const model = yield * makeStorageModel({ namespace: "my-app", ir, schemas: objectSchemas });
const storageLayer = SqlStorage.layer(model, { prefix: "app_storage" });
```

Supply an Effect SqlClient layer for SQLite or PostgreSQL. Query/index planning
stays inside the database. Native application columns are a later checkpoint.
Array membership uses a JSON projection of canonical scalar keys. PostgreSQL uses
a GIN index; SQLite evaluates membership with `json_each` in the database (it does
not have a native array-element index here). SQL limits apply only when the full
predicate and ordering can run there; residual filtering always precedes limits.

The main `make(model, options)` / `layer(model, options)` expose `OntologyStorage`.
The explicit `/tables` entry retains the raw engine `make(options)` / `layer(options)`
for driver conformance and infrastructure composition. Its detailed implementation
and setup reference is in [TABLES.md](./TABLES.md).

See [ontology-storage](../ontology-storage/README.md) for the object API, transactions,
schema drift guards, and the attachment/GC boundary. This initial port does not
provide blob bytes, automatic cache eviction, or schema migrations.
