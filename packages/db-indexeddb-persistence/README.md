# IndexedDB persistence for TanStack DB

An IndexedDB implementation of TanStack DB's core persistence interface. Use it
with `persistedCollectionOptions` to persist a synced collection or store local-only
data. See the [TanStack DB persistence guide](https://tanstack.com/db/latest/docs/guides/sqlite-persistence)
for shared options, schema versioning, coordination, and lifecycle behavior.

## Installation

```sh
pnpm add @party-stack/db-indexeddb-persistence @tanstack/db@0.12.1 @tanstack/db-sqlite-persistence-core@0.4.5
```

Requires IndexedDB. The current release uses persistence core 0.4.5 and expects
TanStack DB 0.12.1.

## Persist a Query Collection

Wrap a Query Collection to save fetched rows in IndexedDB while keeping its normal
fetching and synchronization behavior. Reopening the same database and collection
restores the persisted data.

For this example, also install the Query Collection adapter and TanStack Query:

```sh
pnpm add @tanstack/query-db-collection@1.4.0 @tanstack/query-core@^5.102.8
```

```ts
import { createCollection } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";
import { createIndexedDBPersistence } from "@party-stack/db-indexeddb-persistence";

type Task = { id: string; title: string };

const queryClient = new QueryClient();
const persistence = createIndexedDBPersistence({ databaseName: "my-app" });

const tasks = createCollection(
    persistedCollectionOptions({
        ...queryCollectionOptions({
            id: "tasks",
            queryClient,
            queryKey: ["tasks"],
            queryFn: async (): Promise<Task[]> => {
                const response = await fetch("/api/tasks");
                if (!response.ok) throw new Error("Could not load tasks");
                return response.json();
            },
            getKey: (task) => task.id,
        }),
        persistence,
        schemaVersion: 1,
        initialRender: {
            strategy: "network-first",
            networkTimeoutMs: 3_000,
        },
    })
);

await tasks.preload();
```

The wrapper persists data applied by the sync adapter. Configure server mutations
through the [Query Collection's mutation handlers](https://tanstack.com/db/latest/docs/collections/query-collection).
Persistence of pending server mutations is a separate concern; see
[TanStack's offline transactions guide](https://tanstack.com/db/latest/docs/guides/offline-transactions).

## Local-only collection

Without a sync adapter, `persistedCollectionOptions` saves collection mutations
locally. Using the imports, `Task` type, and persistence instance above:

```ts
const drafts = createCollection(
    persistedCollectionOptions({
        id: "drafts",
        schemaVersion: 1,
        getKey: (task: Task) => task.id,
        persistence,
    })
);

await drafts.preload();
const transaction = drafts.insert({ id: crypto.randomUUID(), title: "Draft task" });
await transaction.isPersisted.promise;
```

One persistence instance shares a connection across collections. When finished,
clean up the collections before closing it:

```ts
await tasks.cleanup();
await drafts.cleanup();
persistence.close();
```

## Supported values

Rows, row metadata, collection metadata, and incremental replay preserve
`Temporal.Instant` and `Temporal.PlainDate`, including values nested in arrays,
records, Maps, and Sets. Unsupported Temporal kinds throw during writes. Storage
tags in ordinary application records are escaped, and existing Temporal tags remain
readable. Cloneable cycles and shared references are preserved.

IndexedDB also natively preserves bigint, Date, undefined, NaN, positive and
negative Infinity, Maps, Sets, buffers, and other structured-cloneable values.
Applications that also use SQLite persistence should account for its different
value support, including its signed 64-bit bigint limit and JSON codec limitations.

## How it works

### User-space indexes

Collection indexes are stored as records in `indexDefinitions` and `indexEntries`,
rather than creating a native IndexedDB index for every collection expression.
A fixed set of native indexes provides lookup paths into those entries, including
compound keys for collection, expression signature, value type, value, and row ID.
Adding a collection index therefore does not require an IndexedDB version upgrade.

When TanStack requests an index, the adapter evaluates its expression over existing
rows and persists the entries. Subsequent commits maintain the affected entries
alongside rows and metadata in the same IndexedDB transaction. Definitions and
entries survive reopening, so compatible indexes can be reused.

Typed encodings make values such as booleans, Temporal dates and instants, and
arbitrarily large bigints usable as index keys. Bigint ordering encodes sign, digit
count, and digits without converting the magnitude to a JavaScript number.

### Mini query planner

For subset loads, a small planner matches filters against persisted index
expressions. Equality, range, and supported string-prefix predicates become index
lookups; AND intersects candidate row IDs and OR unions them. This reduces the rows
loaded from storage when suitable indexes exist. Filter-only loads may return a
candidate superset for TanStack DB to finish filtering.

For a single ordered expression with a homogeneous supported type, the adapter can
walk an ordered IndexedDB cursor, evaluate residual filters before counting offset
and limit, and stop after the requested page. Supported types are number, bigint,
boolean, Date, Temporal.Instant, Temporal.PlainDate, and lexically sorted string.
Ties use encoded row keys; cursor requests retain all rows at the current boundary
plus the limited following page.

Mixed or nullish types, locale/custom string sorting, and multiple sort expressions
use candidate loading followed by in-memory filtering, sorting, and pagination.
Unsupported object-identity ordering leaves the full source available to the live
query rather than returning an incorrect finite page.

### Atomic commits and incremental recovery

Rows, metadata, index updates, transaction history, and the collection's stream
position are committed atomically. Recent history includes row values and metadata,
allowing `pullSince` to replay changes without reloading the whole collection.
Transaction IDs and `(collectionId, term, seq)` identities deduplicate commits within
the retained window.

History is bounded by `appliedTxPruneMaxRows` (default 1,000) and
`appliedTxPruneMaxAgeSeconds` (default 86,400). `pullSinceReloadThreshold` defaults to
128 row and metadata changes. Missing or truncated history, version gaps, and changes
over that threshold request a full reload. These options can be passed to
`createIndexedDBPersistence`.

IndexedDB itself does not notify other tabs about row changes. Supply a cross-tab
`coordinator` to the factory when sharing collections across tabs; otherwise TanStack
uses its collection-local default. Direct adapter calls and manual storage edits do
not emit collection notifications.

## Development and validation

From a source checkout, run these commands in the package directory:

```sh
pnpm build
pnpm lint
pnpm test
pnpm test:browser
pnpm bench:browser
```

The [adapted upstream contract](src/contracts/NOTICE.md) runs against both
IndexedDB and SQLite. The browser suite runs against native Chromium IndexedDB;
the browser benchmarks measure storage queries, pagination, empty intersections,
and incremental writes. Chromium coverage does not certify Safari, Firefox, or
mobile OS process-kill behavior.

See [the contract audit and measurements](persistence-contract-audit.md) for
coverage and limits.
