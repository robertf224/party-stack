# Architecture simplification review — October 27

This reviews the storage, replica, transport, runtime and application composition
after the package moves. It records implementation boundaries, not a new layering
proposal. Query IR and server authorization remain the next major v0 feature work.

## Simplifications implemented

| Area             | Current responsibility                                                                           | Removed duplication                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| ontology-spec    | Portable definitions, values, expressions, lenses and optional Effect codecs                     | No second infrastructure schema language                                                           |
| ontology-storage | Tables, overlay composition, transactional blob metadata/roots/intents and byte service contract | No legacy persistence coordinator or separate blob metadata collection                             |
| ontology-replica | Base, own outbox, computed overlay, demand, recovery and retention                               | No duplicate parent-visible base or forwarded-action table                                         |
| ontology         | Replica host, application API, attachments and TanStack adapter                                  | One host composition for adapter and protocol connections; no standalone ontology-tanstack package |
| Connect          | Credential ontology plus native session-state tables/monitors                                    | No UI collection for connection state                                                              |
| Installation     | Native partition table and indexed per-user deletion                                             | No private TanStack collection merely to persist partitions                                        |
| Runtime          | Scoped platform tables/bytes/connectivity/keys/tracing                                           | No ontology/replica/TanStack dependency                                                            |
| ontology-server  | Committed backend operations plus optional speculative extension                                 | Common transport-independent RPC backend facet; HTTP only adds its streaming upload binding        |

Every replica owns local BlobStorage. A child sees its parent as the remote
attachment provider. Memory tabs, persistent workers and cloud children use the
same machinery with different byte services. There is no tab attachment delegation
branch. Cold reads stream through while filling the cache, and each cache is
collected independently. Metadata-only requests retain selected-field pushdown.

Server roles stay explicit: owned, proxy, cached-proxy and intermediate replica.
Only an intermediate publishes speculative state. Its ordinary adapter facet
still exposes committed upstream rows/journal; children that need predictions
use the speculative extension. This avoids inventing parent acceptance for an
authoritative server or opening sessions for finite cached-proxy requests.

## Distinctions that still earn their complexity

- **Confirmed base and inherited overrides:** one row can have an authoritative
  value and a different parent prediction. A single origin flag cannot preserve
  both values for confirmed-only reads. They compose into one logical base and
  are evicted together.
- **Own outbox inclusion:** an accepted child action stays in its own outbox
  until final outcome. An internal inclusion marker prevents replaying it twice
  while retaining its row/blob dependencies. This is not another public status.
- **External byte intents:** SQL/IndexedDB transactions cannot roll back R2/OPFS
  writes. Durable write/delete intents and generation fencing remain necessary.
  Cross-process byte transfer and action acceptance likewise require a checked
  handoff, not a claim of distributed transactionality.
- **Row, byte and history retention:** these protect different things. A retained
  row need not keep every remote byte cached. Session expiry must not delete an
  accepted unresolved action. Their bounded collectors can share scheduling later,
  but should not share one retention timeout.

## Remaining concrete cleanup candidates

1. **Retire the prototype owned `.protocol` API.** Production role composition
   now uses committed operations for owned servers. The trusted prototype still
   has test consumers and its own client bookkeeping. Port those conformance
   fixtures to committed operations or actual intermediate replicas before
   deleting it; do not delete recovery coverage along with the API.
2. **Extract incoming-state installation within Replica.** Adapter snapshots,
   committed journal batches and speculative snapshots have different evidence,
   but share row/schema/encrypted-copy/blob-root invariants. An internal installer
   can consolidate those without making providers fabricate parent sessions.
   Keep the transaction in Replica and avoid adding another public service.
3. **Finish native BlobManager construction.** It is scoped internally but still
   has a Promise facade used by the application attachment API. A native factory
   plus a thin application bridge could reduce scope plumbing. This is a focused
   refactor after streaming and cancellation behavior is stable.
4. **Delete legacy HTTP after Gateway parity.** The deprecated endpoints still
   carry relationship-aware authorization needed by Streamline. Removing them
   before Query IR/context binding and consumer acceptance would lose behavior.

## Bounds and practical limits

Client/session admission, unacknowledged submissions, result/journal retention,
cached-proxy idle demand, attachment transfer concurrency/size/timeouts and trace
buffers have explicit bounds. Cached-proxy idle eviction is separate from row GC.
Byte/available-space budgets remain future work; `cache-management.md` tracks them.
Authoritative data and unresolved own outboxes intentionally grow with application
state. Callers should not treat demand count bounds as storage byte budgets.

Speculative children still receive notifications followed by selected replacement
snapshots. Incremental retained deltas are **not implemented**. A later diff stream
can replace transport delivery while reusing base/outbox composition and retention;
full query IVM can then maintain selection membership without reevaluating it all.
General authorization of speculative outbox/base state remains separate from
stateless row/property projection.

Known deferred items remain: TanStack's delayed unloaded-query cleanup warning,
app-shell/service-worker caching for cold offline page startup, Postgres concurrent
journal publication, range caches, resumable uploads and query-driven byte pinning.
No new public abstraction is needed merely to rename these boundaries.
