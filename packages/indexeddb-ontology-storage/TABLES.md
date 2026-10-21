# IndexedDB Tables

Browser implementation of `@party-stack/ontology-storage`, using Effect's browser
IndexedDb service for injectable platform primitives. It owns three fixed physical
stores for rows, definitions, and user-space index entries. Logical tables and
indexes can be created without changing the browser database version.

```ts
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import * as IndexedDbTables from "@party-stack/indexeddb-ontology-storage/tables";
import { Tables, Table } from "@party-stack/ontology-storage/tables";
import { Effect, Layer } from "effect";

const storage = IndexedDbTables.layer({ databaseName: "my-app-tables" }).pipe(
    Layer.provide(IndexedDb.layerWindow)
);
const drafts = Table.make<{ title: string }>({ name: "drafts" });

const program = Effect.gen(function* () {
    const tables = yield* Tables;
    yield* tables.put(drafts, "draft-1", { title: "Inspect equipment" });
    return yield* tables.get(drafts, "draft-1");
});
await Effect.runPromise(program.pipe(Effect.provide(storage)));
```

The layer opens a scoped connection and closes it when released. Use a shared
application runtime/layer scope for repeated operations. `make` is also available
inside `Effect.scoped` when constructing services directly. A versionchange event
closes the older connection. Blocked opens fail explicitly rather than waiting
forever. Choose a dedicated database name; the existing TanStack persistence
database has a different layout and is not automatically migrated.

Read/write transactions span all three stores. The adapter queues requests and
issues them from IndexedDB request callbacks; a small sentinel request keeps the
transaction alive across Effect scheduler yields. This matters because a pending
transaction can still be inactive in an unrelated event-loop task. The queue
preserves atomicity across those yields and is covered by the native browser
contract. Keep transaction bodies short and avoid network/timer work while they
hold storage access. Connection ownership can be centralized in a worker later.

For non-window runtimes/tests, provide an `IndexedDb.IndexedDb` value constructed
with `IndexedDb.make({ indexedDB, IDBKeyRange })`. No globals are captured at import.

Run:

```sh
pnpm exec vp run @party-stack/indexeddb-ontology-storage#test
pnpm exec vp run @party-stack/indexeddb-ontology-storage#test:browser
pnpm exec vp run @party-stack/indexeddb-ontology-storage#bench:browser
```

See the [core README](../effect-tables/README.md) for value support, query semantics,
transaction rules, and the separate sparse-overlay helpers.

## Planner and measurements

The explicit `@party-stack/ontology-storage/planner` subpath supplies planning and
query execution to IndexedDB and the optional memory backend. It ports the
existing persistence adapter's lookup/AND/OR plan structure, native count
estimates, bounded scans, prefix ranges, descending tie grouping, and lowercase
companion indexes. The new planner can stop intersecting once it has a small
candidate set and evaluate the residual on those rows instead. Every result is
checked against the complete predicate; an OR branch without a usable index
requires a full scan. Compound/computed expression indexes are deferred.

The planner contract runs against fake IndexedDB and native Chromium. It spies
on actual IDB requests to verify bounded hydration, zero-read empty intersections,
batched entry reads, selective-first execution, and LIKE/ILIKE maintenance after
updates/deletes. Behavioral fixtures also cover cursors and tied descending pages.

The browser benchmark compares indexed Tables, unindexed Tables, and the existing
TanStack persistence adapter, plus the memory backend, on the same 10,000 rows. It verifies results before
timing equality, AND/OR, IN, LIKE/ILIKE, and ascending/descending windows. Benchmark
comparisons concern subset reads; the older adapter additionally owns replication
cache metadata and uses a different value encoding.

See the [recorded Chromium measurements](benchmarks/2026-10-19-chromium.md) for
latencies, sample counts, and comparison limits.
