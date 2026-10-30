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
API. Tests use Node's SQLite driver, PostgreSQL via PGlite, and real multi-connection PostgreSQL. Other drivers must
preserve Effect SQL's transaction/connection semantics; they have not all been
individually certified. Cloudflare Durable Object native transactions are supplied by
`@party-stack/durable-object-ontology-storage`.

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

Transactions use `SqlClient.withTransaction`. PostgreSQL snapshot reads use
`REPEATABLE READ READ ONLY` without application advisory locks. Writers use
`READ COMMITTED` with strict transaction-scoped coordination: shared key locks for
point reads, exclusive key locks for writes, and exclusive logical-table guards
for predicate reads, clears and index builds. This protects changing membership
and missing rows while allowing writes to independent keys to overlap. These
rules coordinate cooperating Tables users, including separate processes; raw SQL
writers bypass them. Predicate reads in write transactions remain conservative
and can serialize work on an entire logical table.

Use `tx.get(table, key, { forUpdate: true })` when a read will be followed by a
write. It takes write intent before reading, avoiding shared-lock upgrade
deadlocks. Memory, IndexedDB and SQLite already serialize writers and require no
additional mechanism for this hint. Confirmed PostgreSQL deadlock/serialization
aborts retry the complete callback, up to eight retries with exponential backoff.
Connection failures and ambiguous COMMIT replies are never automatically replayed.
Keep callbacks replay-safe and stage network/blob IO outside the transaction.
SQLite retains its native writer transaction; the tested Node bridge uses
`BEGIN IMMEDIATE`, including Tables read snapshots.

`insert(table, key, value)` inserts without replacement and returns false for a
key or unique-index conflict. SQL uses native `ON CONFLICT DO NOTHING`; serialized
drivers share the portable implementation. Updating an unchanged unique value
avoids a redundant range check. `allocateRevision(stream, minimum?)` allocates a
publication revision under coordination held through commit. Serialized drivers
persist the clock transactionally; PostgreSQL uses a per-stream sequence and a
short advisory publication lock. Gaps after rollback are allowed. Call it near
commit, after business writes. The owned backend uses this same journal path on
every store and derives its committed head from retained entries plus its archive
marker, rather than updating a shared head row on every action.

Run real PostgreSQL tests against a disposable database:

```sh
PARTY_STACK_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/postgres \
  vp run @party-stack/sql-ontology-storage#test
```

CI supplies a PostgreSQL 18 service for these tests. For the controlled before/after
benchmark, build this package and run `node benchmarks/postgres.mjs faa2bdbb` from
its directory with the same environment variable. It compares the old SQL/journal
coordination against the current implementation using the same portable core,
checks resulting rows, and removes its temporary schema and baseline source files.

Read [the core contract](../ontology-storage/README.md) before adding another dialect.
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
