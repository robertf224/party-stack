# @party-stack/ontology-backend

## 0.6.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [babd85a]
    - @party-stack/ontology-spec@0.5.0
    - @party-stack/ontology-storage@0.4.0

## 0.5.0

### Minor Changes

- 0f3d26a: Change a child replica's view on its open delivery subscription instead of replacing the subscription. `OntologySource.updateView` (the `UpdateView` RPC over ontology-server) sends the new view; the parent acquires demand for added subsets before releasing removed ones, and the same stream delivers the difference, so loads both views select keep running. In a browser tab whose search box changed the view on every keystroke, each change had cancelled and restarted every search still selected. Sources without `updateView`, including older servers, keep the previous behavior of subscribing again.

    `demand.idleRetentionMs` now defaults to 5 seconds for live replicas (0 for one-shot ones), so a released subset's watch and in-flight load survive a consumer that comes straight back, such as a remount or a view replaced by subscribing again.

## 0.4.0

### Minor Changes

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

## 0.3.2

### Patch Changes

- Updated dependencies [d83db65]
    - @party-stack/ontology-spec@0.4.0
    - @party-stack/ontology-storage@0.3.1

## 0.3.1

### Patch Changes

- 7f13a4d: Deliver a record larger than the frame budget alone in its own frame instead of failing the whole delivery. A large row, such as action type metadata with many parameters, previously broke delivery for its route and left readers reloading forever.

## 0.3.0

### Minor Changes

- 400f04c: **Breaking:** storage filters are now ontology-spec expressions. `Query.where` is a spec `Expression` from a validated subset over the `row` binding (`rowBinding`): row fields (`getAt` paths), literals, `length` of a field, eq/ne/lt/lte/gt/gte, `in` with a literal list, `contains`, `like`/`ilike`, and/or/not. The separate `Predicate` AST (`{ op, left, right }`) and its `Operand` type are removed; use the `Filter` type. The `eq`, `inArray`, `and`, … helpers keep their signatures and now build spec expressions, and `filterOperand`, `filterField`, `inValues`, `rebindFilter` and `mapFilterFields` read or rewrite them. `isEmpty` is removed: use `eq(length(field("tags")), 0)`, which also matches a missing list.

    Spec `length` now lowers to storage `length` for any comparison and bound, on list and string fields, instead of only as an emptiness test rewritten to `isEmpty`. A list with a size index answers every `length` comparison from that index in memory, IndexedDB and SQL storage. Without one, SQL storage compiles an emptiness test (`= 0`, `> 0`, …) from the list's multi-entry projection with `json_array_length`, and memory and IndexedDB storage evaluate `length` on rows; string lengths are always evaluated on rows. Foundry sends `length(array) == 0` (and `< 1`, `<= 0`) as `isNull`, and `> 0` (`>= 1`) as its negation, both exact.

    `compileObjectSubset` now validates and normalizes a subset's filter into the storage subset instead of translating it, and `objectSubset` and policy planning embed storage filters back into spec subsets by renaming the binding. Replicas drop persisted coverage and action-retention records whose filters predate this format when they open.

### Patch Changes

- bba940a: Fix demand failing with "Index values must be queryable scalars" when a filter checks a list property for a missing value (for example `isUndefined(token.allowedFormIds)`). Since 0.2.2, such checks pushed down exactly, and lazy query indexes then requested a scalar index on the list. `indexesForQuery(query, ir, objectType)` now takes the object type and fits each index to the property: a scalar index for a scalar (missing-value checks included), an element index for `contains`, and a size index for a list. It never requests a scalar index for a list or struct.

    New list size indexes (`{ name, field, size: true }`) key each row once by its list's element count, and a missing list by the missing value. One index answers a list's `isUndefined`, `ne(list, undefined)` and every `length` comparison, in memory, IndexedDB and SQL storage, instead of scanning rows. The planner also negates comparisons under `not`, so `not(isUndefined(list))` uses the same index.

- Updated dependencies [bba940a]
- Updated dependencies [400f04c]
    - @party-stack/ontology-storage@0.3.0

## 0.2.2

### Patch Changes

- b9eb3bd: Missing-value and empty-list checks push down exactly instead of forcing query-result demand. `isUndefined`/`isNull` work on every field type, including lists and structs. The query language gains a `length` expression (lists and strings; a missing value has length 0, as in TanStack DB), and TanStack's `length(list)` passes through to it. Storage accepts `length` only as an emptiness test (`length(list)` compared with 0 or 1), which it lowers to "missing or empty" with a new `isEmpty` predicate; other uses still need query-result demand.

    Foundry filters were checked against the search API and corrected: `like`/`ilike` no longer sends term searches that dropped rows for substrings inside words, or leading wildcards that failed with a server error; a pattern that starts with a word is sent as a token-prefix wildcard. Ranges, `ne` and negations of exact filters are now sent exactly, and on arrays `isNull` answers "missing or empty".

- 40a3627: Outbox entries report whether their prediction is reflected locally. `prediction` is
  `"applied"`, `"dropped"` (the last replay failed; `predictionError` says why, and the
  action is still pending and sent) or `"none"` (confirmed visibility, or predicted by a
  parent). Servers project the prediction error like other action errors.
- 40a3627: Watches can report row changes instead of only invalidating. An adapter's watch may
  emit `{ changes }` with `put` (the complete row), `exit` (left the subset; the replica
  reads it back by primary key to tell a change from a deletion) and `delete`. The
  replica applies them without reloading the subset, but holds them while one of its own
  actions is in flight or awaiting read-back, and reloads instead.

    Foundry watches report object updates as puts (Foundry sends every property with a
    value) and removals as exits. Reference updates and anything that cannot be decoded
    remain invalidation hints.

- Updated dependencies [b9eb3bd]
- Updated dependencies [403708c]
- Updated dependencies [dfefbac]
    - @party-stack/ontology-spec@0.3.1
    - @party-stack/ontology-storage@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [501b4a5]
    - @party-stack/ontology-spec@0.3.0
    - @party-stack/ontology-storage@0.2.1

## 0.2.0

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

- 99f5c47: Consolidate native blob metadata in ontology-storage and remove the separate blobs
  package and unused TanStack metadata collection. Maintain schema-derived attachment
  references with object and replica transactions, distinguish identity retention
  from byte pins, and collect unreferenced staged uploads/metadata after a configurable
  orphan grace. Add scoped file-backed reads and atomic receipt binding with durable
  recovery when local mapping conflicts.

### Patch Changes

- Updated dependencies [ca220d2]
- Updated dependencies [92480df]
- Updated dependencies [9298a20]
- Updated dependencies [05420e3]
- Updated dependencies [92480df]
- Updated dependencies [99f5c47]
    - @party-stack/ontology-storage@0.2.0
    - @party-stack/ontology-spec@0.2.0
