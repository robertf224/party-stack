# @party-stack/ontology-replica

## 0.3.1

### Patch Changes

- 6038606: Fix an action freezing a client by downloading whole object types it never read. When a receipt named a type without specific objects, confirmation read back that entire type, for every such type. Foundry receipts without edits named every type in the ontology, so one action on a broad ontology could download types of hundreds of thousands of objects.

    A receipt now never loads data no reader asked for. For a type named without keys, the replica marks that type's stored coverage stale, so a later demand reloads it, and reads back only the subsets readers demand right now, so the action's effects still show without a gap. History recovery no longer reads whole types either.

    The Foundry adapter always requests an action's edits, so a response without edits now means the action changed nothing (for example, an action with no logic), and nothing is read back.

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
    - @party-stack/ontology-backend@0.3.0
    - @party-stack/connect@0.3.1
    - @party-stack/runtime@0.6.1

## 0.2.3

### Patch Changes

- 40a3627: Connect renews rejected credentials for every connector. When a request fails as
  `Unauthenticated`, Connect renews the OAuth token once (shared by concurrent
  rejections), sends a request without a body again, and fails a request with a body as
  retryable for its caller to retry. A credential that cannot be renewed moves the
  connection to `needs-auth`. Access tokens are also renewed a minute before they
  expire instead of five seconds.

    Breaking: `ServiceConnector.acquire` no longer receives `refreshCredential`;
    connectors report a rejection as `Unauthenticated` and Connect handles it.
    Salesforce's connector no longer retries on its own.

    `ConnectionAccess.authentication` is now a `ConnectionLifecycle`: the connection
    monitor plus `credentialVersion` and `refresh(version)`. Pass it to the replica as
    before. When a source rejects an open watch as `Unauthenticated`, the replica asks it
    to renew the credential and reopens the watch once the renewed credential is active.

- dfefbac: Speed up opening large definitions, especially on mobile JavaScript engines.

    - Cache definition signatures, definition hashes and compiled Effect codecs per
      definition object. Opening one route previously recomputed them for the server,
      replica, policy and every view. Definitions must not be mutated after use.
    - Decode persisted values with a single-pass validating decoder instead of a
      recursive Schema union. The accepted version-2 format is unchanged.
    - Same-runtime local clients share the server's validated description, and
      serialized clients no longer re-encode and decode a Describe response that the
      RPC client already decoded. Caller-retained descriptions are still copied.
    - The replica partition catalog reuses decoded records and skips rewriting an
      unchanged retained definition when a route reopens.

    A local benchmark opening a 74-object-type, 189-action Foundry definition through
    `localClient` dropped from about 420 ms to 230 ms for the first view, 437 ms to
    190 ms after a restart, and 184 ms to 40 ms for an additional view.

- 40a3627: Outbox entries report whether their prediction is reflected locally. `prediction` is
  `"applied"`, `"dropped"` (the last replay failed; `predictionError` says why, and the
  action is still pending and sent) or `"none"` (confirmed visibility, or predicted by a
  parent). Servers project the prediction error like other action errors.
- 40a3627: A pending action whose local prediction fails when the outbox rebases (for example, newer data changed what it reads) no longer blocks the outbox. Only its prediction is dropped: it stays pending, is still sent, and the source decides its outcome; later actions keep replaying. Failures reported by the source still pause the outbox as before.
- 40a3627: `outbox.prediction: "source"` makes a child replica forward actions without resolving
  or predicting them. Its parent resolves parameter defaults, predicts against its own
  data and replicates the result back, honoring the requested visibility. Use it for an
  embedded child, such as a form WebView, that holds only the rows it displays.
- 2f8567b: `syncOnce` fails with a non-retryable `Unauthenticated` error while the replica's
  connection needs to sign in again or is signed out. Background sync still waits
  for authentication silently, but an explicit checkpoint (such as pull-to-refresh)
  no longer reports success after skipping the backend.
- d5ca58e: Watch supervision backs off with jitter up to five minutes, resets after an
  acquisition stays open for a minute (not only after a delivered change), records
  the failure kind and message on `Replica.watchAttempt`, and reports whether each
  attempt opened and delivered changes.
- 03f4516: A subset watch that fails before opening or before delivering any change no
  longer invalidates its object type's coverage or forces a snapshot reload. The
  demand is marked unmaintained and revalidates by coverage age; successful
  re-acquisitions still repair the gap. Non-retryable watch failures fall back to
  the route's configured poll interval, or to age-based revalidation, instead of
  retrying.
- 40a3627: `server.syncOnce(target, { revalidate: true })` (and `replica.revalidate`) reloads
  every demanded subset, including subsets a healthy realtime watch reports as current.
  Use it for a refresh the user asks for, such as pull to refresh. Rows stay visible
  while they reload.
- 40a3627: Watches can report row changes instead of only invalidating. An adapter's watch may
  emit `{ changes }` with `put` (the complete row), `exit` (left the subset; the replica
  reads it back by primary key to tell a change from a deletion) and `delete`. The
  replica applies them without reloading the subset, but holds them while one of its own
  actions is in flight or awaiting read-back, and reloads instead.

    Foundry watches report object updates as puts (Foundry sends every property with a
    value) and removals as exits. Reference updates and anything that cannot be decoded
    remain invalidation hints.

- Updated dependencies [40a3627]
- Updated dependencies [b9eb3bd]
- Updated dependencies [403708c]
- Updated dependencies [dfefbac]
- Updated dependencies [40a3627]
- Updated dependencies [40a3627]
- Updated dependencies [cc43c56]
- Updated dependencies [40a3627]
    - @party-stack/connect@0.3.0
    - @party-stack/ontology-spec@0.3.1
    - @party-stack/ontology-storage@0.2.2
    - @party-stack/ontology-backend@0.2.2
    - @party-stack/runtime@0.6.0

## 0.2.2

### Patch Changes

- e971546: Load snapshots for different object types concurrently within a sync pass.

    A sync pass previously installed every uncovered demand one after another, so a
    screen that reads several object types waited for one network round trip per
    demand. Demands are now grouped by object type: groups load concurrently, while
    loads within one type stay ordered so a completed superset still satisfies later
    demands of that type without another fetch.

## 0.2.1

### Patch Changes

- Updated dependencies [501b4a5]
    - @party-stack/ontology-spec@0.3.0
    - @party-stack/connect@0.2.1
    - @party-stack/ontology-backend@0.2.1
    - @party-stack/ontology-storage@0.2.1
    - @party-stack/runtime@0.5.1

## 0.2.0

### Minor Changes

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
- Updated dependencies [92480df]
- Updated dependencies [9298a20]
- Updated dependencies [05420e3]
- Updated dependencies [92480df]
- Updated dependencies [99f5c47]
    - @party-stack/ontology-backend@0.2.0
    - @party-stack/ontology-storage@0.2.0
    - @party-stack/runtime@0.5.0
    - @party-stack/connect@0.2.0
    - @party-stack/ontology-spec@0.2.0
