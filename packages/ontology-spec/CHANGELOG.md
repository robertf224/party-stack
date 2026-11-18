# @party-stack/ontology-spec

## 0.4.0

### Minor Changes

- d83db65: The JSON codec keeps dates and timestamps typed in `unknown` positions. They encode as `{"$type": "date" | "timestamp", "value": "<ISO 8601>"}`; every other value, plain strings included, encodes exactly as before, and existing JSON reads back unchanged. `$type` is reserved in `unknown` values, and decoding accepts it for any scalar kind (`string`, `boolean`, `integer`, `float`, `double`, `date`, `timestamp`). Typed positions are unchanged. `encodeUnknown` and `decodeUnknown` apply the same rule to values with no IR target, such as a stored query document. Query literals holding `Temporal.Instant` or `Temporal.PlainDate` now type as timestamp or date, so they compare with timestamp and date properties.

## 0.3.1

### Patch Changes

- b9eb3bd: Missing-value and empty-list checks push down exactly instead of forcing query-result demand. `isUndefined`/`isNull` work on every field type, including lists and structs. The query language gains a `length` expression (lists and strings; a missing value has length 0, as in TanStack DB), and TanStack's `length(list)` passes through to it. Storage accepts `length` only as an emptiness test (`length(list)` compared with 0 or 1), which it lowers to "missing or empty" with a new `isEmpty` predicate; other uses still need query-result demand.

    Foundry filters were checked against the search API and corrected: `like`/`ilike` no longer sends term searches that dropped rows for substrings inside words, or leading wildcards that failed with a server error; a pattern that starts with a word is sent as a token-prefix wildcard. Ranges, `ne` and negations of exact filters are now sent exactly, and on arrays `isNull` answers "missing or empty".

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

## 0.3.0

### Minor Changes

- 501b4a5: Rename the expression helper from `row(name)` to `local(name)`, matching the
  underlying `localReference` expression. The helper can reference any locally
  bound value, including query rows and scalar map items.

    Update related query sources to `related(local("project"), "issues")`.
    `related` still accepts an expression; query sources currently require an ancestor
    local binding. The generated IR is unchanged, including persisted pin definitions.

## 0.2.0

### Minor Changes

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

### Patch Changes

- @party-stack/icons@0.2.1
