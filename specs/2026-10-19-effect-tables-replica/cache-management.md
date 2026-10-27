# Cache budgets and admission

October 26 checkpoint. Cached-proxy finite reads do not open child replication
sessions. The server exposes OpenClient only through an explicitly supplied protocol
source; LoadSubset does not call it. This is operation routing, not a per-request
heuristic that creates then discards a session.

Shared demand uses Effect RcMap: Scope owns request references and idle TTL owns
unused leases. idleDemandMs defaults to 60,000, maxSubsets to 1,024. Reusing a lease
renews its timeout from the last release. At capacity the oldest idle lease is
invalidated and released before admitting a new key. Admission is serialized; an
active request cannot lose its demand. If all slots are active, RateLimited is
retryable backpressure. No pending action or application row is deleted by admission.
Configured eager demand is separately scoped and not counted as an idle-cache slot.

This is a count bound on demand resources, not a byte budget. Releasing demand
removes retention roots; existing replica mark-and-sweep decides row/alias/byte
eligibility. Authoritative rows, pending actions and explicit offline pins must not
be evicted as disposable cache.

## Future work

- Independent budgets for in-memory working sets, persisted row caches, byte caches
  and transient transfers. Support explicit byte/count limits before automatically
  adapting them to platform free-space estimates (which are not uniformly available).
- Pressure-triggered idle demand release, bounded row/byte GC batches and storage
  headroom. Preserve active reads, pending-action dependencies and explicit offline
  pins. If protected data exceeds a budget, report pressure/admission failure rather
  than silently deleting it. Include journals, indexes and retained receipts in
  persisted accounting; demand count alone is not a storage estimate.
- In-memory query result windows, effect queues, tracing and provider responses also
  consume memory when canonical rows live in SQL. Do not mirror entire SQL tables
  into memory for a DO cache. Bound materialization and concurrent request work.
- RPC chunks provide framing/backpressure, not automatic end-to-end storage streaming.
  Upload handling currently accumulates parts into a Blob before staging; download
  providers return a Blob before chunking. Add total/per-principal/concurrent byte
  limits and streaming byte-store sinks so large files need not fit in the isolate.
- Test pressure while actions reconcile, demand overlaps, transfers cancel, an idle
  entry is reused and server scopes close. Add instrumentation for retained bytes,
  pinned bytes and released/evicted demand so operators can choose budgets.

Cloudflare currently documents 128 MB Worker isolate memory and 10 GB per
SQLite-backed DO on the paid plan. Memory is shared at isolate level and must not
be treated as a separate guaranteed allowance for every object. Our DO Tables
implementation executes against native SQLite; SQL persistence does not eliminate
the working-set and transfer budgets above. Platform limits are deployment limits,
not sensible target cache sizes.

Sources: [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Worker memory limits](https://developers.cloudflare.com/workers/platform/limits/#memory).
