# SQL Tables

`@party-stack/ontology-storage` implemented through Effect's `SqlClient`. The current
supported dialects are SQLite and PostgreSQL; other dialects fail explicitly.
Supply the concrete Effect SQL driver in your application.

```ts
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Table, Tables } from "@party-stack/ontology-storage/tables";
import * as SqlTables from "@party-stack/sql-ontology-storage/tables";
import { Effect, Layer } from "effect";

const storage = SqlTables.layer().pipe(Layer.provide(SqliteClient.layer({ filename: "app.sqlite" })));
const drafts = Table.make<{ title: string }>({ name: "drafts" });
const program = Effect.gen(function* () {
    const tables = yield* Tables;
    yield* tables.put(drafts, "draft-1", { title: "Inspect equipment" });
    return yield* tables.get(drafts, "draft-1");
});
await Effect.runPromise(program.pipe(Effect.provide(storage)));
```

A PostgreSQL driver layer can replace the SQLite driver without changing the Tables
API. Tests use Node's SQLite driver and PostgreSQL via PGlite. Other drivers must
preserve Effect SQL's transaction/connection semantics; they have not all been
individually certified. Cloudflare Durable Object native transaction integration
is not supplied in this checkpoint.

The layer initializes two physical tables plus native expression indexes. Their
prefix defaults to `party_tables` and can be configured with `{ prefix: "app" }`.
Prefixes are 1–40 lowercase ASCII letters/digits/underscores, starting with a
letter. Row values are bound parameters. Logical names in native index/query predicates are escaped SQL literals so the planner can match partial expression indexes.
The existing database connection/pool remains owned by the supplied driver layer.

Rows use the same portable value-tree codec as IndexedDB. A separate JSON scalar
projection contains portable ASCII sort keys for each declared field index and
its JavaScript-lowercase companion. SQLite uses `json_extract`; PostgreSQL uses
JSONB `->>`. Index DDL and query compilation use identical expressions with binary
collation, allowing the engine to select native B-tree indexes. Rich value-tree values,
arbitrary-precision bigint, and nanosecond Temporal comparisons retain their
portable semantics instead of being cast to SQL numbers or timestamps.

`ensureIndex` validates/backfills the projection and creates native expression
indexes atomically. Writes replace the complete projection; SQL maintains its
indexes. Unique indexes exclude the row-key tie breaker and preserve the Tables
contract that null/undefined are ordinary comparable values. There is no SQL
user-space entries table or JavaScript mini planner.

Fully supported queries push predicates, ordering, exclusive cursors, and
pagination into the engine. Complex LIKE/ILIKE patterns push a necessary prefix
bound; undeclared fields and unsupported portions remain exact JavaScript
residuals. AND can retain supported conjuncts. OR/NOT never use an unsafe partial
predicate. Queries with residuals fetch candidates before applying final
filtering/pagination; they may read more rows. This allows the same wildcard and
Unicode normalization semantics on both engines without relying on SQLite's
case-insensitive LIKE default or database-specific locale behavior. Define indexes
for fields whose filtering/ordering should run entirely in SQL.

The package tests actual `EXPLAIN QUERY PLAN` / `EXPLAIN (FORMAT JSON)` output on
SQLite and PGlite PostgreSQL to verify native index use, and compares residual
pagination with a full-data oracle. Driver field-name transforms are disabled for
internal queries. Logical tables share physical row/definition tables; this does
not map application fields to user-authored SQL columns.

Transactions use `SqlClient.withTransaction`. PostgreSQL additionally takes a
transaction-scoped advisory lock per Tables prefix, serializing Tables operations
across instances. SQLite relies on its exclusive writer transaction; the tested
Node driver uses `BEGIN IMMEDIATE`, including Tables read snapshots. Keep callbacks
short. Writes that bypass Tables are outside these consistency guarantees.

Read [the core contract](../effect-tables/README.md) before adding another dialect.
In particular, stored bigint values are not limited to signed 64-bit SQL integers,
unique null/undefined semantics are explicit, and index/key size limits still apply.
Application migrations and additional SQL dialects can be layered on later.

## SQL construction and backend use

Values in CRUD statements use Effect SQL parameter binding. Compiled subset
predicates, cursors, limits, and offsets also use parameters. Operators and order
directions are whitelisted by the shared query schema before compilation; field
references contain data paths, never SQL expressions. Logical index names become
hex-only projection keys, and generated physical identifiers are quoted. The
physical prefix has a strict ASCII allowlist and length bound.

The partial-index table constant must match DDL and SELECT exactly, so it is a
literal rather than a bind parameter. SQLite string literals double single quotes; PostgreSQL
uses explicit `E` strings escaping both backslashes and quotes, including when
`standard_conforming_strings=off`. The few `sql.unsafe`/`sql.literal` calls compose
these controlled fragments; they do not expose a raw SQL API to Tables callers.
Adversarial tests exercise names, keys, payloads, predicates, and malformed ASTs
against SQLite and PGlite PostgreSQL, alongside native index-plan tests.

SQL injection protection does not authorize access to arbitrary tables or rows.
A backend must choose table descriptors and enforce tenant/row authorization and
query budgets before executing client requests. This layer does not impose a
network protocol or authorization policy.
