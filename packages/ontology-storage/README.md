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
        return yield* storage.query(tasks, {
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
key. `query(object, scan)` returns keyed rows; `ensureIndex(object, index)`
validates the scalar field path against the ontology. Object-reference keys are
validated, while reference existence is an execution concern. Attachment handles
round-trip as object values. Optional blob storage integrates their retention metadata into the same transaction; physical byte IO is handled separately.

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

## Full queries

Both storage services execute the Query IR from `@party-stack/ontology-spec`.
Use the same helper-built documents for multiple roots, correlated subqueries,
computed fields, conditional selections and pagination:

```ts
import { o } from "@party-stack/ontology-spec";
import { eq, field, input, selectField, sub } from "@party-stack/ontology-spec/query";

const document = {
    inputs: [{ name: "projectId", displayName: "Project", type: o.string({}) }],
    select: [
        sub("tasks", {
            from: { source: { objectType: "Task" }, binding: "task" },
            where: eq(field("task", "projectId"), input("projectId")),
            page: { limit: 20 },
            select: [selectField("id", field("task", "id"))],
        }),
    ],
};
const result = yield * storage.query(document, { inputs: { projectId: "project-1" } });
// result.tasks contains the selected projections.
```

OntologyStorage supplies object definitions, relationships and source bindings.
Raw Tables instead takes explicit bindings to record-valued tables:
`tables.query(document, { sources: { Task: taskTable }, inputs })`. It validates
source names, lexical scope, inputs and query structure, while row field types
remain dynamic. `related` and typed `lookup` require ontology metadata and are
rejected on raw Tables; explicit correlated subqueries work at either layer.

A full query uses one read transaction, or reuses the active transaction for
read-your-writes. Projections use portable ontology values, including Result
`{ kind: "ok" | "err", value }`; typed whole-object `get` and
`query(objectStore, scan)` decode through the model's Effect codecs. The latter
and `tables.query(table, scan)` remain typed single-source shorthands returning
keyed rows. Neither service exposes `loadSubset`; backend adapters retain that
capability for replication.

The shared executor lowers supported filters, ordering and windows into each
source's indexed query path and evaluates residual expressions before pagination.
This is finite execution, not query watching/IVM. SQL currently plans the lowered
source queries; a hierarchical document is not compiled into one native SQL join.

Simple unwindowed child equality correlations batch parent keys into `IN` requests
of at most 256 distinct values, then group and evaluate each parent's result.
Single-parent reads, per-parent limits/offsets/cursors, parent-dependent residual
filters and property-guarded execution retain the ordinary correlation path.
This avoids turning a per-parent window into an incorrect global limit or loading
an unbounded child region merely to apply top-K locally. Batching state lives only
for the finite execution; the reference strategy remains available for oracle tests.

Index creation streams existing rows within one transaction. IndexedDB and SQL
use 128-row batches; memory iterates its stored rows in bounded chunks. This
avoids a second table-sized row/entry array. SQL still prepares portable projection
values before native index creation; native object columns remain deferred with
schema/data migrations. An index is published only after success, and caught
failed builds remove partial entries/projections before a retry. The transaction
still lasts for the full build; this is not an online or resumable migration.

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
native transaction with service calls. Object and raw Tables service calls can
join in either direction; explicit nested boundaries still reject. Read transactions reject writes; failures,
defects, and interruption roll back. Keys, object values, index entries, and the
namespace definition stamp commit together. A failed object mutation makes the transaction rollback-only, even when its failure is caught inside the callback. Catch outside `storage.transaction(...)` to inspect the error after rollback. Complete object mutations are serialized within a transaction, including attachment-root updates. Handles expire at commit/abort;
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
and new rows on writes. Codec and query failures remain typed storage errors. Attachment-retention
failures preserve a `BlobStorageError` reason (`NotFound`, `Busy`, `Conflict`,
`InvalidValue`, `Bytes`) or pass existing storage failures through unchanged;
they are not serialization failures.

## Attachments and retention

`makeOntologyStorage(model, tables, { blobs })` updates object attachment roots
transactionally with object writes and deletes. Construct the blob service with
`makeBlobStorage` from `/blobs`, using the same Tables service and a platform byte
store. Authoritative mode protects referenced identities and bytes; replica mode
permits recoverable byte eviction independently of retained identities. Staging,
byte caching, alias mappings and GC use durable metadata and write/delete intents
so external byte IO does not hold a row transaction open.

`delete` explicitly deletes the local object. It does not infer a remote deletion
or schedule row eviction. The backend/replica owns journaling, demand, row
retention and GC scheduling; the blob service provides its own collection
operation for that lifecycle to call.

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
