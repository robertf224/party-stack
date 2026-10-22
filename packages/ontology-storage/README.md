# Ontology Storage

Effect-based owned storage derived from `@party-stack/ontology-spec` definitions.
This ports the experimental Effect Tables engine, including its query planner,
secondary indexes, transactions, and driver conformance suite. There is no second
schema language to author: use the ontology IR and its generated Effect codecs.

```sh
ontology-spec generate --ontology ./ontology.ts --outDir ./generated --no-live --effect
```

`generated/effect.ts` exports codecs and model types; `effect-types.ts` supplies
recursive type declarations. Portable `types.ts` and the authored IR remain
independent of Effect and can support future language generators.

```ts
import { OntologyStorage, makeStorageModel, eq, field } from "@party-stack/ontology-storage";
import * as Memory from "@party-stack/ontology-storage/memory";
import { Effect } from "effect";
import { objectSchemas, type Task } from "./generated/effect.js";
import ir from "./ontology.js";

const program = Effect.gen(function* () {
    const model = yield* makeStorageModel({ namespace: "my-app", ir, schemas: objectSchemas });
    const tasks = model.objects.Task;
    const work = Effect.gen(function* () {
        const storage = yield* OntologyStorage;
        yield* storage.ensureIndex(tasks, { name: "project", field: field("projectId") });
        return yield* storage.loadSubset(tasks, {
            where: eq(field("projectId"), "project-1"),
            limit: 20,
        });
    });
    return yield* work.pipe(Effect.provide(Memory.layer(model)));
});
```

Use the `sql-ontology-storage` or `indexeddb-ontology-storage` layer for persistence.
When definitions arrive at runtime, omit `schemas` to derive codecs from the IR:

```ts
const model = yield * makeStorageModel({ namespace: "my-app", ir });
```

Runtime-derived codecs use the same portable/Effect value conversion as generated
codecs. Supply generated schemas when named static object types are available.

A service is the storage capability obtained with `yield* OntologyStorage`; a
layer constructs its implementation and supplies it to your program. SQL requires
an Effect SqlClient layer; IndexedDB requires the platform IndexedDb layer.

`get(object, key)` returns an object or undefined. `put(object, value)` derives
its key from the ontology primary-key property and validates both the object and
key. `loadSubset(object, query)` returns keyed rows; `ensureIndex(object, index)`
validates the scalar field path against the ontology. Object-reference keys are
validated, while reference existence is an execution concern. Attachment handles
round-trip as object values; this checkpoint does not store their bytes.

Indexes and query field paths use the portable ontology representation, including
`outcome.kind` for result values. The service converts Effect Result values at
read/write boundaries, so `_tag` is not a portable query path. Nested Temporal
values preserve their precision. Integer keys remain signed 32-bit numbers.

`contains(field("labels"), "urgent")` tests membership in a scalar-array field;
`inArray(field("status"), ["open", "closed"])` tests a scalar against a literal
list. An array index uses `{ name: "labels", field: field("labels"), multiEntry: true }`.
It stores each distinct element once per row and updates atomically with the row.
Unique array-element indexes are not supported. Owned backends and replicas lazily
ensure query indexes for declared top-level fields; dynamic paths do not create
unbounded index definitions from query input.

## Transactions and schema identity

```ts
const storage = yield * OntologyStorage;
yield *
    storage.transaction((tx) =>
        Effect.gen(function* () {
            yield* tx.put(model.objects.User, user);
            yield* tx.put(model.objects.Task, task);
        })
    );
```

Both callback transactions and `effect.pipe(storage.withTransaction)` share the
native transaction with service calls. Read transactions reject writes; failures,
defects, and interruption roll back. Keys, object values, index entries, and the
namespace definition stamp commit together. Handles expire at commit/abort;
nested transaction boundaries are rejected. Keep network and blob I/O outside
transaction callbacks.

Storage namespaces are isolated. Opening an existing namespace with different
object definitions or value types fails with `OntologyStorageError` and a
`DefinitionMismatch` reason; no migration or data rewriting occurs implicitly.
Presentation metadata and definition ordering do not change the storage identity.
Migration execution is a future checkpoint. A model copies/freezes its definitions,
and tokens from another model are rejected.

When supplying generated codecs, the IR and codecs must come from the same generation. Model setup checks
object names and primary keys; it does not prove an arbitrary hand-authored Effect
codec is equivalent to the entire ontology. Existing rows are validated on reads
and new rows on writes. Codec and query failures remain typed storage errors.

## Attachments and retention

Owned rows and sole copies of attachment bytes must not be cache-evicted. Replica
rows and remotely recoverable blob bytes can have independent policies. This
checkpoint has no automatic collector, retention timer, reference cascade, or
remote deletion side effect. `delete` is an explicit physical object operation;
the backend/Replica engine will distinguish authoritative deletion from eviction
and update its own change log, coverage, and retention records accordingly.

See the [attachment and GC design](../../specs/2026-10-19-effect-tables-replica/attachments-gc.md)
for staged uploads, operation fencing, independent byte/row eviction, and subset
coverage invalidation. No blob-byte or migration API is promised by this port.

## Engine entry points

`/tables` exposes the ported dynamic engine to drivers and advanced infrastructure;
`/driver`, `/planner`, `/overlay`, and `/testing` keep their existing roles.
`/memory/tables` exposes the raw memory engine. Application storage imports use the
main entry and ontology object tokens. The old engine reference is in [TABLES.md](./TABLES.md).
The main entry does not import memory, IndexedDB, SQL, TanStack, or codegen tooling.

SQL currently retains the shared rows table and JSON projections, with native
SQLite/PostgreSQL planning and indexes. Native
per-property SQL columns remain future work. The former SQLite ontology wrapper
has been replaced by the shared storage backend composition; Durable Object SQL/R2
bridges live in `@party-stack/durable-object-ontology-storage`.
