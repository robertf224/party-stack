# Effect Tables

Transactional keyed tables with full Query IR execution, indexed single-table queries and secondary indexes. The storage
service is independent of TanStack DB and replication. It returns Effects; callers
choose an IndexedDB, SQL, or in-memory layer at their application boundary.

Install `@party-stack/ontology-storage`, `effect@^4.0.5`, and one of
`@party-stack/indexeddb-ontology-storage` or `@party-stack/sql-ontology-storage`.
These are new experimental infrastructure packages; the API can still change.

## Basic usage

```ts
import { Table, Tables, eq, field } from "@party-stack/ontology-storage/tables";
import { Effect } from "effect";

type Task = { title: string; projectId: string; rank: number };
const tasks = Table.make<Task>({ name: "tasks" });

const program = Effect.gen(function* () {
    const tables = yield* Tables;

    yield* tables.ensureIndex(tasks, { name: "project", field: field("projectId") });
    yield* tables.ensureIndex(tasks, { name: "rank", field: field("rank") });
    yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            yield* tx.put(tasks, "task-1", { title: "Inspect equipment", projectId: "42", rank: 1 });
            // Queries and indexes see earlier writes in this transaction.
            return yield* tx.query(tasks, {
                where: eq(field("projectId"), "42"),
                orderBy: [{ field: field("rank") }],
                limit: 10,
            });
        })
    );
});
```

Rows have explicit string or finite-number keys. `query(table, scan)` returns
`{ key, value }[]`; `get` returns the value or `undefined`. Storing an undefined
value is supported, so `get` alone cannot distinguish that value from an absent key.
Keys do not have to be embedded in values.

## Services, layers, and transactions

A **service** is the capability the program requests: `yield* Tables` obtains
transactional table storage. A **layer** constructs the implementation and supplies
its dependencies. Applications provide a layer once, rather than pass a database
connection through every function. The backend README shows complete layer wiring.

`Effect.Effect<A, E, R>` describes the success value, error type, and services a
program needs. Tables operations use `OntologyStorageError` for storage/query/codec failures;
transaction callbacks retain their own error types and service requirements.
A callback defect or interruption also rolls back its transaction.

Use `program.pipe(tables.withTransaction)` for writes and
`program.pipe(tables.withReadTransaction)` for a consistent read across tables.
Like Effect SQL's `withTransaction`, service operations reuse the transaction in
the current Effect context, so helpers can compose without passing a transaction
handle through every function:

```ts
const changeTask = Effect.gen(function* () {
    const tables = yield* Tables;
    yield* tables.put(tasks, "task-1", { title: "Inspect equipment", projectId: "42", rank: 1 });
    return yield* tables.query(tasks, { where: eq(field("projectId"), "42") });
});
const atomicChange = Effect.gen(function* () {
    const tables = yield* Tables;
    return yield* changeTask.pipe(tables.withTransaction);
});
```

`tables.transaction(tx => effect)` and `tables.read(tx => effect)` remain explicit
handle conveniences. Both styles share the same context; service calls within a
callback reuse its transaction. Outside a transaction, each operation opens one.
Nested transaction boundaries/savepoints are unsupported and fail explicitly.
A read transaction cannot be upgraded to a write transaction. Handles expire at
commit/abort. Join concurrent child work before leaving the transaction.

Queries, row changes, index definitions, and index updates share the same physical
transaction. Operations within a transaction are serialized, including concurrent
Effects, so uniqueness checks cannot race within that transaction. Keep callbacks
short and confined to local work; run networking and other external side effects
outside them. Only a successful database commit completes the returned Effect.

## Values and optional codecs

No Effect Schema or Effect Data declaration is required. The default portable
value codec supports:

- Nested plain objects and arrays, strings, booleans, null, and finite numbers.
- Bigint, undefined, valid Date, Temporal.Instant, and Temporal.PlainDate.
- Map and Set, including nested supported values.

The default codec is a tagged value tree validated and serialized with Effect's
`Schema.fromJsonString`. Every container is wrapped, so application objects and
arrays cannot collide with storage tags. There is no reference graph or `Atom`
format. Repeated object references are stored as independent values. Cycles,
buffers/views, RegExp, functions, symbols, non-finite numbers, invalid dates,
other Temporal kinds, and custom class instances require a suitable explicit
application codec or are rejected. Null-prototype input objects decode as ordinary
objects. Sparse array holes become explicit undefined elements, and negative zero
follows JSON number semantics. These identity/prototype details are not storage
contracts.

This replaces the unreleased graph-format prototype (storage version 1) with tree
format version 2. It does not silently decode the old format. No released data
migration is implied; existing development databases from the prototype must be
reset or explicitly migrated before reuse.

Optional application codecs map domain instances to/from this supported value
set. They need not use Effect Schema. Table versions still guard representation
changes. See the [schema/migration proposal](../../specs/2026-10-19-effect-tables-replica/schema-migrations.md)
for future declared SQL schemas; the current SQL layout remains encoded rows plus
native scalar projections.

## Full query documents

`tables.query(document, { sources, inputs, context })` executes the same
`QueryDocument` as OntologyStorage. Bind source names explicitly, for example
`{ sources: { Task: tasks, Project: projects } }`. Sources are record-valued
readable table descriptors; their `encode` functions are not needed for querying.
Multiple roots, explicit correlations, projections, conditional selections and
nested pagination share one snapshot. Source names and lexical scope are checked;
row field types remain dynamic. Relationship and typed-reference shortcuts need
ontology metadata: use OntologyStorage for `related` and `lookup`, or express
an explicit correlated subquery here. See the [storage README](./README.md#full-queries).

## Single-table queries and indexes

Standalone helpers provide `eq`/`ne`, `lt`/`lte`/`gt`/`gte`, `inArray`,
`like`, `ilike`, `isNull`/`isUndefined`, and `and`/`or`/`not`. The optional `where`
namespace exposes the same helpers (`where.in` for membership). Field paths are
tagged references (`field("address", "city")`), so dots in names are unambiguous.
`field("status")` produces `{ _tag: "Field", path: ["status"] }`. Scalars are
always literals in either position: `eq("status", "active")` compares two literals;
`eq("active", field("status"))` and `eq(field("status"), "active")` read the field.
Field-to-field comparisons such as `lt(field("used"), field("budget"))` are also
supported. LIKE/ILIKE can read a pattern from a field; these dynamic patterns use
residual evaluation. `inArray` accepts a reference or literal on the left and a
literal scalar array on the right. No arbitrary JavaScript or SQL expressions are
accepted. The public `prefix` predicate has been removed: use `like(field, "abc%")`.
Literal `%`/`_` cannot be escaped in this wildcard syntax.

`like` uses `%` for any sequence and `_` for one UTF-16 code unit. `ilike` uses
JavaScript lowercase normalization on both the value and pattern, matching
TanStack's evaluator. Backslashes and regexp punctuation are literal characters;
there is no additional escape syntax. Missing/non-string fields do not match.
This shorthand uses the physical predicate AST. For computations and hierarchical
correlation, pass a full QueryDocument instead. Locale collations are not exposed. Null and
undefined use explicit two-valued comparisons (`eq(field, null)` and
`eq(field, undefined)`); SQL's implicit three-valued null logic is not exposed.

Orders support multiple fields, asc/desc, offset/limit, and exclusive keyset cursors
containing every sort value plus the row key. Use `cursorOf(row, query)` to form one.
Keys break sorting ties in ascending order, including descending field orders.

Queryable/indexable values use this total type order: undefined, null, boolean,
finite number, bigint, valid Date, string, Temporal.Instant, Temporal.PlainDate.
Strings use UTF-16 lexical order, not locale collation. Temporal instants compare
nanoseconds; plain dates compare ISO dates. Object-valued fields cannot be used as indexed or compared scalar values, although
objects can be persisted elsewhere in a row. Non-finite numbers and invalid dates
are rejected by the default codec. A missing field is undefined.
Unique indexes consider null/undefined ordinary values, so duplicates also conflict.

Index declarations are persisted by durable backends. The optional `/planner`
export implements queries over ordered index entries for IndexedDB and memory: count-based selectivity estimates, bounded entry
batches, empty-intersection short circuits, selective-first AND plans, OR unions,
and residual evaluation. Each index has an internal lowercase companion for
`ilike`. A finite single-field ordered query narrows its scan using conjunctive
bounds and cursors. Descending scans restore ascending key order within tied
values, including the complete boundary group. A small selective candidate set
can be cheaper to hydrate and sort than scanning the ordering index.

SQL creates native JSON expression indexes and compiles supported predicates,
ordering, cursors, and pagination into SQL. Its database engine owns planning;
it does not import the optional planner. Rich payloads remain in the portable value-tree
format, with a separate sortable scalar projection for declared index fields.
Complex wildcard patterns use a necessary SQL prefix bound and the shared exact
residual evaluator. Undeclared fields also require residual evaluation. SQL never
applies limit/offset before residual checks; fully supported queries paginate in
the engine. See the backend READMEs for physical layouts and verification.

Logical index creation does not upgrade the IndexedDB database. Creating an index
backfills the table within one transaction and should be performed deliberately.
The source is consumed incrementally: memory uses bounded iterator chunks;
IndexedDB/SQL use 128-row pages. Failed builds clean up unpublished entries or
projections, including when callers catch the error and retry. SQL uniqueness
checking and physical index creation use native database operations. The portable
projection preparation still runs in JavaScript; the full table is not buffered.

Index names identify immutable definitions. Repeating the same declaration is
idempotent; changing its path/uniqueness under the same name fails. Physical SQL
index/key-size limits still apply to very large indexed strings or keys.

## Optional memory backend and planner

```ts
import * as Memory from "@party-stack/ontology-storage/memory/tables";

await Effect.runPromise(program.pipe(Effect.provide(Memory.layer)));
```

Each `Memory.make()` creates an independent database. Retain one service/runtime
for as long as its state should live. The backend has the same transaction,
rollback, codec, index, subset-query, and overlay contracts. Transactions serialize
through a semaphore and use copy-on-write snapshots of touched row/index buckets.
Sorted arrays provide binary-search index lookups; insert/delete maintenance is
linear, so this is an initial memory backend rather than a specialized B-tree.

A SharedWorker can own one service and expose requests to several tabs. That
shares state across those tabs while the worker lives. Contents are lost on
worker termination. Installation worker ownership and protocol replicas are
implemented above this package, in web-runtime and ontology-replica.

`@party-stack/ontology-storage/planner` is a backend-implementor subpath for the shared
candidate planner and query executor. IndexedDB and memory import it explicitly.
The main entry point and SQL adapter import neither `/planner` nor `/memory`, so
SQL consumers do not pull those implementations into their runtime bundle.
A separate planner package adds no useful dependency boundary at this stage.

## Typed failures

Operations fail with `OntologyStorageError`, following Effect SQL's stable envelope plus
tagged reason pattern. The outer error and every reason are `Schema.TaggedError`
classes; `OntologyStorageErrorReason` is both their TypeScript union and a `Schema.Union`.
Call sites construct an explicit reason. No classification is guessed from an
operation label. `error.cause` is the reason error; `error.reason.cause` retains
an original codec/backend exception when one exists.

| `reason._tag`        | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `QueryError`         | Invalid pagination, cursor, key, or query scalar                    |
| `BlobStorageError`   | Attachment retention/bytes failure; inspect `kind` and retryability |
| `CodecError`         | Encode/decode failure, with `direction`                             |
| `UniqueConstraint`   | A duplicate value, with `table` and `index`                         |
| `SchemaMismatch`     | Stored version differs, with `table`, `expected`, `actual`          |
| `IndexError`         | Invalid index or a changed immutable definition                     |
| `TransactionError`   | `Closed`, `Nested`, `ReadOnly`, or backend transaction failure      |
| `ConfigurationError` | Invalid backend configuration                                       |
| `StorageError`       | Backend failure; inspect the preserved native/Effect SQL cause      |

```ts
const handled = tables
    .put(tasks, key, value)
    .pipe(
        Effect.catchReason("OntologyStorageError", "UniqueConstraint", (reason) =>
            Effect.log(`Duplicate value in ${reason.table}/${reason.index}`)
        )
    );
```

Reasons are independently yieldable and schema-backed. You can also use
`Effect.unwrapReason("OntologyStorageError")` followed by `Effect.catchTag`, or serialize
errors using `Schema.encodeSync(OntologyStorageError)` and validate/reconstruct them with
`Schema.decodeUnknownSync(OntologyStorageError)`. Error schemas do not impose schemas on
application rows. The same distinction applies to internal value-tree,
overlay-record, and index-metadata schemas: these validate our persisted protocol,
while application codecs remain optional.

Business failures returned from a transaction keep their own typed error channel;
defects and interruption also roll it back. A caught SQL statement failure still
makes the whole transaction fail, because PostgreSQL cannot commit an aborted
transaction. `isRetryable` uses explicit retry metadata supplied by the SQL
driver; Tables never retries automatically. Retrying an entire user callback
requires the caller to account for its side effects.

## Sparse overlay composition

The separate `@party-stack/ontology-storage/overlay` export combines two ordinary
tables. It adds no sync protocol or outbox behavior to Tables:

```ts
import { overlay, loadVisible, putVisible, deleteVisible } from "@party-stack/ontology-storage/overlay";

const visibleTasks = overlay(tasks, { name: "task-overrides" });
const readVisible = Effect.gen(function* () {
    const tables = yield* Tables;
    return yield* tables.transaction((tx) =>
        Effect.gen(function* () {
            yield* deleteVisible(tx, visibleTasks, "task-1");
            yield* putVisible(tx, visibleTasks, "local", { title: "Draft", projectId: "42", rank: 0 });
            return yield* loadVisible(tx, visibleTasks, {
                orderBy: [{ field: field("rank") }],
                limit: 10,
            });
        })
    );
});
```

Every override shadows its base key, even if the replacement fails the query
predicate. Tombstones suppress base rows. Ordering/pagination is applied to the
final merged view. For finite windows, the helper overfetches base candidates by
the number of shadowed keys so early deletions do not produce an incorrect short
page. It loads the entire sparse override table: callers must bound that table.
Both sources must be read through the same `read`/`transaction` callback.

## Migrations and boundaries

Automatic application migrations are deferred. A table's optional `version`
(default 1) is recorded on its first access in a write transaction. A mismatched version
fails; it does not reinterpret old rows, migrate them, or reset data. Use a new
namespace or an explicit application migration after designing that migration.
Internal value-format changes belong to this library; application data changes
belong above it. The current physical layouts are version 1.

Replication checkpoints, commit streams, global Replica revisions, demand,
retention, and outbox replay are intentionally left to the next layer. TanStack is a demand/view integration above the replica, rather than the owner
of this storage layer or its persistence.

## Validation

`@party-stack/ontology-storage/testing` exports the shared `runContract` Effect for
backend implementations. It runs on memory, fake IndexedDB, native Chromium,
Node SQLite, and PostgreSQL via PGlite. It includes cross-table atomicity,
read-your-writes, interruption/defect rollback, concurrent writers, index/query
agreement, rich values, and sparse-overlay queries against a full-data oracle.
Browser coverage currently certifies Chromium, not Safari or Firefox.

## Driver API and source layout

`@party-stack/ontology-storage/driver` is the supported adapter authoring API, replacing
an ambiguously named `/internal` export. It exposes the `Driver`/`DriverTransaction`
contract, stored row/index/entry/range types, storage encodings, explicit error
constructors, and `makeTables`. Normal applications use the main service API.
Private implementation modules are excluded from the package export map.

Source folders separate `query` evaluation/validation, `planner` candidate planning,
`storage` value encoding and metadata schemas, and the optional `memory`, `overlay`,
and `testing` entry points. `/planner` stays separate from the main import graph.
