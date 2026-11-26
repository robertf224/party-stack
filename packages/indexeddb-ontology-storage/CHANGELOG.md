# @party-stack/indexeddb-ontology-storage

## 0.2.5

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
    - @party-stack/ontology-storage@0.4.0

## 0.2.4

### Patch Changes

- @party-stack/ontology-storage@0.3.1

## 0.2.3

### Patch Changes

- Updated dependencies [bba940a]
- Updated dependencies [400f04c]
    - @party-stack/ontology-storage@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [b9eb3bd]
- Updated dependencies [403708c]
- Updated dependencies [dfefbac]
    - @party-stack/ontology-storage@0.2.2

## 0.2.1

### Patch Changes

- @party-stack/ontology-storage@0.2.1

## 0.2.0

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

- 92480df: Add Effect-based transactional Tables with portable JavaScript/bigint/Temporal values,
  native SQL / user-space IndexedDB indexes, subset queries, and separate sparse-overlay composition.
  Provide IndexedDB, in-memory, and SQLite/PostgreSQL implementations with a shared conformance contract.
  Add an opt-in Effect library build/TypeScript preset and workspace development tooling.

    Port these experimental packages to ontology-storage, sql-ontology-storage, and
    indexeddb-ontology-storage. Add an ontology-derived object API with generated codecs,
    primary-key derivation, validated scalar paths, definition-drift guards, and native
    transactions. Keep the raw engine under explicit infrastructure exports. Document
    independent attachment-byte and replica-row retention without adding automatic GC.

    Allow storage models to derive codecs directly from ontology IR while retaining
    generated schemas for statically typed models.

### Patch Changes

- Updated dependencies [ca220d2]
- Updated dependencies [9298a20]
- Updated dependencies [92480df]
- Updated dependencies [99f5c47]
    - @party-stack/ontology-storage@0.2.0
