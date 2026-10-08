# @party-stack/foundry-ontology

## 0.18.0

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
    - @party-stack/connections@0.3.0
    - @party-stack/oauth@0.3.0
    - @party-stack/ontology@0.19.0
    - @party-stack/runtime@0.4.0

## 0.17.0

### Minor Changes

- b792b73: Add an optional `refetchInterval` to the Foundry meta ontology backend adapter and expose it as `metaRefetchInterval` on metadata-only ontology routes. Forward the interval to the shared metadata, action type, and query function type query collections. Set an interval in milliseconds to poll for metadata updates, or `false` to disable polling. Route configuration applies when the installation opens the meta ontology through `openMetaOntology`.

## 0.16.2

### Patch Changes

- b228345: Preserve word and namespace boundaries when converting Foundry action API names between kebab-case and provider-neutral camelCase names.

## 0.16.1

### Patch Changes

- 578cd26: Preserve OMS string constraints and labeled suggestions on action struct fields, including fields inside optional lists of structs and optional or list string fields.

## 0.16.0

### Minor Changes

- 43dd60e: Add provider-neutral icon descriptors, canonical provider mappings and renderers, and ontology icon metadata conversion for Foundry and Salesforce.

### Patch Changes

- Updated dependencies [43dd60e]
    - @party-stack/icons-blueprint@0.2.0
    - @party-stack/ontology@0.18.0

## 0.15.0

### Minor Changes

- 0e5e6d3: add non-live backend adapter mode for request-scoped ontology operations

### Patch Changes

- Updated dependencies [0e5e6d3]
    - @party-stack/ontology@0.17.0

## 0.14.15

### Patch Changes

- d1a1805: Upgrade the TanStack DB ecosystem, including DB 0.9.2, React DB 0.4.1, query DB collection 1.2.15, and SQLite persistence 0.2.23. Foundry and remote subset loads now propagate cancellation without sharing abortable transports.
- Updated dependencies [d1a1805]
    - @party-stack/connections@0.2.7
    - @party-stack/oauth@0.2.7
    - @party-stack/ontology@0.16.8
    - @party-stack/runtime@0.3.7

## 0.14.14

### Patch Changes

- 3816870: require object params that are mutation targets

## 0.14.13

### Patch Changes

- 44c26f3: properly handle nested object refs

## 0.14.12

### Patch Changes

- Updated dependencies [c545376]
    - @party-stack/ontology@0.16.7

## 0.14.11

### Patch Changes

- 316b641: Downgrade TanStack DB and its adapters to the versions used by the working Streamline development environment.
- Updated dependencies [316b641]
    - @party-stack/connections@0.2.6
    - @party-stack/oauth@0.2.6
    - @party-stack/ontology@0.16.6
    - @party-stack/runtime@0.3.6

## 0.14.10

### Patch Changes

- 6e2e337: downgrade db deps
- Updated dependencies [6e2e337]
    - @party-stack/connections@0.2.5
    - @party-stack/ontology@0.16.5
    - @party-stack/runtime@0.3.5
    - @party-stack/oauth@0.2.5

## 0.14.9

### Patch Changes

- ccf3bcd: Fix generated CurrentTime override serialization across bundled module instances.

## 0.14.8

### Patch Changes

- cd0b360: improve salesforce integration, fix outbox settlement + handle missing pks
- Updated dependencies [cd0b360]
    - @party-stack/ontology@0.16.4
    - @party-stack/oauth@0.2.4
    - @party-stack/connections@0.2.4
    - @party-stack/runtime@0.3.4

## 0.14.7

### Patch Changes

- 81d897a: update db deps + start handling contains pushdown in foundry
- d2e1dbd: clarify attachment id contract + fix foundry impl
- Updated dependencies [81d897a]
- Updated dependencies [d2e1dbd]
    - @party-stack/connections@0.2.3
    - @party-stack/ontology@0.16.3
    - @party-stack/runtime@0.3.3
    - @party-stack/oauth@0.2.3

## 0.14.6

### Patch Changes

- 07bf6ce: make struct fields properly optional on object types

## 0.14.5

### Patch Changes

- 1d842ab: fix optionals in foundry generation

## 0.14.4

### Patch Changes

- 98faee7: fix authoritative action param resolution, foundry codec issues, and foundry sync resolution
- Updated dependencies [98faee7]
    - @party-stack/ontology@0.16.2

## 0.14.3

### Patch Changes

- c366eb9: fix foundry user loading, null handling, and object-set-watcher crashes
- Updated dependencies [c366eb9]
    - @party-stack/foundry-object-set-watcher@0.5.1
    - @party-stack/ontology@0.16.1

## 0.14.2

### Patch Changes

- Updated dependencies [2538365]
    - @party-stack/ontology@0.16.0

## 0.14.1

### Patch Changes

- 9eca335: Include function-backed Foundry actions in ontology pulls.

## 0.14.0

### Minor Changes

- 81d84bb: Rename expression inputs to `inputReference`, promote UUID and current-time expressions to direct variants, convert Foundry list-of-struct action assignments with backend-neutral map and struct expressions, and safely apply structured property changes to sparse objects.

### Patch Changes

- Updated dependencies [81d84bb]
    - @party-stack/foundry-object-set-watcher@0.5.0
    - @party-stack/ontology@0.15.0

## 0.13.0

### Minor Changes

- 05ff1a7: add server-authoritative validation hooks

### Patch Changes

- Updated dependencies [05ff1a7]
    - @party-stack/ontology@0.14.0

## 0.12.2

### Patch Changes

- Updated dependencies [8791727]
    - @party-stack/ontology@0.13.2

## 0.12.1

### Patch Changes

- Updated dependencies [52d8adc]
    - @party-stack/ontology@0.13.1
    - @party-stack/runtime@0.3.2
    - @party-stack/connections@0.2.2
    - @party-stack/oauth@0.2.2

## 0.12.0

### Minor Changes

- 07fbbce: Convert Foundry OMS parameter prefills into provider-neutral action defaults and preserve string constraints and suggestions.

### Patch Changes

- Updated dependencies [07fbbce]
    - @party-stack/ontology@0.13.0

## 0.11.1

### Patch Changes

- 45bcf88: upgrade tanstack db deps
- Updated dependencies [45bcf88]
    - @party-stack/connections@0.2.1
    - @party-stack/ontology@0.12.1
    - @party-stack/runtime@0.3.1
    - @party-stack/oauth@0.2.1

## 0.11.0

### Minor Changes

- b8fb08e: node runtime + add meta ontology to installations

### Patch Changes

- Updated dependencies [b8fb08e]
    - @party-stack/ontology@0.12.0

## 0.10.0

### Minor Changes

- 33f6858: auth + connections

### Patch Changes

- Updated dependencies [33f6858]
    - @party-stack/foundry-object-set-watcher@0.4.0
    - @party-stack/foundry-client@0.3.0
    - @party-stack/connections@0.2.0
    - @party-stack/ontology@0.11.0
    - @party-stack/runtime@0.3.0
    - @party-stack/errors@0.2.0
    - @party-stack/oauth@0.2.0

## 0.9.0

### Minor Changes

- 46268bc: Keep collection readiness helpers internal, scope action refresh metadata to remote ontology, and derive secured schema projection directly from policy configuration.

### Patch Changes

- Updated dependencies [46268bc]
    - @party-stack/ontology@0.10.0

## 0.8.1

### Patch Changes

- bc97879: Safely translate two-sided LIKE and ILIKE predicates into Foundry contains queries while preserving downstream exact filtering.

## 0.8.0

### Minor Changes

- 515f8dc: OSDK-free LiveOntology Gateway MVP: collection readiness and race-safe cleanup, non-blocking action refresh, structured remote errors, policy-aware describe projection, precise invalidation, attachments, and public Foundry action metadata. No generic link traversal, object-query helpers, or OMS/prefill metadata.

### Patch Changes

- Updated dependencies [515f8dc]
    - @party-stack/ontology@0.9.0

## 0.7.0

### Minor Changes

- a973080: add attachment constraints + metadata selection

### Patch Changes

- Updated dependencies [a973080]
    - @party-stack/ontology@0.8.0

## 0.6.0

### Minor Changes

- fe9443e: Add required action type identifiers to runtime metadata while keeping portable action definitions provider-neutral.

    Map Foundry action type RIDs into runtime metadata and support filtering the ActionType collection by ID.

### Patch Changes

- Updated dependencies [fe9443e]
    - @party-stack/ontology@0.7.0

## 0.5.0

### Minor Changes

- 1842e6c: Add required object and property identifiers plus title property metadata to runtime object metadata, while keeping portable ontology definitions provider-neutral.

    Map Foundry object and property RIDs into runtime metadata so downstream TanStack queries can filter the shared ontology metadata snapshot by ID.

### Patch Changes

- Updated dependencies [1842e6c]
    - @party-stack/ontology@0.6.0

## 0.4.2

### Patch Changes

- Updated dependencies [5bdc4be]
    - @party-stack/ontology@0.5.0

## 0.4.1

### Patch Changes

- dd8e2ee: fix function union types + function-backed action pulls
- Updated dependencies [dd8e2ee]
    - @party-stack/foundry-object-set-watcher@0.3.1

## 0.4.0

### Minor Changes

- 803610f: the big revamp

### Patch Changes

- Updated dependencies [803610f]
    - @party-stack/ontology@0.4.0

## 0.3.2

### Patch Changes

- 4d77e01: support edits history being unavailable with fallback

## 0.3.1

### Patch Changes

- ba0a1b9: fix pagination bug

## 0.3.0

### Minor Changes

- 2ee9520: introduce attachments

### Patch Changes

- Updated dependencies [2ee9520]
    - @party-stack/foundry-object-set-watcher@0.3.0
    - @party-stack/ontology@0.3.0

## 0.2.0

### Minor Changes

- 61724f7: actions

### Patch Changes

- Updated dependencies [61724f7]
    - @party-stack/ontology@0.2.0

## 0.1.1

### Patch Changes

- @party-stack/ontology@0.1.1

## 0.1.0

### Minor Changes

- 020b42a: initial release

### Patch Changes

- Updated dependencies [020b42a]
    - @party-stack/ontology@0.1.0
