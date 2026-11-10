# Ontology composition and scoped capabilities — future work

## Status

Deferred from v0 by request on November 3, 2026. The discussion below records a
direction, not an implemented or finalized API. Do not make the Connect/installation
cleanup depend on introducing composition, ontology interfaces, or multiple feeds.

For v0 retain Foundry's explicit users integration: a configured logical object
type and lens route its subset loads/profile pictures to the Admin API, while
other object types use ordinary ontology APIs. User freshness uses the existing
per-subset polling recommendation rather than the ontology websocket watcher.

## Definition graph and interfaces

- Define named ontology-level contracts bundling required object types, named
  value types, relationships and, where needed, query/action signatures. Avoid
  independently injecting arbitrary object types with no compatible schema contract.
- Pure, portable definitions declare imports and lens bindings. Compilation must
  not require open backends, credentials, replicas, or SDK/TanStack collections.
- Imports have scoped names. Explicit bindings connect nested requirements to
  concrete definitions; coincidentally matching names never establish a binding.
- Preserve the definition/binding graph and source provenance even if execution
  flattens mappings or combines lens operations. Validate primary-key identity,
  property compatibility and dependency closure.
- Effect services/Layers acquire the source implementations and own their scoped
  lifecycle. Portable IR never embeds Effect tags or runtime handles. Static
  definitions/codegen may expose typed requirements; dynamic IR still needs
  runtime contract validation.
- The first implementation should support read composition. Existing source
  actions may be forwarded wholly to their owner when mapping is supported;
  cross-import action bodies/workflows and compensation remain later work.

## Backend and replica boundary

Instantiate the graph as an ordinary backend. Callers can query/serve it directly
or add an ordinary Replica. Preserve base/outbox/overlay, demand, pins, and GC;
do not introduce a parallel composed-replica implementation or require a replica
for every import.

An owned ontology defines its transaction boundary. Composition adds neither a
distributed transaction nor a globally consistent snapshot. Source-local loads
can be delegated after lens rewriting; cross-source correlations use the query
engine and dependency-aware refresh.

## Scoped capabilities and change feeds

- Report actual per-object-type capabilities, including subset invalidation,
  refresh recommendations and durable change-feed coverage. Apply the same
  negotiation across native and protocol backends.
- Preserve subset-specific decisions: a cross-import predicate requires observing
  all relevant dependencies or refreshing by another supported strategy.
- Model independently resumable feeds with stable source identity, feed identity,
  covered object types and opaque positions. A native owned journal can be one
  feed covering multiple types; providers may have per-type feeds.
- Persist separate positions and scope reset/expiry recovery to the affected
  source/feed. Preserve source transaction batches without inventing an ordering
  among independent sources. Reconcile receipts using their owning source/feed.
- Scope freshness, source health/authentication and action idempotency to the
  relevant source/type/action. An Issue watcher must not keep User coverage live.
- Foundry edits history can be enabled per object type. Enabled history alone is
  not an implementation of retained, resumable changes; advertise that capability
  only once cursor/snapshot/recovery guarantees are implemented.

Current gaps requiring deliberate design: OntologyBackendService has one changes
hook, Replica persists one journal head, freshness/receipt logic makes backend-wide
journal assumptions, and protocol Describe exposes global capability booleans.
Extending this requires more than attaching a per-type metadata table.

## Validation direction

Keep a simple eager multi-source evaluator as an oracle for composed execution.
Use property tests for lens/query rewriting, nested bindings, key preservation and
cross-source predicates. Exercise mixed watch/poll/feed capabilities, independent
cursor expiry, source restart/authentication, receipt reconciliation, attachment
provenance and scoped cancellation. Verify that projection cannot broaden source
access or expose privileged journals through a public composed view.
