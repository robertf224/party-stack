# @party-stack/ontology

## 0.23.7

### Patch Changes

- Updated dependencies [e8d6e91]
    - @party-stack/ontology-replica@0.5.1
    - @party-stack/ontology-server@0.12.1

## 0.23.6

### Patch Changes

- Updated dependencies [0f3d26a]
- Updated dependencies [677b13b]
    - @party-stack/ontology-replica@0.5.0
    - @party-stack/ontology-backend@0.5.0
    - @party-stack/ontology-server@0.12.0
    - @party-stack/connect@0.4.1
    - @party-stack/sql-ontology-storage@0.3.1

## 0.23.5

### Patch Changes

- eabf393: Keep answering reads while large collections load or refresh, and add stale-while-revalidate.

    - A read whose demand existing coverage already proves (for example a filtered query inside a pinned whole collection) resolves from one read transaction instead of queueing behind running loads.
    - For backends without a change journal, subset fetches now run outside the replica's sync gate. A cold read is no longer blocked by a slow refresh of another subset, and actions dispatch and confirm while a refresh is fetching. Only the short install transactions take the gate. Each fetch is numbered when it starts, and an install skips rows a later-started fetch or watch change already wrote, so overlapping loads can finish in any order. An install that would land while an action is sending, or committed but unconfirmed, is dropped and reloaded after confirmation, so a prediction is never shown twice. A load whose demand is invalidated mid-fetch still installs its rows, without proving coverage, and fetches again, at most twice, so a refresh slower than the poll interval always lands. The new `demand.maxConcurrentLoads` (default 6, matching browsers' HTTP/1.1 per-host connection limit) caps fetches in flight.
    - The new `demand.refresh.maxStaleAgeMs` serves coverage that is no longer fresh, but younger than the bound, right away. Its `coverageProof` reports `stale: true` and `confirmedAt` while a background refresh replaces it. Under this option, poll ticks and `revalidate()` mark coverage due instead of invalidating it, so a refresh that takes longer than the poll interval still installs. Coverage past the bound, invalidated coverage, and demands with a terminal load failure are never served stale. It defaults to ten times `maxCoverageAgeMs` (10 minutes with the default 60 s) for replicas that sync in the background, and to 0 for one-shot (`live: false`) replicas, which would never refresh what they serve. **Behavior change:** reads of expired coverage now return cached data at once instead of waiting for the reload. Set `maxStaleAgeMs: 0` to keep the old behavior, for example for authorization data.
    - Under continuous edits, loads still install: the outbox takes the sync gate one action at a time and lets waiting installs go between actions, instead of holding it for its whole queue. Previously a steady stream of edits blocked every load.
    - Reads take priority over background refreshes: loads no reader waits for leave one fetch slot free.
    - Under `maxStaleAgeMs`, a demand's poll tick marks only its own coverage due, so a type with many demands is refreshed once per interval rather than once per demand.
    - Journal-backed, delivery and protocol-source replicas keep their existing gated scheduling.
    - Remove the unused `touchedTypes` field from pending actions. History recovery, its only reader, already requests every demanded subset. Entries from older peers that still carry the field decode normally.
    - Coverage ages survive a device clock corrected backwards: a clock reading more than a second earlier than the newest time the replica has seen invalidates every age-based confirmation from before, instead of letting old data look fresh for the size of the correction.
    - An explicit pass now reports a load that failed before the pass waited for it; previously a fast failure could leave `syncOnce` reporting success.
    - A backend request that throws (a defect rather than a `BackendError`) now fails with `Internal` under every scheduling: fetches, action dispatch (recorded as an unknown outcome, so it is never retried blindly), change pulls, queries and validation. Previously detached loads resolved their readers as if they had succeeded, gated reads died, and a crashed dispatch could stop the outbox worker. Subscriptions already handled this.
    - An action retried after an attempt that may have committed (a deduplicating backend retries it rather than blocking) now holds back snapshots and watch changes until its retry settles, as an action in flight does. Previously a load in between could show the action twice: its commit in the confirmed row, plus its prediction on top. This affected both schedulings.
    - When an attempt may have committed and will not be retried, the replica revalidates every age-based confirmation, as it does for a receipt whose affected list is incomplete, so the commit shows without waiting for coverage to expire.
    - An action that is not replayed because the queue is stopped at a blocked action (it or an earlier one) is now labelled `prediction: "dropped"` instead of keeping its last label.

- Updated dependencies [94fe53b]
- Updated dependencies [ae2426b]
- Updated dependencies [eabf393]
    - @party-stack/connect@0.4.0
    - @party-stack/ontology-server@0.11.8
    - @party-stack/ontology-replica@0.4.0
    - @party-stack/ontology-backend@0.4.0
    - @party-stack/sql-ontology-storage@0.3.1

## 0.23.4

### Patch Changes

- Updated dependencies [d83db65]
    - @party-stack/ontology-spec@0.4.0
    - @party-stack/connect@0.3.3
    - @party-stack/ontology-backend@0.3.2
    - @party-stack/ontology-replica@0.3.3
    - @party-stack/ontology-server@0.11.7
    - @party-stack/ontology-storage@0.3.1
    - @party-stack/sql-ontology-storage@0.3.1
    - @party-stack/node-runtime@0.4.4
    - @party-stack/runtime@0.6.2

## 0.23.3

### Patch Changes

- 22939ac: `ontology pull` now writes `import { defineOntology, o } from "@party-stack/ontology"` into `src/ontology/ontology.ts` instead of importing from `@party-stack/ontology-spec`. Packages that depend only on `@party-stack/ontology` could not resolve the old import, so the pulled ontology silently typed as `any`. `writePulledOntology` now defaults its import path to `@party-stack/ontology` as well.

## 0.23.2

### Patch Changes

- Updated dependencies [7f13a4d]
    - @party-stack/ontology-backend@0.3.1
    - @party-stack/connect@0.3.2
    - @party-stack/ontology-replica@0.3.2
    - @party-stack/ontology-server@0.11.6
    - @party-stack/sql-ontology-storage@0.3.0

## 0.23.1

### Patch Changes

- Updated dependencies [6038606]
    - @party-stack/ontology-replica@0.3.1
    - @party-stack/ontology-server@0.11.5

## 0.23.0

### Minor Changes

- 400f04c: **Breaking:** storage filters are now ontology-spec expressions. `Query.where` is a spec `Expression` from a validated subset over the `row` binding (`rowBinding`): row fields (`getAt` paths), literals, `length` of a field, eq/ne/lt/lte/gt/gte, `in` with a literal list, `contains`, `like`/`ilike`, and/or/not. The separate `Predicate` AST (`{ op, left, right }`) and its `Operand` type are removed; use the `Filter` type. The `eq`, `inArray`, `and`, … helpers keep their signatures and now build spec expressions, and `filterOperand`, `filterField`, `inValues`, `rebindFilter` and `mapFilterFields` read or rewrite them. `isEmpty` is removed: use `eq(length(field("tags")), 0)`, which also matches a missing list.

    Spec `length` now lowers to storage `length` for any comparison and bound, on list and string fields, instead of only as an emptiness test rewritten to `isEmpty`. A list with a size index answers every `length` comparison from that index in memory, IndexedDB and SQL storage. Without one, SQL storage compiles an emptiness test (`= 0`, `> 0`, …) from the list's multi-entry projection with `json_array_length`, and memory and IndexedDB storage evaluate `length` on rows; string lengths are always evaluated on rows. Foundry sends `length(array) == 0` (and `< 1`, `<= 0`) as `isNull`, and `> 0` (`>= 1`) as its negation, both exact.

    `compileObjectSubset` now validates and normalizes a subset's filter into the storage subset instead of translating it, and `objectSubset` and policy planning embed storage filters back into spec subsets by renaming the binding. Replicas drop persisted coverage and action-retention records whose filters predate this format when they open.

### Patch Changes

- Updated dependencies [bba940a]
- Updated dependencies [400f04c]
    - @party-stack/ontology-storage@0.3.0
    - @party-stack/sql-ontology-storage@0.3.0
    - @party-stack/ontology-backend@0.3.0
    - @party-stack/ontology-replica@0.3.0
    - @party-stack/connect@0.3.1
    - @party-stack/node-runtime@0.4.3
    - @party-stack/ontology-server@0.11.4
    - @party-stack/runtime@0.6.1

## 0.22.2

### Patch Changes

- b9eb3bd: Missing-value and empty-list checks push down exactly instead of forcing query-result demand. `isUndefined`/`isNull` work on every field type, including lists and structs. The query language gains a `length` expression (lists and strings; a missing value has length 0, as in TanStack DB), and TanStack's `length(list)` passes through to it. Storage accepts `length` only as an emptiness test (`length(list)` compared with 0 or 1), which it lowers to "missing or empty" with a new `isEmpty` predicate; other uses still need query-result demand.

    Foundry filters were checked against the search API and corrected: `like`/`ilike` no longer sends term searches that dropped rows for substrings inside words, or leading wildcards that failed with a server error; a pattern that starts with a word is sent as a token-prefix wildcard. Ranges, `ne` and negations of exact filters are now sent exactly, and on arrays `isNull` answers "missing or empty".

- 40a3627: Outbox entries report whether their prediction is reflected locally. `prediction` is
  `"applied"`, `"dropped"` (the last replay failed; `predictionError` says why, and the
  action is still pending and sent) or `"none"` (confirmed visibility, or predicted by a
  parent). Servers project the prediction error like other action errors.
- Updated dependencies [40a3627]
- Updated dependencies [b9eb3bd]
- Updated dependencies [403708c]
- Updated dependencies [dfefbac]
- Updated dependencies [40a3627]
- Updated dependencies [40a3627]
- Updated dependencies [40a3627]
- Updated dependencies [40a3627]
- Updated dependencies [2f8567b]
- Updated dependencies [d5ca58e]
- Updated dependencies [03f4516]
- Updated dependencies [cc43c56]
- Updated dependencies [40a3627]
- Updated dependencies [40a3627]
    - @party-stack/connect@0.3.0
    - @party-stack/ontology-replica@0.2.3
    - @party-stack/ontology-spec@0.3.1
    - @party-stack/ontology-storage@0.2.2
    - @party-stack/ontology-server@0.11.3
    - @party-stack/ontology-backend@0.2.2
    - @party-stack/sql-ontology-storage@0.2.2
    - @party-stack/runtime@0.6.0
    - @party-stack/node-runtime@0.4.2

## 0.22.1

### Patch Changes

- Updated dependencies [e971546]
    - @party-stack/ontology-replica@0.2.2
    - @party-stack/ontology-server@0.11.2

## 0.22.0

### Minor Changes

- 501b4a5: Rename the expression helper from `row(name)` to `local(name)`, matching the
  underlying `localReference` expression. The helper can reference any locally
  bound value, including query rows and scalar map items.

    Update related query sources to `related(local("project"), "issues")`.
    `related` still accepts an expression; query sources currently require an ancestor
    local binding. The generated IR is unchanged, including persisted pin definitions.

### Patch Changes

- Updated dependencies [501b4a5]
    - @party-stack/ontology-spec@0.3.0
    - @party-stack/connect@0.2.1
    - @party-stack/ontology-backend@0.2.1
    - @party-stack/ontology-replica@0.2.1
    - @party-stack/ontology-server@0.11.1
    - @party-stack/ontology-storage@0.2.1
    - @party-stack/sql-ontology-storage@0.2.1
    - @party-stack/node-runtime@0.4.1
    - @party-stack/runtime@0.5.1

## 0.21.0

### Minor Changes

- ca220d2: Replace the SQLite ontology attachment coordinator with shared transactional blob
  storage and a common owned backend composition. Remove the sqlite-ontology package.
  Rename durable-object-ontology to durable-object-ontology-storage and consolidate
  its R2 implementation on Alchemy's client, with separate storage bridges and an
  Alchemy constructor/resource example. Verify interrupted write/reader recovery with
  real local Durable Object resets.

    Stream attachment helper transfers over Effect RPC with scoped upload ownership,
    bounded acknowledged chunks, size/sequence validation and cancellation. Support
    source-only backend attachment/query helpers without constructing LiveOntology.
    Keep Effect test aliases from redirecting Vitest worker entry points.

- 92480df: Replace Effection lifetimes with Effect scopes and fibers throughout coordination,
  blob management, and the ontology outbox. Remove the runtime and watcher Effection
  exports and dependencies. Runtime disposal cancels owned work and prevents late
  remote reads from repopulating closed blob storage.

    Use Effect RPC and its browser worker transport for SharedWorker coordination,
    with schema-derived intermediate codecs for Temporal, bigint, undefined, and native
    structured-clone values. Advance the protocol identity to version 4; coordinating
    contexts must run compatible versions. Preserve cancellation, request timeout,
    service FIFO, and lost-response fencing in the browser fallback.

    Acquire replica/runtime change subscriptions before initial snapshots so changes
    racing collection startup or action-status reads cannot be missed. Separate the
    scoped replica service composition from application DbClient collections and add
    scoped host query streams with persisted-only inspection support.

    Forward TanStack subset predicates and supported windows into Replica, preserve
    three-valued comparison semantics, and retain the union of active query views.
    Reuse maintained whole-collection and primary-key coverage without idle snapshot
    refreshes. Repair filtered watch-only snapshots by identity before removing cached
    rows that may have moved out of a query.

    Replace type-wide GC roots and global outbox eviction suppression with persisted
    subset leases and per-action read/query/write dependencies, updated atomically
    during replay. Preserve previous and partial dependencies when replay fails.
    Prepare simple transaction queries and keyed edits without loading a whole type.
    Schedule bounded, scoped replica collection with configurable cache age and batch
    limits; invalidate affected coverage when rows are evicted.

    Remove explicit collection preloads and whole-ontology startup synchronization.
    Forward transaction queries through real TanStack subset demand, including lazy
    join key batches and correlated includes, while keeping all replay reads local.

    Move native blob metadata, generation intents and retention into the
    ontology-storage blobs service. Compose a Tables-backed application facade and
    transactional outbox attachment roots. Preserve metadata/aliases after byte
    eviction; fence stale deletes and late writes, protect active readers, distinguish
    missing cache files from IO errors, and recover abandoned generations conservatively.

    Remove the TanStack persistence coordinator, adapter interfaces, SQLite persistence
    dependencies, and the legacy IndexedDB persistence package. Local collections now
    use scoped Tables-backed views on every runtime, including an owned memory fallback.
    Browser storage invalidations and page-resume events refresh active local demand.
    Keep private connection and installation record demand alive for their service
    lifetime; preserve stable optimistic request identity across canonical storage
    round trips and drain temporary outbox queries before closing their source.

    Submit native Foundry actions without temporary live collections or per-action
    watchers. Convert returned edit identities into durable receipt read-back targets.
    Persist the receipt before confirmation, retry failed/incomplete reads after restart
    without redispatch, and atomically publish confirmed rows with optimistic settlement.

    Port Salesforce snapshots, action submission and query functions directly to the
    Effect backend contract. Reuse a collection-independent SOQL transport and
    synthesize committed CRUD receipts with known identities and explicit partial
    target coverage. Retain conservative read-back for automation effects and polling
    repair until native CDC health/reconnect reporting is available.

    Add consistent local Replica inspection snapshots and an opt-in in-process
    parent/child proof using the same engine. Preserve imported shared state beneath
    local predictions, atomically retire handed-off actions during import, and track
    stable source identity plus ordered updates across reopen. The proof uses complete
    trusted snapshots with manual forwarding and excludes transport, subset sync,
    authorization, blob integration and GC; application wiring remains unchanged.

    Complete the native LiveOntology execution path and remove the collection-oriented
    backend contract, compatibility constructors and duplicate outbox executor. Backend
    bindings acquire scoped services with open(context); provider metadata, query and
    attachment helpers use native snapshots/services. SQLite and Durable Object schema
    initialization happens at acquisition rather than factory construction.

    Persist retry deadlines/budgets and failure details. Support pause/discard-all,
    accepted/confirmed waits, explicit ambiguous retries and verified-receipt recovery.
    Preserve frozen expression time/UUID inputs across replay and forwarding. Save
    receipts before idempotent attachment mapping application and retry failed mapping
    or confirmation after restart without submitting the action again.

- 92480df: Extract the complete ontology specification, pure helpers, JSON codecs, and code
  generation into ontology-spec, while preserving existing ontology public imports.
  Keep live collections, installations, metadata pulling, and backend integration
  in ontology. Support standalone model generation without live factories and
  retain the explicit self-hosted IR bootstrap.

    Add opt-in Effect v4 model/schema generation using the same ontology definitions.
    Generated codecs bridge portable models and Effect Result values, with Temporal
    ISO codecs and no Effect runtime dependency in ordinary spec imports.

    Compile the same Effect codec registries directly from runtime ontology IR,
    without generated source or evaluation, for dynamically installed definitions.

- 9298a20: Complete the Party Stack V0 offline-first ontology stack.

    - Use scoped native backends and replicas with optimistic actions, durable outboxes,
      retained query data and attachment bytes. Open cached definitions offline and
      report incompatible updates without silently discarding queued actions.
    - Serve multiple ontologies through HTTP, SharedWorker or local clients. Stateful
      realtime capabilities require explicit `enableRealtime`.
    - Acquire authenticated backends from saved Connect connections. Expose local
      `AuthenticationProvider`/`useAuthentication` APIs, sign-out and forget operations,
      and Better Auth external-session integration.
    - Define authorization with `objects`, action/query-function checks and scoped
      `additionalObjects`. Project errors and receipt identities at policy boundaries.
    - Compose generated collection links and component-local singular/list fragments.
      `useFragment` returns `{ data }`; attachment hooks return values directly with
      Suspense. Action attachment parameters accept File/Blob inputs.
    - Follow declared links in native query sources with `related(row("project"), "issues")`,
      including policies and pin graphs. Pins retain full objects and their attachment
      bytes regardless of scalar projections.
    - Manage named download families through ordinary queryable pin collections and
      optimistic commands. Inspect one query per family with per-input status in devtools.
    - Reduce repeated storage/query/delivery work and use copy-on-write memory indexes.

    This is a breaking migration: upgrade related clients, servers and runtimes together.
    TanStack DB/react-db 1.0.0-rc.1.4 require the tracked patches installed by
    `@party-stack/tanstack-db-patches` in each consuming repository. See the repository
    V0 implementation summary, patch inventory and current guides for migration details.

- 05420e3: Rename the linkHop expression and its helpers to related. Validate both to-one
  object results and to-many object lists, preserving target object types through
  map bindings and nested traversal. Correct reverse-name inference for self-links.
  Keep action execution limited to to-one relationships with an explicit unsupported
  error for to-many execution.
- 99f5c47: Consolidate native blob metadata in ontology-storage and remove the separate blobs
  package and unused TanStack metadata collection. Maintain schema-derived attachment
  references with object and replica transactions, distinguish identity retention
  from byte pins, and collect unreferenced staged uploads/metadata after a configurable
  orphan grace. Add scoped file-backed reads and atomic receipt binding with durable
  recovery when local mapping conflicts.

### Patch Changes

- Updated dependencies [ca220d2]
- Updated dependencies [92480df]
- Updated dependencies [92480df]
- Updated dependencies [9298a20]
- Updated dependencies [05420e3]
- Updated dependencies [92480df]
- Updated dependencies [99f5c47]
    - @party-stack/sql-ontology-storage@0.2.0
    - @party-stack/ontology-server@0.11.0
    - @party-stack/ontology-backend@0.2.0
    - @party-stack/ontology-storage@0.2.0
    - @party-stack/runtime@0.5.0
    - @party-stack/ontology-replica@0.2.0
    - @party-stack/connect@0.2.0
    - @party-stack/node-runtime@0.4.0
    - @party-stack/ontology-spec@0.2.0

## 0.20.0

### Minor Changes

- 4823958: Align Expo runtime dependencies on SDK 57 and provide a required Expo Blob/File polyfill. Hash Expo storage names, and verify idempotent cleanup closes SQLite before deletion.

    Expose optional awaitable collection refresh utilities and implement full Foundry snapshot refresh, preserving subscriptions and propagating failures. Use fresh committed snapshots for operation acknowledgement when edit history is unavailable.

    Upgrade TanStack DB and integrations to their latest releases and adapt persistence adapters and coordination to explicit storage targets.

### Patch Changes

- Updated dependencies [4823958]
    - @party-stack/blobs@0.6.2
    - @party-stack/connections@0.3.2
    - @party-stack/node-runtime@0.3.2
    - @party-stack/runtime@0.4.2

## 0.19.1

### Patch Changes

- bf65731: Migrate workspace builds and checks to Vite+ and TypeScript 7, with shared library and TanStack Start configuration packages. Preserve unbundled ESM library outputs and declarations, enable React Compiler for Start apps, and update React Table to v9.

    Clean up lint findings across packages, fix HTTP header normalization, enable automatic indexing for local collections, and migrate Devtools live queries to the current TanStack DB API. Ontology generation no longer depends on Prettier; generated files retain their existing header and can be formatted by the consuming project.

    Update the Vite React plugins and their React Compiler integration, and test React libraries and example apps against React 19.3.

- Updated dependencies [bf65731]
    - @party-stack/blobs@0.6.1
    - @party-stack/connections@0.3.1
    - @party-stack/coordination@0.3.1
    - @party-stack/errors@0.2.1
    - @party-stack/icons@0.2.1
    - @party-stack/node-runtime@0.3.1
    - @party-stack/runtime@0.4.1

## 0.19.0

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
    - @party-stack/blobs@0.6.0
    - @party-stack/connections@0.3.0
    - @party-stack/coordination@0.3.0
    - @party-stack/node-runtime@0.3.0
    - @party-stack/runtime@0.4.0

## 0.18.0

### Minor Changes

- 43dd60e: Add provider-neutral icon descriptors, canonical provider mappings and renderers, and ontology icon metadata conversion for Foundry and Salesforce.

### Patch Changes

- Updated dependencies [43dd60e]
    - @party-stack/icons@0.2.0

## 0.17.0

### Minor Changes

- 0e5e6d3: add non-live backend adapter mode for request-scoped ontology operations

## 0.16.8

### Patch Changes

- d1a1805: Upgrade the TanStack DB ecosystem, including DB 0.9.2, React DB 0.4.1, query DB collection 1.2.15, and SQLite persistence 0.2.23. Foundry and remote subset loads now propagate cancellation without sharing abortable transports.
- Updated dependencies [d1a1805]
    - @party-stack/blobs@0.5.7
    - @party-stack/connections@0.2.7
    - @party-stack/node-runtime@0.2.7
    - @party-stack/runtime@0.3.7

## 0.16.7

### Patch Changes

- c545376: Allow live ontology attachment creation to use an existing opaque ID and use it to stage remote multipart uploads while preserving file metadata and canonical attachment ID mappings.

## 0.16.6

### Patch Changes

- 316b641: Downgrade TanStack DB and its adapters to the versions used by the working Streamline development environment.
- Updated dependencies [316b641]
    - @party-stack/blobs@0.5.6
    - @party-stack/connections@0.2.6
    - @party-stack/node-runtime@0.2.6
    - @party-stack/runtime@0.3.6

## 0.16.5

### Patch Changes

- 6e2e337: downgrade db deps
- Updated dependencies [6e2e337]
    - @party-stack/node-runtime@0.2.5
    - @party-stack/connections@0.2.5
    - @party-stack/runtime@0.3.5
    - @party-stack/blobs@0.5.5

## 0.16.4

### Patch Changes

- cd0b360: improve salesforce integration, fix outbox settlement + handle missing pks
- Updated dependencies [cd0b360]
    - @party-stack/blobs@0.5.4
    - @party-stack/connections@0.2.4
    - @party-stack/node-runtime@0.2.4
    - @party-stack/runtime@0.3.4

## 0.16.3

### Patch Changes

- 81d897a: update db deps + start handling contains pushdown in foundry
- d2e1dbd: clarify attachment id contract + fix foundry impl
- Updated dependencies [81d897a]
    - @party-stack/node-runtime@0.2.3
    - @party-stack/connections@0.2.3
    - @party-stack/runtime@0.3.3
    - @party-stack/blobs@0.5.3

## 0.16.2

### Patch Changes

- 98faee7: fix authoritative action param resolution, foundry codec issues, and foundry sync resolution

## 0.16.1

### Patch Changes

- c366eb9: fix foundry user loading, null handling, and object-set-watcher crashes

## 0.16.0

### Minor Changes

- 2538365: Expose action parameter default resolution on live ontology actions.

## 0.15.0

### Minor Changes

- 81d84bb: Rename expression inputs to `inputReference`, promote UUID and current-time expressions to direct variants, convert Foundry list-of-struct action assignments with backend-neutral map and struct expressions, and safely apply structured property changes to sparse objects.

## 0.14.0

### Minor Changes

- 05ff1a7: add server-authoritative validation hooks

## 0.13.2

### Patch Changes

- 8791727: Add a portable authoritative SQLite ontology backend with injectable attachment
  bytes, plus a Durable Object wrapper that binds SQLite and R2 with shared
  better-sqlite3/workerd conformance coverage.

## 0.13.1

### Patch Changes

- 52d8adc: fix remote workflows
- Updated dependencies [52d8adc]
    - @party-stack/runtime@0.3.2
    - @party-stack/blobs@0.5.2
    - @party-stack/connections@0.2.2
    - @party-stack/node-runtime@0.2.2

## 0.13.0

### Minor Changes

- 07fbbce: Convert Foundry OMS parameter prefills into provider-neutral action defaults and preserve string constraints and suggestions.

## 0.12.1

### Patch Changes

- 45bcf88: upgrade tanstack db deps
- Updated dependencies [45bcf88]
    - @party-stack/node-runtime@0.2.1
    - @party-stack/connections@0.2.1
    - @party-stack/runtime@0.3.1
    - @party-stack/blobs@0.5.1

## 0.12.0

### Minor Changes

- b8fb08e: node runtime + add meta ontology to installations

### Patch Changes

- Updated dependencies [b8fb08e]
    - @party-stack/node-runtime@0.2.0

## 0.11.0

### Minor Changes

- 33f6858: auth + connections

### Patch Changes

- Updated dependencies [33f6858]
    - @party-stack/connections@0.2.0
    - @party-stack/runtime@0.3.0
    - @party-stack/errors@0.2.0
    - @party-stack/blobs@0.5.0

## 0.10.0

### Minor Changes

- 46268bc: Keep collection readiness helpers internal, scope action refresh metadata to remote ontology, and derive secured schema projection directly from policy configuration.

## 0.9.0

### Minor Changes

- 515f8dc: OSDK-free LiveOntology Gateway MVP: collection readiness and race-safe cleanup, non-blocking action refresh, structured remote errors, policy-aware describe projection, precise invalidation, attachments, and public Foundry action metadata. No generic link traversal, object-query helpers, or OMS/prefill metadata.

### Patch Changes

- Updated dependencies [515f8dc]
    - @party-stack/blobs@0.4.1

## 0.8.0

### Minor Changes

- a973080: add attachment constraints + metadata selection

### Patch Changes

- Updated dependencies [a973080]
    - @party-stack/blobs@0.4.0

## 0.7.0

### Minor Changes

- fe9443e: Add required action type identifiers to runtime metadata while keeping portable action definitions provider-neutral.

    Map Foundry action type RIDs into runtime metadata and support filtering the ActionType collection by ID.

## 0.6.0

### Minor Changes

- 1842e6c: Add required object and property identifiers plus title property metadata to runtime object metadata, while keeping portable ontology definitions provider-neutral.

    Map Foundry object and property RIDs into runtime metadata so downstream TanStack queries can filter the shared ontology metadata snapshot by ID.

## 0.5.0

### Minor Changes

- 5bdc4be: improve devtools

## 0.4.0

### Minor Changes

- 803610f: the big revamp

### Patch Changes

- Updated dependencies [803610f]
    - @party-stack/runtime@0.2.0
    - @party-stack/blobs@0.3.0

## 0.3.0

### Minor Changes

- 2ee9520: introduce attachments

### Patch Changes

- Updated dependencies [2ee9520]
    - @party-stack/schema@0.3.0
    - @party-stack/blobs@0.2.0

## 0.2.0

### Minor Changes

- 61724f7: actions

### Patch Changes

- Updated dependencies [61724f7]
    - @party-stack/schema@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [611c3c0]
    - @party-stack/schema@0.1.1

## 0.1.0

### Minor Changes

- 020b42a: initial release

### Patch Changes

- Updated dependencies [020b42a]
    - @party-stack/schema@0.1.0
