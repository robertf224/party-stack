# Future subset and hierarchical query subscriptions

Deferred October 27. Do not add subscribeSubset in this v0 checkpoint. Use cursor,
not checkpoint, for a continuation token. A cursor remains opaque: its encoding can
contain a provider handle, offset, query identity and source generation. It is scoped
to the source/query that issued it and is not automatically comparable to another
query's cursor. This terminology does not imply every provider supports resumption.

The current APIs cover subset snapshots, subset invalidation hints and a source-wide
committed change journal. They do not yet express a query-scoped stream of snapshots
and result changes. A future API should support initial/replacement results, atomic
result batches, invalidation-only providers and explicit reset after expired history.
Rows, query membership and the corresponding cursor must be persisted atomically.
Do not add a parallel adapter-maintained materialization merely to hide these states.

Electric shapes have per-shape handles/offsets and snapshot/stream coordination.
Neon Realtime exposes replacement results and atomic upsert/remove batches. These
are useful design references, not already implemented integrations. Result-row IDs
and query removals are not necessarily ontology object IDs or object deletions.
Overlapping feeds need version/publication rules so older observations cannot
overwrite newer base state. Aggregate/projected rows require result storage rather
than treating every result as an authoritative object row.

## Owned journal support

The existing owned backend already has the core durable primitive: action mutations,
receipts and ordered committed changes share a transaction, and a snapshot carries
a coordinated journal cursor. A query feed can start from a snapshot and tail the
journal after that position; subscribing to wake-up hints before reading avoids a
notification gap. Hints only wake pulls and may coalesce; they are not durable data.

What is still required:

- Maintain each query's selected membership and emit removals when objects leave
  its result, without reporting those as global object deletions.
- Recompute/maintain dependencies for hierarchy, joins and per-parent ordering/limits.
  Filtering each changed row independently does not repair a limited window or a
  parent whose related child changed.
- Preserve initial-snapshot and transaction boundaries, and reset selected results
  after journal expiry without deleting unrelated cache/outbox state.
- Authorize initial results, membership changes and dependencies under the same
  authenticated context and schema/policy revision.
- Initially, reevaluating an affected query and diffing results could be correct;
  server IVM is an optimization requiring separate work. The existing journal does
  not itself implement a query executor or a full query delta protocol.

Keep source-wide journal notifications for now. A replica uses those to recover
commits and receipts across its demanded types, independently of individual subset
watchers. watchSubset alone cannot provide journal-only sources with a global wake
signal unless we open and combine redundant per-query subscriptions. Both watch
APIs currently return hints, not row payloads; that distinction must remain explicit.

Sources: [Electric protocol](https://electric.ax/docs/sync/api/http),
[Electric subset snapshots](https://electric.ax/docs/sync/api/clients/typescript#requesting-subset-snapshots),
[Neon raw subscriptions](https://neon.com/docs/realtime/guides/subscribing).
