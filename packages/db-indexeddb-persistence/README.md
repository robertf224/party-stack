# IndexedDB persistence

`createIndexedDBPersistence` provides TanStack's standard persistence resolver
interface and works independently of Party Stack:

```ts
import { createIndexedDBPersistence } from "@party-stack/db-indexeddb-persistence";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";

const persistence = createIndexedDBPersistence({ databaseName: "my-app" });
const options = persistedCollectionOptions({
    id: "tasks",
    schemaVersion: 2,
    getKey: (task: { id: string }) => task.id,
    persistence,
});
```

Each collection resolution creates an adapter with its requested schema version
and mismatch policy over one shared connection. There is no retained adapter cache
by version, policy, or collection ID. Synced collections default to resetting
incompatible caches; local-only collections preserve incompatible data and throw.
Explicit `schemaMismatchPolicy` overrides those defaults; `"throw"` aliases
`"sync-absent-error"`. Downgrades and stale adapters are rejected.

A supplied `coordinator` is preserved. Otherwise TanStack supplies its default
collection-local coordinator. No Party Stack imports or hooks are required.

Clean up collections and drop their references when finished so their adapters and
bookkeeping can be collected. Call `persistence.close()` at the end of the shared
database lifetime; it closes the connection and prevents all adapter views from
reopening it. Closing an individual view leaves other views usable. The factory
retains only its required default adapter. An explicitly supplied shared coordinator
owns its own registration cleanup. Direct `new IndexedDBPersistenceAdapter(...)`
usage remains available and owns its own connection.

The IndexedDB database upgrades from version 1 to version 2 to add metadata and
transaction-version indexes. This migration preserves existing rows, metadata,
collection positions, and persisted indexes. Legacy transaction ID records remain
available for deduplication within the retained window, but lack replay data;
requests for unavailable old history require a full reload.

## Bounded recovery history

Options follow the upstream SQLite defaults:

| Option                        | Default | Purpose                                             |
| ----------------------------- | ------- | --------------------------------------------------- |
| `appliedTxPruneMaxRows`       | 1,000   | Maximum retained transaction records per collection |
| `appliedTxPruneMaxAgeSeconds` | 86,400  | History age pruned during commits                   |
| `pullSinceReloadThreshold`    | 128     | Maximum number of replayed row and metadata changes |

Transaction IDs are deduplicated within that retained window. `pullSince` reads its history and stream position atomically. Missing history, version gaps, truncation, and change sets over the threshold require a full reload. Row values and metadata, including supported Temporal values, are included in incremental replay. Set `appliedTxPruneMaxRows` to zero to disable retained replay and transaction-ID history.

## Subset reads

The mini planner selects candidates using equality, range, AND/OR, and supported string-prefix indexes. Filter-only reads may return a candidate superset for TanStack DB to finish filtering.

A single ordered expression can use an IndexedDB cursor when its index has one homogeneous supported type: number, boolean, Date, Temporal.Instant, Temporal.PlainDate, or lexically sorted string. The adapter evaluates residual filters before counting offset and limit, sorts tied rows by encoded key, and stops after the requested page. Cursor requests include all rows at the current boundary plus the limited following page.

Mixed/nullish types, locale/custom string sorting, and multiple sort expressions use candidate loading and in-memory filtering, sorting, and pagination. Unsupported object-identity ordering keeps the full source available to the live query rather than returning a potentially incorrect finite page.

`scanRows({ metadataOnly: true })` selects only rows with metadata using the metadata index. It still returns their row values, as required by TanStack DB's scan contract.
