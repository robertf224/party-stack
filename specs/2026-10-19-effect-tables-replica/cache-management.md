# Cache retention, budgets and admission

Updated October 29. Cached-proxy finite reads do not open child replication
sessions. The server exposes OpenClient only through an explicitly supplied
protocol source; LoadSubset does not create then discard a session.

## One replica demand policy

Demand retention belongs to the replica, not the server role. All consumers use
the same Effect RcMap lease owner: UI queries, protocol children and cached-proxy
requests. There is no second cached-proxy timeout.

```ts
const cache =
    yield *
    makeReplica({
        ...replicaOptions,
        demand: { idleRetentionMs: 60_000, maxSubsets: 128 },
        objectCacheGc: { minUnusedAgeMs: 10 * 60_000, sweepIntervalMs: 60_000, maxCandidates: 100 },
    });
const server =
    yield *
    makeOntologyServer({
        ...serverOptions,
        kind: "cached-proxy",
        backend: upstream,
        cache,
    });
```

`idleRetentionMs` defaults to zero (immediate release) and `maxSubsets` to 1,024. The cap
counts distinct active **and** idle subsets, including eager demand. These are
resource counts, not byte estimates. Settings are also available on LiveOntology
construction; hosted compositions pass the policy to their underlying replica.

- Each caller's scope owns a reference. Releasing one caller leaves other
  consumers intact. Status reports active `references` and optional `idleUntil`.
- After the final caller releases, the idle timer retains the upstream demand,
  watch and transactional retention root. Reacquisition cancels expiry; the
  next final release starts a fresh idle period.
- Expiry closes the resource scope, releases roots and interrupts in-flight
  demand-only IO. It does not cancel outbox submission/reconciliation.
- At capacity the oldest idle lease is invalidated before admitting a new key.
  Active work is protected. If all slots are active, the new distinct demand
  receives retryable `RateLimited`; there is no unbounded wait queue.
- Closing the replica's owning scope releases both active and idle leases.
- Row and blob GC remain separate. Ending demand makes unpinned rows eligible;
  ordinary mark-and-sweep applies age/grace and outbox/reference protection.
  Idle demand does not mean a timer will delete its data at exactly that time.

## TanStack query GC

TanStack can supply the warm lifetime for UI navigation. In the installed
versions, ordinary live-query collections default to five seconds, but React's
query hooks create collections with a 1 ms GC time. Source collections' default
five-minute GC is a different lifetime: individual subsets can unload while
other queries keep the source collection alive. Explicit live queries can
configure `gcTime`; the integration regression verifies that their source demand
remains retained until query GC and that reuse renews the lifetime.

For now, avoid stacking a long TanStack query lifetime and a long replica idle
lifetime unintentionally. A UI can leave `demand.idleRetentionMs` at zero and retain its
query. Cached proxies can configure replica idle demand without depending on
TanStack. Raw subset replacement/filter changes can release acquisitions before
the entire query collection's GC; query GC is not a universal per-subset policy.

## What is bounded and what still needs work

The implementation bounds demand count, delivery comparison/staging records and
bytes, frames, subscriptions, client sessions, upload registries/queues and
recent diagnostics. Results and journal history have configurable retention;
explicit Infinity is intentionally unbounded. Connect expiry and serverless
maintenance need a scheduler/alarm; TTL metadata alone does not run cleanup.

The installation's successful-open cache is explicitly owned: close individual
ontologies or its installation scope. It has no practical automatic capacity or
idle eviction. We must not silently evict a live ontology another component uses.
It is not suitable as an arbitrary-key request cache without that ownership work.

Replica startup now assumes one designated owner of its persistent namespace and
clears abandoned query/read leases. Pins, pending actions and their dependencies
remain durable. Blob IO recovery uses storage-local active scopes. No Runtime
actor-liveness hook or Web Lock owner registry is required. Tabs use RPC and
memory storage, not direct access to the owner's private tables.

Memory and disk budgets are not implemented by the new demand count cap. One
active broad subset can still contain many rows. Incremental delivery comparison
state is persisted in Tables and scanned in batches; that does not eliminate
finite query working sets, provider response arrays, IVM state, indexes or byte IO.
Current byte paths stream with bounded queues; there is no longer a mandatory
Blob buffer at every transport/store boundary. A provider may still buffer.

## Initial knobs for Gateway and future pressure handling

Existing controls to start with:

1. Replica `demand.idleRetentionMs` and `maxSubsets` for reuse and bounded subscriptions.
2. `objectCacheGc.minUnusedAgeMs`, `sweepIntervalMs` and `maxCandidates` for the
   desired object-cache age and bounded cleanup work. Blob GC has independent
   byte/orphan grace policies.
3. Delivery `maxSubscriptions`, `maxRecords`, `maxBytes`, frame size and ACK timeout.
4. Client session count/lease/result windows for actual replica children. Stateless
   cached metadata reads do not need a child session.
5. Upload concurrent/per-owner/size/time limits for byte-transfer work.

For metadata cache DOs, a small explicit demand count and minute-scale idle/row
retention are reasonable starting points, to be measured against actual data.
Per-session DOs isolate workloads but do not supply a separate guaranteed heap.
Cloudflare documents 128 MB isolate memory and 10 GB SQLite storage per DO on Paid
(1 GB on Free); multiple DOs may share isolate memory. Native SQLite avoids a
mandatory full RAM mirror, but large finite reads still allocate memory.

Next budget primitives should be separate: persisted cache bytes (including
indexes/journals), blob bytes, finite query/result bytes and concurrent working
sets. Start with explicit high/low watermarks before adapting to platform space
estimates. A platform usage estimate can trigger early idle-demand release and
bounded row/blob sweeps, but should not be the sole admission check.

Pressure handling must preserve active reads, pending-action dependencies and
explicit pins. If that protected working set exceeds its budget, report pressure
or reject new work rather than silently deleting it. A disk sweep cannot rescue
a request that has already allocated an oversized response in memory; request
budgets and streaming/backpressure are also necessary.

Sources: [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Worker memory limits](https://developers.cloudflare.com/workers/platform/limits/#memory).
