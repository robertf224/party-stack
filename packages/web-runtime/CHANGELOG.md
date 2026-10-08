# @party-stack/web-runtime

## 0.4.0

### Minor Changes

- e81553c: Upgrade TanStack DB dependencies and peer requirements to DB 0.12.1, React DB 0.5.5, Query DB Collection 1.4.0, SQLite persistence core 0.4.5, and Expo/Node SQLite persistence 0.2.30. Register Temporal constructors in Node and Expo so upstream SQLite serialization preserves Instant and PlainDate values, including nested values, metadata, and replay. Centralize Temporal encoding for coordination requests, responses, and events; outbox entries persist raw values without an outbox-specific codec. Clone outbox edits through the shared codec. IndexedDB retains its standalone storage codec.

    Update IndexedDB persistence and runtime coordination for the required atomic resume snapshots, remote subset lease lifecycle, and leader-side committed transactions. Runtime persistence now uses `PersistedCollectionPersistence` (`{ adapter, ... }`), preserving standard collection and mode resolvers while supplying Party Stack’s shared coordinator. Custom adapters must implement `loadResumeSnapshot`.

    Maintain only changed rows, metadata, and index entries during IndexedDB commits instead of rewriting complete collections. Reuse existing indexes and lazily rebuild legacy index summaries once. Abort failed index maintenance atomically with row writes.

    Preserve nanosecond precision for Instant range indexes and chronological PlainDate ordering across negative and extended years. Older index encodings fall back to scans until rebuilt.

    Retain adapter-level schema mismatch checks and stale-adapter fencing in IndexedDB. Node and Expo retain their full factory results, and IndexedDB exposes an equivalent `createIndexedDBPersistence` factory. Collections resolve adapters for their requested schema version and mismatch policy; coordinator operations use the selected adapter. IndexedDB creates collection-owned adapters over one shared connection without retaining a version/policy or collection-ID adapter cache. Upgrade existing IndexedDB databases without discarding rows. Release collection adapter bindings and cached coordinator positions when the last collection subscription closes.

    Bound transaction deduplication and replay history, replay missed commits with rows and metadata, and reload when a baseline replacement, history gap, or large change set prevents incremental recovery.

    Use ordered IndexedDB cursors for homogeneous supported indexes and stop after a filtered page. Preserve cursor boundary ties, fall back for other ordering semantics, and select metadata-bearing rows using a dedicated index. Match nested expression paths exactly, merge partial row updates, and respect metadataChanged.

    Pin broadcast RPC retries to the original elected node and leadership term, discover the leader before the first request, and surface uncertain outcomes as `INDETERMINATE` instead of repeating work after takeover. Coordination wire protocol version is now 3; all communicating runtimes must use the same version. Retain replies throughout the retry window and reject new remote calls when retry retention is full. Preserve row metadata in local mutation coordination and advance cached positions only after storage succeeds.

    Scope remote subset acquisition IDs by collection as well as options identity, so releasing a reused query options object in one collection cannot lose another collection’s lease.

    Release broadcast reply payloads when their retention window expires while idle, and clear reply, client, and listener caches on shutdown. Bound IndexedDB initialization bookkeeping to 128 collection IDs while capturing each operation’s schema epoch, clear it on close, and handle close during database opening. Release failed remote subset leases and their retained options before reporting the original load failure.

    Bound host-side collection position caches for client-only collections and restore evicted positions from durable stream state, falling back to an atomic resume snapshot when `getStreamPosition` is absent. Remove rejected position initialization promises so subsequent attempts can recover.

    Preserve Temporal values inside Maps and Sets in IndexedDB, escape storage tag-shaped application objects, and reject unsupported Temporal kinds atomically. Preserve cyclic cloneable containers without adapter-level retention. Verify native bigint, Date, non-finite numbers, and undefined through reopening, metadata, and replay, plus bigint equality/range filtering and numeric pagination with and without indexes.

    Use ordered compound bigint keys for indexed equality/ranges and cursor pagination without limiting values to 64 bits. Ignore legacy bigint index encodings until lazily rebuilt once; reuse version 2 indexes that contain no bigint, and preserve incremental maintenance when their first bigint is written.

    Verify shared upstream persistence contract cases against SQLite and IndexedDB, including native Chromium storage. Add manually runnable real two-tab coordinator scenarios. Refresh active collections after missed final commits on page resume, and reconcile overlapping local acknowledgements and other commits that upstream otherwise skips. Remove listeners, pending envelope state, and reconciliation timers during collection teardown.

    Upgrade the physical IndexedDB database to version 3 to index committed term/sequence identities for deduplication, preserving existing rows and legacy transaction-ID records. Observe aborted transaction and mutation promises without unhandled rejections. Short-circuit empty indexed intersections and benchmark native IndexedDB pagination and incremental writes.

    Enable object persistence in the issue tracker demo and keep cached issues/projects visible while remote subsets are loading. Record the remaining optimistic-read readiness gap in an expected-failure regression test. Browser contract suites remain available to run manually.

### Patch Changes

- Updated dependencies [e81553c]
    - @party-stack/coordination@0.3.0
    - @party-stack/db-indexeddb-persistence@0.2.0
    - @party-stack/runtime@0.4.0

## 0.3.7

### Patch Changes

- Updated dependencies [d1a1805]
    - @party-stack/db-indexeddb-persistence@0.1.6
    - @party-stack/runtime@0.3.7

## 0.3.6

### Patch Changes

- 316b641: Downgrade TanStack DB and its adapters to the versions used by the working Streamline development environment.
- Updated dependencies [316b641]
    - @party-stack/db-indexeddb-persistence@0.1.5
    - @party-stack/runtime@0.3.6

## 0.3.5

### Patch Changes

- Updated dependencies [6e2e337]
    - @party-stack/db-indexeddb-persistence@0.1.4
    - @party-stack/runtime@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [cd0b360]
    - @party-stack/db-indexeddb-persistence@0.1.3
    - @party-stack/runtime@0.3.4

## 0.3.3

### Patch Changes

- Updated dependencies [81d897a]
    - @party-stack/db-indexeddb-persistence@0.1.2
    - @party-stack/runtime@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies [52d8adc]
    - @party-stack/runtime@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [45bcf88]
    - @party-stack/db-indexeddb-persistence@0.1.1
    - @party-stack/runtime@0.3.1

## 0.3.0

### Minor Changes

- 33f6858: auth + connections

### Patch Changes

- Updated dependencies [33f6858]
    - @party-stack/runtime@0.3.0

## 0.2.0

### Minor Changes

- 803610f: the big revamp

### Patch Changes

- Updated dependencies [803610f]
    - @party-stack/db-indexeddb-persistence@0.1.0
    - @party-stack/coordination@0.2.0
    - @party-stack/runtime@0.2.0
