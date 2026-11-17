# @party-stack/ontology-storage

## 0.2.2

### Patch Changes

- b9eb3bd: Missing-value and empty-list checks push down exactly instead of forcing query-result demand. `isUndefined`/`isNull` work on every field type, including lists and structs. The query language gains a `length` expression (lists and strings; a missing value has length 0, as in TanStack DB), and TanStack's `length(list)` passes through to it. Storage accepts `length` only as an emptiness test (`length(list)` compared with 0 or 1), which it lowers to "missing or empty" with a new `isEmpty` predicate; other uses still need query-result demand.

    Foundry filters were checked against the search API and corrected: `like`/`ilike` no longer sends term searches that dropped rows for substrings inside words, or leading wildcards that failed with a server error; a pattern that starts with a word is sent as a token-prefix wildcard. Ranges, `ne` and negations of exact filters are now sent exactly, and on arrays `isNull` answers "missing or empty".

- 403708c: Fix native Expo sign-in, startup responsiveness and replica action helpers.

    - Connect accepts a native app's custom-scheme OAuth redirect when it exactly
      matches the trusted OAuth application registration. Provider endpoints keep
      the HTTPS/localhost policy; unsafe schemes and unregistered redirects are
      rejected. Callbacks now compare scheme, host and path explicitly, since
      `URL.origin` is `"null"` for custom schemes.
    - The Expo polyfill runs React Native immediates in short time slices. React
      Native implements `setImmediate` with microtasks, so Effect fibers never
      yielded to the event loop and long ontology work starved rendering and timers.
    - The Expo polyfill adds `AbortSignal.prototype.throwIfAborted` and tags React
      Native's global `Response` prototype, so Expo fetch responses interoperate with
      OAuth token handling.
    - `configureNativeSha256` lets platform runtimes provide SHA-256 for bounded
      content digests; the Expo runtime uses Expo Crypto.
    - Managed replica routes resolve action parameters with the replica when the
      provider backend has no resolver, matching the advertised capability.

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

- Updated dependencies [b9eb3bd]
- Updated dependencies [dfefbac]
    - @party-stack/ontology-spec@0.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [501b4a5]
    - @party-stack/ontology-spec@0.3.0

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

- 99f5c47: Consolidate native blob metadata in ontology-storage and remove the separate blobs
  package and unused TanStack metadata collection. Maintain schema-derived attachment
  references with object and replica transactions, distinguish identity retention
  from byte pins, and collect unreferenced staged uploads/metadata after a configurable
  orphan grace. Add scoped file-backed reads and atomic receipt binding with durable
  recovery when local mapping conflicts.

### Patch Changes

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

- Updated dependencies [92480df]
- Updated dependencies [9298a20]
- Updated dependencies [05420e3]
    - @party-stack/ontology-spec@0.2.0
