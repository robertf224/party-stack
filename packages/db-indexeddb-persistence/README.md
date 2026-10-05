# IndexedDB persistence

`IndexedDBPersistenceAdapter` implements TanStack DB's persistence API. Party Stack's runtime collection factories bind each collection's schema version and whether it has a sync source through `forCollection`.

## Schema changes

Synced collections reset their refetchable cache on a schema mismatch. Local-only collections reject the mismatch and preserve their data; migrate that data before increasing their schema version, or explicitly opt into `schemaMismatchPolicy: "reset"` when discarding it is intended. Downgrades are rejected. Reads and writes check both schema version and reset epoch inside their IndexedDB transaction, so an adapter opened before a reset cannot continue accessing the old generation.

Direct users of `persistedCollectionOptions` should provide its `resolvePersistenceForCollection` callback with an adapter from `forCollection(context)`. The bare adapter defaults to schema version 1 and the synced-cache reset policy; it cannot infer a collection's mode from persistence requests alone.

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
