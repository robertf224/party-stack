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

The physical IndexedDB database upgrades to version 3. Version 2 adds metadata
and transaction-version indexes; version 3 adds a transaction stream-position
index for deduplication by collection, term, and sequence. These migrations
preserve rows, metadata, collection positions, and persisted indexes. This
physical database version is separate from each collection’s `schemaVersion`. Legacy transaction ID records remain
available for deduplication within the retained window, but lack replay data;
requests for unavailable old history require a full reload.

## Persisted values

Rows, row metadata, collection metadata, and replay preserve `Temporal.Instant`
and `Temporal.PlainDate`, including nested arrays, records, Maps, and Sets.
Unsupported Temporal kinds throw during the write instead of losing their state,
matching SQLite core 0.4.5's supported Temporal kinds. Storage tags in ordinary
application records are escaped; existing Temporal tags remain readable. Cloneable
cycles and shared references are preserved using per-operation graph bookkeeping.

IndexedDB natively preserves bigint, Date, undefined, NaN, and positive/negative
Infinity, so these values need no JSON tags. It can preserve bigint beyond SQLite's
signed 64-bit limit; applications using both adapters must respect SQLite's limit.
Bigint equality and ranges use persisted indexes. Homogeneous bigint ordering uses
ordered cursors and stops after the requested filtered page. Compound keys encode
sign, digit count, and digits without converting the magnitude to a number.
Bigint indexes using encoding version 2 fall back to scans until index acquisition
or a row write rebuilds them once; other indexes with that encoding version remain
usable without rebuilding. The physical IndexedDB database version is 3.
Filter-only reads may return a superset as described below.
Maps, Sets, buffers, and other native cloneable values are additional IndexedDB
capabilities; SQLite's recursive JSON codec does not generally preserve these types.

## Bounded recovery history

Options follow the upstream SQLite defaults:

| Option                        | Default | Purpose                                             |
| ----------------------------- | ------- | --------------------------------------------------- |
| `appliedTxPruneMaxRows`       | 1,000   | Maximum retained transaction records per collection |
| `appliedTxPruneMaxAgeSeconds` | 86,400  | History age pruned during commits                   |
| `pullSinceReloadThreshold`    | 128     | Maximum number of replayed row and metadata changes |

Transaction IDs and new commits’ `(collectionId, term, seq)` identities are
deduplicated within that retained window. Old v1/v2 journal entries lack term/seq
fields and retain transaction-ID deduplication; the durable stream position also
fences a retry of the latest commit. Older historical positions cannot be inferred
from those legacy records. `pullSince` reads its history and stream position atomically. Missing history, version gaps, truncation, and change sets over the threshold require a full reload. Row values and metadata, including supported Temporal values, are included in incremental replay. Set `appliedTxPruneMaxRows` to zero to disable retained replay and transaction-ID history.

## Subset reads

The mini planner selects candidates using equality, range, AND/OR, and supported string-prefix indexes. Filter-only reads may return a candidate superset for TanStack DB to finish filtering.

A single ordered expression can use an IndexedDB cursor when its index has one homogeneous supported type: number, bigint, boolean, Date, Temporal.Instant, Temporal.PlainDate, or lexically sorted string. The adapter evaluates residual filters before counting offset and limit, sorts tied rows by encoded key, and stops after the requested page. Cursor requests include all rows at the current boundary plus the limited following page.

Mixed/nullish types, locale/custom string sorting, and multiple sort expressions use candidate loading and in-memory filtering, sorting, and pagination. Unsupported object-identity ordering keeps the full source available to the live query rather than returning a potentially incorrect finite page.

`scanRows({ metadataOnly: true })` selects only rows with metadata using the metadata index. It still returns their row values, as required by TanStack DB's scan contract.


## Cross-tab behavior and contract checks

IndexedDB has no row-change notification API. For automatic updates across tabs,
supply a cross-tab coordinator to the factory and mutate through persisted
collections. Party Stack’s web runtime supplies its shared Web Locks/BroadcastChannel
coordination. Direct adapter calls and manual DevTools/storage edits do not emit
notifications; raw edits can also bypass index and replay maintenance.

Party Stack’s persistence shim checks active collections on `pageshow`, visible
`visibilitychange`, and visible `focus`. A changed durable stream position triggers
a local TanStack reload notification. Before the first commit notification the
hydration position is unknown, so the first resume reloads conservatively. Subsequent
unchanged positions skip row reads. The reload refreshes active subsets and metadata;
it neither clears storage nor broadcasts a reset. Browser listeners and per-subscription
checks are released during collection cleanup; no polling timer is retained.

The shim also reconciles a collection when local mutation acknowledgements overlap
other commits. Core 0.4.5 can advance the observed sequence from an acknowledgement
before queued notifications apply, skipping their rows. A short idle-turn timer
coalesces reconciliation across pending local requests. Ordinary single-consumer
writes retain incremental updates. Concurrent edits can require an active-subset
reload; pending envelopes/timers are removed when the burst finishes or the last
subscription closes. The browser suite includes the same failing scenario with
TanStack’s broadcast coordinator as an explicitly expected-failure reference.

Run the [adapted upstream contract](src/contracts/NOTICE.md) through both IndexedDB
and SQLite with `pnpm --filter @party-stack/db-indexeddb-persistence test`. Run it
through native Chromium IndexedDB with `pnpm --filter @party-stack/db-indexeddb-persistence test:browser`.
The web runtime’s `test:browser` suite uses two real pages and separate connections,
real locks and broadcasts, deterministic lost notifications, leader failover,
concurrent writes, durable reopening, and actual Chromium freeze/resume. Both
browser suites are available to run manually. Chromium coverage does not certify Safari/Firefox or
mobile OS process-kill behavior.

Run `pnpm --filter @party-stack/db-indexeddb-persistence bench:browser` for real
storage query, pagination, empty-intersection, and incremental-write measurements.
See [the audit and measurements](persistence-contract-audit.md) for coverage and limits.
