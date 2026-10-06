# Shared coordination

`@party-stack/coordination` owns transport, service routing, leadership, cancellation,
and retry semantics. Persistence, outbox, and blobs register namespaced services on
one coordination instance. The runtime persistence shim adapts this shared service
to TanStack's collection interface; it does not create another election or transport.

## Broadcast RPC outcomes

Before sending a call, the broadcast transport discovers the elected node and its
leadership term. Retries reuse the same request ID and target that same node and
term. The leader coalesces pending duplicates and retains completed responses until
the caller's retry window expires, even if `responseCacheMs` is shorter.

A lost response followed by a changed or unknown leader, or exhausted response
retries, produces `CoordinationTransportError` with code `INDETERMINATE`. The work
may have completed. Callers must reconcile its outcome before starting another
call. This contract applies to every service; handlers can have side effects even
when their method names suggest reads.

Retention is bounded at 1,000 pending or completed remote requests per leader. New
requests are rejected before execution when that capacity is occupied. Existing
requests keep their replay protection. The default completed-response retention is
30 seconds, so sustained remote throughput can encounter this limit. Local calls
do not occupy it.

The wire protocol is version 2. Coordinating tabs and workers must use the same
version.

## TanStack audit references

- [PR #1845](https://github.com/TanStack/db/pull/1845) introduced complete committed
  transaction routing, exact subset leases, durability errors, and retries limited
  to the original known leader and term. Our regression coverage includes lost
  responses, takeover, handler cleanup before election, row metadata, and rejected
  storage commits that must not advance positions or publish success. Subset
  acquisition IDs are scoped by collection and options identity; releasing one
  collection cannot remove another collection’s lease for the same options object.
- [PR #1868](https://github.com/TanStack/db/pull/1868) covers hydration fairness,
  replay/coalescing, per-collection deduplication, and coordinator lifecycle cleanup.
  We scope mutation envelope deduplication by collection and release cached collection
  positions after the last subscription closes.
- [PR #1899](https://github.com/TanStack/db/pull/1899) fixes first-write startup
  routing. We exercise RPC immediately after construction, before election settles.

These are deterministic transport tests with fake BroadcastChannel and Web Locks,
plus SharedWorker tests using MessageChannel. They do not establish real browser
crash recovery or SQLite/OPFS behavior. Cold-hydration scheduling and replaying live
subset leases across broadcast leader takeover need a separate audit; this change
makes no parity claim for those cases.

## Collection and runtime lifetimes

Call `collection.cleanup()` when a dynamic collection is no longer needed. The
runtime shim removes its cached stream position after
its last subscriber closes. Host-side positions are additionally bounded at 128
entries for client-only collections with no local subscription. Evicted positions
are restored from durable stream state (or an atomic resume snapshot). Subset owner unregistering unloads outstanding leases;
failed subset loads are also explicitly released. Mutation and relay histories
are bounded at 1,000 entries each, rather than cleared on collection unsubscribe,
so response-loss deduplication remains safe.

Broadcast replies expire while idle. Closing coordination clears cached replies,
event listeners, service clients, pending requests, and leadership waiters. Handlers
must cooperate with cancellation and finish cleanup for shutdown to complete.

IndexedDB initialization bookkeeping retains at most 128 collection IDs per
adapter. Eviction does not delete persisted data; the next access revalidates the
schema. Each operation captures its epoch so concurrent cache eviction cannot
invalidate that operation. Adapter close clears this bookkeeping and closes the
connection, including when close happens during database opening.

Runtime persistence remains a `PersistenceAdapter`, shared by the runtime's
collections. The shim uses that adapter and the runtime's generic coordination
service. Per-collection schema selection and adapter ownership are deferred.

Call collection cleanup and drop collection references when they are no longer
needed. Runtime cleanup closes the shared database. Collection cleanup alone does
not close a database still used by other collections.
