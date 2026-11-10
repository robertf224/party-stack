# Explicit query lease proof

Run the focused browser fixture from `packages/ontology-react`:

```sh
pnpm exec vp test src/leased-boot.browser.test.ts
```

This historical regression fixture uses internal `prepareQuery` and
`prepareListQuery` allocators with React query hooks. These are not public APIs or
the recommended application setup; apps use native Suspense queries. Each helper temporarily subscribes to its exact native query
Collection through boot. Its consumer
borrows the same Collection, then releases the temporary subscription in a passive
effect after the hook's subscription commits. The application owner closes every
prepared query and the DbClient on teardown or failure.

This proves query ownership and React handoff over genuine on-demand sources. The
borrowed view fixture supplies only its DbClient and cleanup; it does not exercise
worker acquisition, authentication, IndexedDB or the SDK's backend construction.
The synthetic sources contain five Note rows normally, or 101 rows for the 50-row
pagination case. This is a lifecycle test, not a Notes load benchmark.

Eight internal allocator cases cover staggered boot held beyond native
GC, StrictMode replay, live updates, ordinary query GC after unmount, idle cleanup
deferred until its deadline in a busy browser, failed
preparation cleanup and late abandoned acquisition. Successful consumers committed
zero provider/data fallbacks. The 50-row case renders exactly 50 rows from its
51-row initial window, then 100 after pagination, through `useListFragment` over
the same Collection.

One production-helper run observed mount-to-row commits of 17.4 ms for root
queries, 16.0 ms for nested fragments, 13.4 ms for staggered roots and 16.4 ms for
the 50-row case. The earlier six-case, manually retained-Collection prototype
observed 12.6/15.7/12.2 ms for root/nested/staggered roots. These separate synthetic
samples establish the absence of the earlier 300 ms fallback floor; they are not
an application latency distribution. The latest run's synthetic metrics are
written to `/tmp/party-leased-boot-proof.json`.

Root query consumers create no second query graph and add no startup demand.
Nested `useListFragment` retains its existing independent pagination root and may
acquire additional Note demand; its parent queries remain borrowed. Child fragment
Collections and the list recipe remain live because their owning graph has a real
subscription, not an extended retention timer. No result rows are copied into an
application cache.

The production helpers contain the two compatibility details the manual proof
left to its caller:

- `createLiveQueryCollection` accepts actual Collection sources, not a `client`
  option. `prepareQuery` binds reusable descriptor-based fragment trees only
  through DB's exported `prepareLiveQueryValue` boundary. TanStack explicitly
  marks that framework-adapter export unstable for external use; the dependency
  is documented and contained in db-fragments. Native descriptor/nested-include
  regressions live in that package. This browser fixture uses actual source
  Collections for its manually gated sync sources.
- `prepareListQuery` retains the authored page size as metadata, distinct from
  the sentinel-bearing initial window. `useListFragment` reuses that graph and
  metadata instead of guessing a 51-row page or acquiring another root query.
  The nested-list recipe retains its existing independent pagination behavior.

The separate `native-preload-diagnostic` fixture records why a dehydrated
`preloadLiveQuery` snapshot is not a substitute for this explicit query lease.
