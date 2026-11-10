# @party-stack/ontology-spec

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
