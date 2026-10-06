# IndexedDB persistence

`createIndexedDBPersistence` follows TanStack DB's SQLite persistence factory API and works independently of the Party Stack runtime. Pass its result directly to `persistedCollectionOptions`:

```ts
import { createIndexedDBPersistence } from "@party-stack/db-indexeddb-persistence";
import { persistedCollectionOptions } from "@tanstack/db-sqlite-persistence-core";

const persistence = createIndexedDBPersistence({ databaseName: "my-app" });
const options = persistedCollectionOptions({
    id: "tasks",
    schemaVersion: 1,
    getKey: (task: { id: string }) => task.id,
    persistence,
});
```

The factory accepts a custom `coordinator`; otherwise TanStack supplies a collection-local `SingleProcessCoordinator`. Its standard resolver callbacks create collection-owned adapters with independent schema versions and mismatch policies, sharing one factory-owned IndexedDB connection. There is no retained cache of adapters by schema version or collection ID. Clean up collections and drop their references when finished. Call `persistence.close()` when the shared persistence lifetime ends; this closes the shared connection and prevents all adapter views from reopening it. Closing an individual adapter view leaves the other views usable. An explicitly supplied shared coordinator owns its own registration cleanup.

## Schema changes

Synced collections reset their refetchable cache on a schema mismatch. Local-only collections reject the mismatch and preserve their data; migrate that data before increasing their schema version, or explicitly opt into `schemaMismatchPolicy: "reset"` when discarding it is intended. Downgrades are rejected. Reads and writes check both schema version and reset epoch inside their IndexedDB transaction, so an adapter opened before a reset cannot continue accessing the old generation.

As with SQLite, the factory defaults to preserving local-only data, and resolves synced collections to the cache reset policy. An explicit `schemaMismatchPolicy` overrides this choice; `"throw"` is an alias for `"sync-absent-error"`. The lower-level `IndexedDBPersistenceAdapter` remains available for direct use with explicit schema options.

The IndexedDB database itself upgrades from version 1 to version 2 to add metadata and transaction-version indexes. This migration preserves existing rows, metadata, collection positions, and persisted indexes. Legacy transaction ID records remain available for deduplication within the retained window, but lack replay data; requests for unavailable old history require a full reload.

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
