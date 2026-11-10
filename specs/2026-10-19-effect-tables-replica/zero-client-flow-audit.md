# Zero client flow audit

Source review, November 9, 2026. This pins Rocicorp's official monorepo at
[`fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9`](https://github.com/rocicorp/mono/tree/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9),
the same revision as the earlier server/CVR review. Local copies used for this
review were checked against the pinned Git tree's blob hashes. This describes
that source, not a claim about the version or configuration deployed by every
Zero application. No Zero performance benchmark was run here.

Zero's main advantage is a deliberately specialized, memory-first read and
prediction path. IndexedDB supplies a previous consistent root; cached rows
are loaded into synchronous sources in bulk, then query pipelines are attached.
Ordinary row changes advance those pipelines incrementally. Persistence runs
separately. This explains a meaningful architectural difference without treating
IndexedDB itself, Effect, or the number of data copies as the explanation.

## Startup and the first useful query

1. Each Zero instance creates its own `IVMSourceBranch` and Replicache instance.
   Replicache creates `perdag` over its configured persistent KV store and a
   `LazyStore` called `memdag` over `perdag`. LazyStore owns independent memory
   heads, memory-only chunks, and an LRU for loaded persistent chunks. Writes to
   it do not write the persistent store. The default source-chunk cache limit
   in this revision is 100 MiB; memory-only chunks are separately retained by
   reachability. [Construction](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/replicache-impl.ts#L596-L621),
   [LazyStore contract](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/dag/lazy-store.ts#L20-L60).
2. Opening initializes a client/group in persistent storage and sets the memory
   main head to the stored head. It then awaits `ZeroRep.init` before resolving
   readiness. `ZeroRep.init` scans the cached row prefixes into row diffs, advances
   the synchronous sources, and hydrates queries registered during startup.
   This is real local hydration; Zero does not make disk access synchronous or
   wait for a network refresh before loading the old local root.
   [Open ordering](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/replicache-impl.ts#L738-L777),
   [init](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/zero-rep.ts#L57-L67),
   [cached-row scan](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/ivm-branch.ts#L352-L376).
3. Pending query pipelines are deliberately **not attached while cached rows
   load**. Otherwise every imported row would flow through every already-mounted
   query. Contiguous additions are grouped by source. An empty, unconnected
   `MemorySource` with only its primary index builds a B-tree bottom-up from the
   batch, sorting only if necessary; it does not insert each row through the
   ordinary live push path. [Deferred pipelines](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/context.ts#L45-L53),
   [grouped additions](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/ivm-branch.ts#L466-L505),
   [bulk source load](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zql/src/ivm/memory-source.ts#L492-L522).
4. Pipeline hydration runs in roughly 12 ms slices, yielding **between pipelines**.
   Hydrated views are held and released together in one synchronous batch at the
   end. A hidden tab skips the timer fallback; supported browsers use
   `scheduler.yield()`. This improves responsiveness, not total hydration work,
   and one large pipeline can still exceed the slice. [Hydration](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/context.ts#L132-L210).

Zero therefore also has multiple representations: persistent DAG, memory DAG,
and synchronous IVM sources. Its source explicitly notes the cost of maintaining
the synchronous copy. The important distinction is how each representation is
built and advanced, not an absence of copying. [Source comment](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/context.ts#L35-L41).

## Availability, completeness, preload, and React

Zero distinguishes a query's previous confirmed resident answer (`cached`) from
confirmation on the current connection (`complete`). The first persisted
got-query diff can grant cached status. Later live changes cannot invent that
historical claim; eviction revokes it. The first applied poke after reconnect
reconfirms the got set. Materialized views gate either claim on their pipeline
actually being attached, so a ready flag cannot outrun local hydration.
[Query inventory](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/query-manager.ts#L95-L107),
[persisted/live handling](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/query-manager.ts#L157-L201),
[view readiness](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zql/src/query/query-delegate-base.ts#L410-L455).

`preload` registers server demand and returns cleanup plus separate `cached` and
`complete` promises; it does not construct a materialized client query pipeline.
Zbugs deliberately preloads its issues/comments, users, labels, and projects,
with its current app policy using a 10-second TTL. That can explain instant
navigation in that app, but does not explain or excuse slow hydration of data
already on our device. [Preload implementation](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zql/src/query/query-delegate-base.ts#L313-L368),
[Zbugs preload](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/apps/zbugs/src/zero-preload.ts#L1-L10),
[app TTL](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/apps/zbugs/src/query-cache-policy.ts#L1-L3).

The React hook uses a client/query-keyed view store and `useSyncExternalStore`.
Its default Suspense mode accepts a nonempty partial result, or a cached/complete
answer even when empty. Explicit `suspendUntil: 'complete'` waits for the current
server. This is a public semantic choice, not permission to label a partial
answer complete. View updates retain immutable row identities and avoid a new
React snapshot when data, result type, and error are unchanged. A short deferred
teardown handles subscribe/unsubscribe cycles. [Suspense contract](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-react/src/use-query.tsx#L145-L160),
[hook](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-react/src/use-query.tsx#L310-L330),
[snapshot identity](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-react/src/use-query.tsx#L680-L730).

## Live updates and local mutations

`MemorySource` stores direct row objects in comparator-based B-trees. Secondary
order indexes are constructed lazily from sorted primary data and retained for
the source lifetime; the source comments explicitly trade memory for avoiding
index churn on navigation. A normal change updates its indexes and pushes row
add/remove/edit events into connected pipelines. `ZeroContext.processChanges`
advances the expected source head, batches view updates, and notifies commit
listeners after advancement. This is row-level incremental maintenance rather
than reissuing every query for a type. [Index lifetime](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zql/src/ivm/memory-source.ts#L209-L258),
[row changes](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zql/src/ivm/memory-source.ts#L525-L582),
[transaction publication](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/context.ts#L306-L347).

A local mutation opens a memory DAG write, records the invocation, runs the
mutator, and commits with diffs. It advances IVM, starts pushing, fires matching
subscriptions, and **schedules** persistence. The local mutation result does not
await that scheduled IndexedDB commit. Persisting uses a separate serial lock,
gathers newly memory-only chunks, reconciles concurrent client-group mutations,
and advances the persistent group head transactionally. This durability boundary
is important: Notes already renders optimistic enqueue in its memory tab before
the worker's durable handoff. The distinction concerns the persistent replica's
acceptance checkpoint, not a requirement that our UI wait for IndexedDB. We
should not copy Zero's scheduling and silently weaken that durable checkpoint.
[Local mutation ordering](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/replicache-impl.ts#L1978-L2064),
[persist lock](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/replicache-impl.ts#L1405-L1457),
[persist transaction](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/persist/persist.ts#L174-L285).

Rebase is still real work. Zero forks the synchronous source branch, patches
it to the desired commit, and replays pending mutations in order. The B-tree
fork shares nodes until changed. Each replayed mutation gets its own fork; a
failed prediction is discarded without removing the pending server mutation.
The resulting head diff advances the main IVM branch once. This is not a system
that eliminates rebase, but it avoids copying an entire source on each fork.
[Branch fork](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/ivm-branch.ts#L295-L338),
[COW tree](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/shared/src/btree-set.ts#L28-L43),
[replay failure](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/db/rebase.ts#L109-L147),
[final advance](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/replicache-impl.ts#L989-L1043).

## Disk layout, multi-tab coordination, and scheduling

The persistent KV store holds DAG chunks, heads, and reference bookkeeping, not
one IndexedDB object store/index per application query. A B-tree chunk holds
multiple entries. The IDB adapter buffers KV changes and issues their native
writes together on commit; it requests relaxed transaction durability. Thus a
1,400-row comparison against our portable row-plus-index-entry format is not a
comparison of identical physical work. Exact request amplification depends on
chunk shape and changed data; this review did not measure it.
[Chunk representation](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/btree/node.ts#L38-L60),
[DAG storage](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/dag/store-impl.ts#L159-L180),
[IDB commit](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/kv/idb-store.ts#L171-L207).

The examined browser path has a per-instance memory view and connection, with
shared persistent client-group state. After persistence it broadcasts a small
client/group notification; matching instances schedule refresh from the shared
store. Refresh gathers missing chunks before taking the memory write lock,
suspends source-cache eviction while doing so, replays local mutations, and
advances IVM before releasing control. Its code explicitly calls out avoiding
IDB cache misses under the memory write lock because they block queries and
mutations. This path is not a central SharedWorker serving every tab's query.
Also, Zero normally disables disk refresh while connected/connecting, relying
on the connection's poke stream; it forces refresh after connection errors.
[Broadcast](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/on-persist-channel.ts#L24-L53),
[refresh preparation](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/persist/refresh.ts#L95-L167),
[refresh publication](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/persist/refresh.ts#L210-L310),
[connected refresh gate](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/zero.ts#L927-L939).

There are intentional timers, with different purposes:

| Work                       | Pinned implementation                                                                           | Consequence                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Local mutation visibility  | Memory commit, IVM advance, subscriptions; persistence scheduled afterward                      | Not delayed by the persistence throttle.                                                      |
| Persistence/disk refresh   | Debounced, serial, idle scheduling; 500 ms throttle and 1,000 ms idle timeout                   | Disk persistence and offline cross-tab refresh can lag local visibility.                      |
| Desired-query changes      | Default 10 ms batch, with explicit flush                                                        | Coalesces network demand; not a disk read delay.                                              |
| Incoming pokes             | Multipart buffers in memory; merge completed pokes per scheduled callback using `setTimeout(0)` | Avoids repeating diff/IVM for intermediate states; continues without `requestAnimationFrame`. |
| Initial pipeline hydration | 12 ms slices between pipelines; one final view release                                          | Trades first batch latency for responsiveness, without exposing half-hydrated views.          |

The scheduler promises a new scheduled run after a scheduling call, never merely
the already-running run. That preserves changes arriving during work rather
than losing a trailing update. [Persistence constants](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/replicache-impl.ts#L148-L152),
[scheduler semantics](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/replicache/src/process-scheduler.ts#L14-L33),
[query batch](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/query-manager.ts#L538-L565),
[poke buffering/merging](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-client/src/client/zero-poke-handler.ts#L54-L61).

## Implications for Party Stack

- **Keep resident availability separate from freshness.** Our cached coverage
  work follows the same useful distinction. Preserve strict complete acquisition
  for pins/read-back/read-once and never infer an empty answer from arbitrary
  cached rows. Zero's cached claim is query-specific; it does not establish a
  general predicate-overlap theorem for us.
- **Make cold import a native bulk operation.** The strongest concrete lesson is
  loading canonical rows and building indexes before attaching observers, then
  releasing one coherent batch. Our tab import still performs generic storage
  preparation, base/membership/retention writes, repair, visible comparison, and
  TanStack publication. A specialized bulk construction path needs to retain
  custom codec canonicalization, key/unique constraints, overlay semantics, and
  rollback. A second app-owned row cache is not the solution.
- **Do not use disk-format work everywhere in memory.** Zero's synchronous
  sources use direct row objects/comparators and persistent COW trees. Our
  portable codecs and hex index keys serve valid persistence boundaries, but
  repeating those conversions inside proven in-process operations is avoidable
  work. The landed shared preparation/entry helpers and decoded query results
  address measured instances. Broader representation changes need their own
  profile and independent correctness oracle.
- **Separate optional view recovery from durable write evidence.** Zero already
  buffers multipart pokes in memory and drops unfinished buffers on disconnect.
  Our producer now has a source-scoped bounded data-view buffer, while actions
  remain durable. Our receiver still puts every frame into staging tables,
  hashes it, then scans/decode those rows for application. In Notes these are
  memory tables, so the cost is not IndexedDB IO. The conversion trace's 1,395
  records across 11 frames spent 43.0 ms in staging `putMany`; the ten nonfinal
  installs totaled 66.3 ms including validation, hashing and header work. These
  are overlapping phase bounds, not a claim that a buffer would save 66.3 ms.
- **A receiver buffer needs a deliberate recovery contract.** Keep canonical
  immutable payloads, byte/record bounds, frame order and conflicting-replay
  checks, scope/supersession fencing, and atomic final data plus installed-position
  commit. Keep `beforeApply`'s separate durable receipt-evidence commit: losing
  an aliased/invalid row must not lose a committed action result. ACK only after
  installation; loss of the buffer must request replay or a fresh snapshot,
  never apply an unproved patch. The current receiver API takes one transactional
  store and an `apply(tx, batch)` callback; supplying a separate memory store
  through that API is not an atomic shortcut. No receiver redesign was made in
  this audit. [Receiver contract](../../packages/ontology-backend/src/delivery.ts#L924-L958),
  [staging and final commit](../../packages/ontology-backend/src/delivery.ts#L1080-L1163).
- **Coalesce at an owner with a version/dirty invariant.** Zero's merged pokes
  and scheduler preserve ordered bases and trailing work. That is a useful model
  for our duplicate invalidation/capture work, but blind timer debouncing or
  deduplication by object type could drop a later change. It is separate from
  the current single-tab hydration investigation.

This review supports bulk canonical hydration, coherent observer attachment,
incremental changed-row publication, and explicit view-buffer lifetime. It does
not establish a universal Zero cold-load budget, justify preloading to hide our
cached-import cost, or authorize changing durable mutation acceptance.
