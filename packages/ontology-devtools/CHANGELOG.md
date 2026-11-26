# @party-stack/ontology-devtools

## 0.8.8

### Patch Changes

- babd85a: Update and delete action logic can target a list of object references and applies the step to each referenced object, as Foundry's modify and delete rules do with object-list parameters.

    `validate` now checks the type of every value action logic writes to a property (issue code `IncompatibleAssignment`), using the same compatibility rule as parameter defaults. An object reference and its object type's primary-key type are interchangeable in both directions.

    New `omitInvalid(ontology)` in `@party-stack/ontology-spec` drops whatever `validate` rejects and returns `{ ontology, omitted, issues }`. A default whose type doesn't fit its parameter loses only the default; any other issue drops the definition it sits under, and validation reruns so definitions depending on a dropped one go too. `issues` lists what omission cannot fix (for example an invalid policy).

    `pull` from `@party-stack/ontology-backend/meta` (and the `@party-stack/ontology` Promise facade) runs `transform`, then `omitInvalid`, and fails only when issues remain. It still resolves to the IR and logs what it omitted; pass `includeOmitted: true` to resolve to `{ ontology, omitted }` instead. The `ontology pull` CLI prints a warning for each omitted definition.

    **Breaking:** a route that acquires its backend is now declared as `{ authenticate?, dangerouslyAllowInternalAccess?, open }` instead of a bare function or Effect. `open` returns the backend and binding, and can no longer return `authenticate` or `dangerouslyAllowInternalAccess` (a type error). Static bindings are unchanged. Each request is authenticated before the route opens, so unauthenticated requests no longer open routes. When opening fails (for example a definition load failure), a caller allowed internal access (`true`, or a predicate over the context from `authenticate`) gets the original error; others get the generic message. Replica routes require `true`.

    Replicas take `onDefinitionChange: "reset" | "error"` (default `"error"`). With `"reset"`, a replica opened with a definition whose contract differs from its stored cache clears cached data instead of failing with `SchemaMismatch`, inside its startup transaction so a failed open rolls back. It clears only object types whose own contract changed or that were removed; other types keep their rows and coverage, and action, link or query-function changes clear nothing. Changes to named value types, context or policy, or an unreadable stored definition, clear everything. The outbox, receipts and every download's desired query are kept; downloads that lost rows reinstall. Queued actions stay queued: their predictions are replayed against the new definition, one that no longer applies is dropped (the action is still sent), and send failures follow the outbox's `failureStrategy`. A cleared type's indexes are dropped and ensured again, so a changed primary key also opens. A reset now also clears each named download's membership and bytes, not only the default one's.

    **Breaking:** managed replica routes drop `definition: { ir?, onIncompatible? }`. Use the replica's `onDefinitionChange: "reset"` in place of `onIncompatible: "rebuild"`, and, on an upstream route, a top-level `ir` for the application contract. `ReplicaDefinitionOptions` is no longer exported. Managed replica routes no longer accept `source` or `bootstrap`; the server fills those in.

    **Breaking:** the single-pin API is removed; downloads are named pins only (`ontology.pins(definePin(name, { query, attachments })).set(inputs)`, status in its `.collection`). Removed: the `ReadPin`, `WatchPin`, `SetPin` and `ClearPin` RPCs; the replica's `demand.setPin`, `clearPin`, `pinStatus` and `pinStatusChanges` and the `pin` field of replica status; `ReplicaPinControls`, `PinStatus`, `PinGraph`, `PinOptions` and their schemas; `LiveOntology.pins.get`, `set`, `clear()` and `subscribe`; the `pins` option and client field; and React's `useOfflinePin`. The `pins` resource is now authorized as the `Pins` operation. `OntologyServer.syncOnce` resolves to `{ pins }`, every named download with its readiness and error. A replica releases a download left by the old API once when it opens.

    **Breaking:** `makeReplica`, `Replica.layer`, registrations and managed replica routes take `definition` in place of `ir`: `{ kind: "static", ir }` for a fixed definition, or `{ kind: "dynamic", meta, select? }` for one read from a metadata backend. Replace `ir` with `definition: { kind: "static", ir }`. A dynamic replica keeps a replica of the metadata it reads, in the same storage, demanding exactly the rows the definition was built from, so it opens offline under the definition it last read and follows changes as that metadata syncs; after a change it reads the definition again once every row it was read from is current. `select` takes `pull`'s `objectTypeNames`, `actionTypeNames`, `queryFunctionTypeNames` and `transform`. `backend` may be a function of the definition, returning a backend or `{ backend, source }`. A followed replica reopens behind the same handle under each definition that differs: writes in progress finish first, reads and waits run again on the new engine, live queries switch to it, and held demand is acquired again. `replica.definition` exposes `current` and `changes`. If a new definition cannot open, the replica keeps serving the previous one until the source supplies one that opens. `ReplicaStatus` has `definition: { hash, error? }`: the contract hash of the definition the replica is open under, and an error when a newer definition could not be read or opened. Before an engine closes for a reopen it is retired: calls and delivery, demand and change streams still on it fail with a retryable `Unavailable`, so children resume against the new engine (they previously got `InvalidRequest` and stopped replicating). A managed replica reopens its account's partition without reading its definition, so it opens offline. Children that resume their delivery stream after a reopen receive only the changed types again. Requests from a protocol client carry the contract hash of the definition it accepted, and a server now serving another definition rejects them with `SchemaMismatch`.

    `LiveOntology` has `definition` (`get()` and `subscribe(listener)`), which reports `"stale"` once a view fed by a client sees the server's definition change. `OntologyProvider` closes an owned view and opens it again under the new definition; borrowed views are left to their owner. A view fed by a client now opens its local replica with `onDefinitionChange: "reset"` (configurable through the new `onDefinitionChange` view option), so a reopened view clears only the changed types. Servers serve the definition a replica is open under, for managed routes and for a replica passed in directly.

    A dynamic replica whose backend fails with `SchemaMismatch` revalidates its metadata. Every route with a definition serves it as meta ontology rows on its `meta` resource (Describe reports `meta: true`), with the same access as `Describe`, and protocol clients expose it as `client.metaBackend`; metadata requests are fenced to the client's accepted definition. While something follows `client.definition.changes`, the client watches that resource and checks the description again when it changes (after a random delay of up to two seconds), so an idle `LiveOntology` view, and an `upstream` route, learn of a new definition without a failed request. `makeMetadataBackend(ir, { replaced })` reports `replaced` to watches. Without realtime there is no watch, and the next request after a change reports it.

    **Breaking:** `Describe` no longer carries the definition, and reports protocol version 2; clients require version 2 from a fresh description (a retained version 1 description still opens with its definition). It returns the binding and capabilities with `definitionHash` and a new `contractHash`; clients read the definition from the `meta` resource in one request and check it against `definitionHash`. A local client uses its server's definition object while it is the one described. A retained client takes `{ description, ir }`: `OntologyClientOptions.ir` is the definition the description was accepted with. `OntologyClientOptions.resource` opens the `pins` or `meta` resource directly. The partition catalog stores each partition's context (and an `upstream` route's description) instead of its definition; records from older versions are read and rewritten. `route.definition` (`OntologyRouteContext`) is removed. An `upstream` route without an application contract has a dynamic definition read from the parent's `meta` resource, so it opens offline, and follows it through the parent's metadata watch or a `SchemaMismatch` on its next request. On a dynamic replica, an action the source rejects with `SchemaMismatch` before committing it stays queued (a retryable `Unavailable`) and is sent again after the reopen. A dynamic replica's metadata replica uses the replica's `live` setting and demand policy, so the definition follows the same freshness rules as the data. **Breaking:** the registration's `beforeOpen` hook is removed; use `onDefinitionChange: "reset"`.

    `OntologyIR` value, object, action and query function types and properties take an optional provider `id`, and a link type's `id` is now optional (**Breaking** for code that read it: use `linkTypeId`). An id defaults to the name, or for a link type to its source object type and `target.name` (`objectTypeId`, `linkTypeId` and so on; `withDefinitionIds` and `withoutDefaultIds` fill in or drop defaults). Meta ontology rows always carry ids, and `makeMetadataBackend` serves a definition with its defaults filled in. Ids are not part of the contract, so a generated definition (generated files leave ids out) is compatible with the provider's; a replica still clears an object type whose id, or whose property's id, changed when both definitions set it. The Foundry adapter sets ids from RIDs, now also for value and query function types. `pull` reads every value type in the same request as the rest and keeps the ones the selection uses, so it makes one request. Definition signatures and hashes no longer depend on the order of a definition's named collections or on optional definition fields set to `undefined`.

    **Breaking:** `PullOptions.transformPulledOntology` (and the `ontology pull` config and Salesforce pull config option of the same name) is renamed `transform`.

    A child replica's reconnect wait is jittered between half and all of `retryIntervalMs`, so children that lose their streams together spread their reconnects. The Foundry adapter now reports unknown properties, object, link and action types, parameters, and properties no longer searchable or sortable as `SchemaMismatch`, and `OntologySyncing` as a retryable `Unavailable`.

    **Breaking:** an `upstream` route is a followed replica. With `onDefinitionChange: "reset"`, a new parent definition reopens the replica in place; the route is no longer dropped and reopened. The catalog's `rebuild` is removed, along with its pending-rebuild marker (a marker left by an older version is read as the retained description). `route.definition` is removed in favour of a dynamic definition with a per-definition `backend`.

    Storage can remove indexes. `Transaction.dropIndex(table, name)` (and `TablesService.dropIndex`) removes an index's definition, its entries and any native index in the caller's transaction, so a later `ensureIndex` may reuse the name with a different definition; dropping a missing index does nothing, and the table's schema stamp cannot be dropped. `indexes(table)` lists a table's current index definitions in read and write transactions. **Breaking** for custom drivers: `DriverTransaction` now requires `deleteIndex(table, name)`, which the memory, IndexedDB, SQLite and PostgreSQL drivers implement, and the shared `runContract` exercises it.

- Updated dependencies [babd85a]
    - @party-stack/ontology@0.24.0
    - @party-stack/runtime@0.6.3

## 0.8.7

### Patch Changes

- @party-stack/ontology@0.23.7

## 0.8.6

### Patch Changes

- @party-stack/ontology@0.23.6

## 0.8.5

### Patch Changes

- Updated dependencies [eabf393]
    - @party-stack/ontology@0.23.5

## 0.8.4

### Patch Changes

- @party-stack/ontology@0.23.4
- @party-stack/runtime@0.6.2

## 0.8.3

### Patch Changes

- Updated dependencies [22939ac]
    - @party-stack/ontology@0.23.3

## 0.8.2

### Patch Changes

- @party-stack/ontology@0.23.2

## 0.8.1

### Patch Changes

- @party-stack/ontology@0.23.1

## 0.8.0

### Minor Changes

- 400f04c: **Breaking:** storage filters are now ontology-spec expressions. `Query.where` is a spec `Expression` from a validated subset over the `row` binding (`rowBinding`): row fields (`getAt` paths), literals, `length` of a field, eq/ne/lt/lte/gt/gte, `in` with a literal list, `contains`, `like`/`ilike`, and/or/not. The separate `Predicate` AST (`{ op, left, right }`) and its `Operand` type are removed; use the `Filter` type. The `eq`, `inArray`, `and`, … helpers keep their signatures and now build spec expressions, and `filterOperand`, `filterField`, `inValues`, `rebindFilter` and `mapFilterFields` read or rewrite them. `isEmpty` is removed: use `eq(length(field("tags")), 0)`, which also matches a missing list.

    Spec `length` now lowers to storage `length` for any comparison and bound, on list and string fields, instead of only as an emptiness test rewritten to `isEmpty`. A list with a size index answers every `length` comparison from that index in memory, IndexedDB and SQL storage. Without one, SQL storage compiles an emptiness test (`= 0`, `> 0`, …) from the list's multi-entry projection with `json_array_length`, and memory and IndexedDB storage evaluate `length` on rows; string lengths are always evaluated on rows. Foundry sends `length(array) == 0` (and `< 1`, `<= 0`) as `isNull`, and `> 0` (`>= 1`) as its negation, both exact.

    `compileObjectSubset` now validates and normalizes a subset's filter into the storage subset instead of translating it, and `objectSubset` and policy planning embed storage filters back into spec subsets by renaming the binding. Replicas drop persisted coverage and action-retention records whose filters predate this format when they open.

### Patch Changes

- Updated dependencies [400f04c]
    - @party-stack/ontology@0.23.0
    - @party-stack/runtime@0.6.1

## 0.7.3

### Patch Changes

- b9eb3bd: Missing-value and empty-list checks push down exactly instead of forcing query-result demand. `isUndefined`/`isNull` work on every field type, including lists and structs. The query language gains a `length` expression (lists and strings; a missing value has length 0, as in TanStack DB), and TanStack's `length(list)` passes through to it. Storage accepts `length` only as an emptiness test (`length(list)` compared with 0 or 1), which it lowers to "missing or empty" with a new `isEmpty` predicate; other uses still need query-result demand.

    Foundry filters were checked against the search API and corrected: `like`/`ilike` no longer sends term searches that dropped rows for substrings inside words, or leading wildcards that failed with a server error; a pattern that starts with a word is sent as a token-prefix wildcard. Ranges, `ne` and negations of exact filters are now sent exactly, and on arrays `isNull` answers "missing or empty".

- Updated dependencies [b9eb3bd]
- Updated dependencies [40a3627]
- Updated dependencies [40a3627]
- Updated dependencies [cc43c56]
    - @party-stack/ontology@0.22.2
    - @party-stack/runtime@0.6.0

## 0.7.2

### Patch Changes

- @party-stack/ontology@0.22.1

## 0.7.1

### Patch Changes

- Updated dependencies [501b4a5]
    - @party-stack/ontology@0.22.0
    - @party-stack/runtime@0.5.1

## 0.7.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [ca220d2]
- Updated dependencies [92480df]
- Updated dependencies [92480df]
- Updated dependencies [9298a20]
- Updated dependencies [05420e3]
- Updated dependencies [99f5c47]
    - @party-stack/ontology@0.21.0
    - @party-stack/runtime@0.5.0
    - @party-stack/design-system@0.1.0
    - @party-stack/icons@0.2.1
    - @party-stack/icons-lucide@0.2.1

## 0.6.2

### Patch Changes

- 4823958: Align Expo runtime dependencies on SDK 57 and provide a required Expo Blob/File polyfill. Hash Expo storage names, and verify idempotent cleanup closes SQLite before deletion.

    Expose optional awaitable collection refresh utilities and implement full Foundry snapshot refresh, preserving subscriptions and propagating failures. Use fresh committed snapshots for operation acknowledgement when edit history is unavailable.

    Upgrade TanStack DB and integrations to their latest releases and adapt persistence adapters and coordination to explicit storage targets.

- Updated dependencies [4823958]
    - @party-stack/ontology@0.20.0

## 0.6.1

### Patch Changes

- bf65731: Migrate workspace builds and checks to Vite+ and TypeScript 7, with shared library and TanStack Start configuration packages. Preserve unbundled ESM library outputs and declarations, enable React Compiler for Start apps, and update React Table to v9.

    Clean up lint findings across packages, fix HTTP header normalization, enable automatic indexing for local collections, and migrate Devtools live queries to the current TanStack DB API. Ontology generation no longer depends on Prettier; generated files retain their existing header and can be formatted by the consuming project.

    Update the Vite React plugins and their React Compiler integration, and test React libraries and example apps against React 19.3.

- Updated dependencies [bf65731]
    - @party-stack/icons@0.2.1
    - @party-stack/icons-lucide@0.2.1
    - @party-stack/ontology@0.19.1

## 0.6.0

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
    - @party-stack/ontology@0.19.0

## 0.5.0

### Minor Changes

- 43dd60e: Add provider-neutral icon descriptors, canonical provider mappings and renderers, and ontology icon metadata conversion for Foundry and Salesforce.

### Patch Changes

- Updated dependencies [43dd60e]
    - @party-stack/icons@0.2.0
    - @party-stack/icons-lucide@0.2.0
    - @party-stack/ontology@0.18.0

## 0.4.17

### Patch Changes

- Updated dependencies [0e5e6d3]
    - @party-stack/ontology@0.17.0

## 0.4.16

### Patch Changes

- d1a1805: Upgrade the TanStack DB ecosystem, including DB 0.9.2, React DB 0.4.1, query DB collection 1.2.15, and SQLite persistence 0.2.23. Foundry and remote subset loads now propagate cancellation without sharing abortable transports.
- Updated dependencies [d1a1805]
    - @party-stack/ontology@0.16.8

## 0.4.15

### Patch Changes

- Updated dependencies [c545376]
    - @party-stack/ontology@0.16.7

## 0.4.14

### Patch Changes

- 316b641: Downgrade TanStack DB and its adapters to the versions used by the working Streamline development environment.
- Updated dependencies [316b641]
    - @party-stack/ontology@0.16.6

## 0.4.13

### Patch Changes

- 6e2e337: downgrade db deps
- Updated dependencies [6e2e337]
    - @party-stack/ontology@0.16.5

## 0.4.12

### Patch Changes

- cd0b360: improve salesforce integration, fix outbox settlement + handle missing pks
- Updated dependencies [cd0b360]
    - @party-stack/ontology@0.16.4

## 0.4.11

### Patch Changes

- 81d897a: update db deps + start handling contains pushdown in foundry
- Updated dependencies [81d897a]
- Updated dependencies [d2e1dbd]
    - @party-stack/ontology@0.16.3

## 0.4.10

### Patch Changes

- Updated dependencies [98faee7]
    - @party-stack/ontology@0.16.2

## 0.4.9

### Patch Changes

- Updated dependencies [c366eb9]
    - @party-stack/ontology@0.16.1

## 0.4.8

### Patch Changes

- Updated dependencies [2538365]
    - @party-stack/ontology@0.16.0

## 0.4.7

### Patch Changes

- Updated dependencies [81d84bb]
    - @party-stack/ontology@0.15.0

## 0.4.6

### Patch Changes

- Updated dependencies [05ff1a7]
    - @party-stack/ontology@0.14.0

## 0.4.5

### Patch Changes

- Updated dependencies [8791727]
    - @party-stack/ontology@0.13.2

## 0.4.4

### Patch Changes

- 52d8adc: fix remote workflows
- Updated dependencies [52d8adc]
    - @party-stack/ontology@0.13.1

## 0.4.3

### Patch Changes

- Updated dependencies [07fbbce]
    - @party-stack/ontology@0.13.0

## 0.4.2

### Patch Changes

- 45bcf88: upgrade tanstack db deps
- Updated dependencies [45bcf88]
    - @party-stack/ontology@0.12.1

## 0.4.1

### Patch Changes

- e384777: Fix schema graph layout so relationship arrows connect to object type cards and labels avoid overlapping nodes.
- Updated dependencies [b8fb08e]
    - @party-stack/ontology@0.12.0

## 0.4.0

### Minor Changes

- 33f6858: auth + connections

### Patch Changes

- Updated dependencies [33f6858]
    - @party-stack/ontology@0.11.0

## 0.3.2

### Patch Changes

- Updated dependencies [46268bc]
    - @party-stack/ontology@0.10.0

## 0.3.1

### Patch Changes

- Updated dependencies [515f8dc]
    - @party-stack/ontology@0.9.0

## 0.3.0

### Minor Changes

- a973080: add attachment constraints + metadata selection

### Patch Changes

- Updated dependencies [a973080]
    - @party-stack/ontology@0.8.0

## 0.2.2

### Patch Changes

- Updated dependencies [fe9443e]
    - @party-stack/ontology@0.7.0

## 0.2.1

### Patch Changes

- Updated dependencies [1842e6c]
    - @party-stack/ontology@0.6.0

## 0.2.0

### Minor Changes

- 5bdc4be: improve devtools

### Patch Changes

- Updated dependencies [5bdc4be]
    - @party-stack/ontology@0.5.0

## 0.1.0

### Minor Changes

- 803610f: the big revamp

### Patch Changes

- Updated dependencies [803610f]
    - @party-stack/ontology@0.4.0
