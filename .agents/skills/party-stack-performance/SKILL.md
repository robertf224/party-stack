---
name: party-stack-performance
description: Diagnose Party Stack app loading, fragment/query churn, outbox latency and cross-tab delivery using app and replica traces. Use for performance investigations in this repository, not routine styling or generic Effect setup.
---

# Party Stack app performance

Start by identifying the actual ownership chain. Notes currently uses a memory tab
replica, an IndexedDB SharedWorker replica and a local HTTP-owned backend. Do not
assume every operation stays inside the tab because the URL is localhost.

## Measure the phase that is slow

Separate click-to-visible/editor-ready time, local enqueue, parent acceptance,
provider response and authoritative confirmation/local reconciliation. Outbox
`forwarding`, parent acceptance and execution reconciliation mean different things.
Trace normal first attempts separately from retries; inspect attempts, errors and
`nextAttemptAt` before blaming a retry timer.

Useful spans include `Replica.forwardParentActions`, `Replica.dispatch`,
`Replica.confirmReceipt`, `Replica.sync`, `Replica.rebase`, `Delivery.prepare`,
`Delivery.capture` and `Delivery.awaitAcknowledgment`. Long outer spans can include
gate or transaction waits. Report captured records separately from changed records;
the capture count includes objects as well as actions. Check result interest as well
as pending-queue interest: retained receipts for recovery should not make a fresh
queue observer import unrelated action history.

Record offline-pin settings. Rebuilding an unchanged pin graph can amplify an
edit into root/index writes; diff durable membership and byte roots. Also separate
the selected row region from action-result interests: changing the latter should
not throw away an already installed delivery witness. This is independent of IVM:
full recomputation may remain, but unchanged rows need no durable rewrite or resend.
Never reuse a producer's pending target until the receiver has installed it.

For cross-tab investigations, use two pages in the same explicit browser context
so they share the worker and storage. Measure when the second tab displays a change,
not just when an RPC returns. Record warm/cold state, queue length, active views and
whether tracing is enabled. Prefer an isolated browser and disposable fixture data.
Existing Notes probes are under `apps/notes/e2e`; inspect a probe before running it
because some create or archive test notes.

## Check query ownership before adding caches

- Define fragments/descriptors outside render and keep provider runtime, client and
  options identities stable. Preserve a parent query across presentation-only sidebar
  toggles when its data should remain ready.
- Declare fragments beside their consuming components. Parents compose child
  fragments into their own fragments or route queries. Do not preload every editor
  document in a global query/context to hide per-route readiness delays; discuss
  the measured query/subscription costs and fix the responsible layer.
- Singular `fragment.include` is a native correlated `include`. `useFragment` reads
  it directly; do not add another derived query. Paginated `useListFragment` is the
  deliberate exception: it reads the initial include, then re-roots its retained
  query recipe over the original sources and concrete parent bindings. It must not
  query the limited child Collection as its source. Native infinite windows own
  later pages; no parent limit updates or fragment row cache are needed. This costs
  one extra query per mounted included-list reader. The initial grouped include can
  still overfetch because per-parent limits are not pushed into source acquisition.
- Cached source rows do not make a freshly constructed derived query synchronously
  ready. Check remounts and query identity before adding a collection `.get` render
  fallback or another application row cache.
- Distinguish a watch's startup/reconnect repair boundary from a data-change hint.
  Opening a new filtered watch must not invalidate a full collection already
  maintained by another healthy live watch. A `reset` can reuse complete, installed,
  non-invalidated covering proof; an ordinary invalidation must still fence it.
  Cold, retired, failed, polling-only or narrower watches cannot supply that proof.
  Trace invalidation and full snapshot installation when offline folder switches
  are slow; downloaded bytes/rows alone do not establish live coverage.
- Measure first-render readiness as well as eventual query completion. A false
  initial suspension can turn a microtask into React's roughly 300 ms fallback
  commit delay. The generic React fixture `e2e/ready-latency.tsx` separates native
  action prediction from query startup without Notes, routing or TipTap. Its
  regressions assert no fallback for synchronous answers, rather than brittle
  wall-clock limits. TanStack currently starts a Suspense graph before preload
  marks demand, which can introduce asynchronous readiness for a synchronous
  adapter answer. The user explicitly approved a temporary React DB patch for
  startup ordering and initial-error retry lifetime on November 8, 2026. See
  `patches/README.md` for the exact scope. Flag every dependency patch to the user;
  do not silently add or expand patches. Workspace pnpm patches do not ship with
  published libraries. Prefer public APIs for other fixes and preserve genuine
  asynchronous suspension, error boundaries and SSR. Keep compiler-enabled browser
  tests: hook aliases must start with `use` so React Compiler treats them as hooks.
  Initial rejected loads must reach an error boundary without a render/load loop;
  dropping a failed Suspense retry resource on a zero-delay timer can lose its error.
- For delayed updates, compare native prediction, the source Collection value, its
  change event (including the previous value), and derived output. Correct source
  events can still sit behind an ordered query's pending completeness request.
  Compare requested and translated demand regions and whether an existing live
  acquisition already supplies them. A profile that previously downloaded all data
  can exercise different paths even after downloads are disabled.
- Check generated correlation expressions as well as source demand. TanStack's
  virtual `$key` is valid metadata but is not automatically indexed in the current
  RC. Ontology descriptors carry the primary-key field for indexed correlation.
  Generic collections retain their normal `$key` identity; an optional selector
  can choose an ordinary correlation field without repeating `getKey` by default.
- Inspect `filterExact` / `orderExact` and the translated limit. PartyStack source
  collections set `defaultStringCollation: { stringSort: "lexical" }` so their
  query ordering matches native storage. Generic TanStack collections otherwise
  default to locale ordering. An explicit locale/custom comparator can still
  disable limit pushdown; preserve correctness when that happens.
- A limited composite sort can make TanStack acquire every row tied on its first
  order field, even when the adapter returned the correctly ordered initial page.
  A leading boolean creates large ties. Count the actual rows and compare direct
  source reads, transfer/install and query time before attributing latency to size.
  Do not fake completeness, claim an on-demand source is eager, or add app caches
  to suppress the request. Fix repeated work in our adapter/engine, or propose an
  upstream change separately.
- Positive primary-key hits can be reused from successfully acquired live demand.
  Absence, an arbitrary filter or a limited window does not prove completeness.
  Fulfilled live regions can also supply narrower filters/windows under the existing
  conservative coverage rules. This is not arbitrary predicate/join/Top-K inference;
  cached rows alone do not prove a region complete.

## Preserve replication invariants while optimizing

Look for serial IndexedDB operations inside per-record loops, unchanged row/index
rewrites, unnecessary selection replacement and repeated snapshot work. Batch
independent operations within a transaction in bounded pages. Keep any temporary
comparison state transaction-local rather than adding a second long-lived row cache.
Check scalar encoding and decoding costs too: portable hexadecimal index keys are
needed at storage boundaries, not for every in-process string comparison. Key-only
ordered scans can select encoded rows first and hydrate only the selected values.
Retain the same scalar ordering and validation, verified against the encoded oracle.
For indexed implicit-key pages, apply the encoded key cursor before hydration and
stop only after enough residual matches fill the window. Otherwise 128-row delivery
pages can repeatedly hydrate the entire selection. Verify total hydration counts
across the complete scan, not only the first page. Preserve stable encoded index
entries on edits, including multi-entry membership, and validate all new entries
before changing storage. Record the extra previous-row read when weighing that
optimization against updates that change every index.

A high request count and a mostly-idle worker profile suggest storage round trips
or transaction waits. The IndexedDB span distinguishes transaction creation,
activation and body completion; its explicit-operation counter excludes keep-alive
sentinels. Effect spans identify nested phases, but do not replace CPU profiles.
Parallel fibers calling table operations are still serialized by the transaction's
operation semaphore; batching needs a real storage-level plan with preserved
uniqueness, ordering and rollback behavior. Native IndexedDB request callbacks can
schedule their next operation immediately while the transaction is active; waiting
for a keep-alive sentinel for every operation doubles request round trips. Keep
sentinels only while Effect is suspended and no real requests keep the transaction
alive. Verify asynchronous pauses, interruption rollback, cursor continuations and
transaction reuse in a real browser as well as fake IndexedDB.

Do not rewrite retained delivery bytes to carry a new local generation, discard
receipts to make the queue look empty, bypass policy to enable faster raw delivery,
or weaken result-observation tests. Another tab watching a pending action must still
receive its outcome. Use snapshot-oracle/property tests for delivery and prediction
changes, plus a real worker/two-tab check for lifecycle or transport changes.

Normal sync should wake from data, queue, authentication and network notifications.
Retry/maintenance timers and adapter polling can be valid; removing their deadlines
without evidence can violate backoff or idempotency. Fix a missing notification at
its owner instead of adding an app polling loop. Persist authentication changes in
Connect and let the ordinary journal/watch path drive its monitor and UI queries.

## Validate against the code actually being served

Use the repository's `vp run` task graph. For several packages, use filters:

```sh
pnpm exec vp run --filter @party-stack/ontology-replica --filter @party-stack/ontology-server test
```

Additional positional arguments after a `package#test` task are test arguments,
not additional package tasks. Finish library/app builds before browser measurements:
restored `lib` outputs can invalidate Vite's module graph and resemble an app startup
failure. If that occurs, restart the known local preview after the build; do not add
product retries to hide a stale development server.

For the concrete Notes findings, unresolved costs and API boundaries, read
[the Notes review](../../../specs/2026-10-19-effect-tables-replica/notes-review.md).
