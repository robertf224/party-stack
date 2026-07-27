# Runtime

Coordination has moved to the
[standalone coordination specification](../2026-07-26-coordination/README.md),
which is authoritative where this document still describes the previous
`Coordinator` API.

## Responsibility

`@party-stack/runtime` is platform-neutral. It provides runtime capability
types, the in-memory blob byte store, Effection wrappers, `Coordinator`,
`createPersistedCollectionCoordinator`, and `createLocalCollection`. It must
not contain browser/Expo implementations, platform factories, ontology,
outbox, blob lifecycle, or retry policy.

The packages are split by platform:

- `@party-stack/runtime`: capability/API types, in-memory blob bytes, and
  shared coordination under `src/coordinator` and collection composition under
  `src/utils`.
- `@party-stack/web-runtime`: OPFS bytes, Web Locks,
  `WebBroadcastChannels`, `NavigatorNetworkConnectivity`, and IndexedDB
  collection persistence.
- `@party-stack/expo-runtime`: Expo filesystem bytes, Expo SQLite collection
  persistence and `ExpoNetworkConnectivity`. It omits broadcast channels.

`BlobBytesStore` exposes write, read, and idempotent delete by ID. It does not
enumerate byte keys; higher-level recovery is driven by durable metadata rather
than filesystem or object-store scans.

Platform entry points satisfy `RuntimeAdapterProvider` rather than defining
core presets:

- `createWebRuntime(owner, namespace): RuntimeAdapter` creates
  `@party-stack/db-indexeddb-persistence`, OPFS, Web Locks,
  BroadcastChannel messaging, and browser online/offline events. IndexedDB is
  the only web persistence implementation; there is no browser SQLite variant.
- `createExpoRuntime(owner, namespace): Promise<RuntimeAdapter>` creates Expo
  SQLite, Expo filesystem bytes, and
  `@react-native-community/netinfo`.

Runtime adapter providers return `RuntimeAdapter` resources. Composition roots
call `createCoordinator` and explicitly thread the resulting contract to
consumers. `RuntimeAdapter.coordinator` may contain a synchronous
`CoordinatorProvider`; the returned Coordinator exposes its own asynchronous
`ready` promise.

No compatibility aliases are retained for the removed presets.

## Coordination

`Coordinator` is a public contract constructed by `createCoordinator` from one
scoped `RuntimeAdapter` instance. Selection prefers the runtime's coordinator
provider, then `LockBroadcastCoordinator` when both locks and broadcast are
available, and otherwise `SingleProcessCoordinator`. Implementations:

- Holds one long-lived leader lock for the runtime scope.
- Receives request/response tasks over broadcast channels.
- Runs leader tasks sequentially and rejects invalid tasks explicitly.
- Delivers committed events to every context.
- Uses a local fast path for nested work already running on the leader.
- Owns request retries, response correlation, and in-memory deduplication.

`SingleProcessCoordinator` provides the same serialized task, local pub/sub,
reentrant request, rejection, leadership, and cleanup contract without
cross-context capabilities.

The runtime remains an SPI:

```text
platform capability
    -> shared persistence/coordination composition
    -> blobs, outbox, ontology
```

Locks and messages are not durable state. Persistence remains authoritative.

## Persistence boundary

The runtime exposes collection-scoped TanStack persistence. It does not provide
cross-collection atomic transactions.

`RuntimeAdapter.persistence` is the `PersistenceAdapter` directly; it is not
wrapped in an `{ adapter }` object.

`createLocalCollection` creates an internal TanStack collection backed by the
runtime persistence adapter when one is available, or by an in-memory
local-only collection otherwise. Higher-level packages should use this helper
instead of repeating that selection logic.

When an explicit Coordinator is supplied, `createLocalCollection` supplies a
TanStack persistence-coordinator shim. Collection writes from every context
are sent to the same Party Stack leader, persisted serially, and broadcast as
committed transactions. The persistence shim depends only on the Party Stack
Coordinator contract.

Internal durable collections include:

- Blob metadata.
- Outbox records.
- Future transfer jobs.

Whether ontology objects should be persisted is a live ontology composition
choice, not a runtime capability. `CreateLiveOntologyOpts.persistObjects`
owns that choice. The option is currently forwarded through generated and
remote live ontology factories without adding object persistence behavior.

One Coordinator must be shared by collections and leader-only workers using the
same persistence scope. Creating independent coordinators would allow
persistence and outbox execution to land on different tabs.

## Ownership

A scoped runtime handle owns:

- Database/filesystem handles.
- Platform listeners.
- Cleanup of the underlying persistence adapter.

The composition root owns the Coordinator and closes it before cleaning up the
runtime. Collections own their own subscriptions and collection cleanup.
Higher layers own timers, retries, and workflows.

## Remaining work

1. Persist or otherwise fence Coordinator leadership terms across failover.
2. Decide whether retry work justifies adding `Clock`.
3. Add conformance tests for namespace isolation and cleanup.

## Effection integration

`@party-stack/runtime/effection` exposes scoped resources for:

- Acquiring and disposing runtime resources.
- Subscribing to connectivity changes.
- Acquiring and releasing locks with `useLock`.
- Opening and closing channels with `useMessageChannel`.

The package entry point is implemented by `src/effection/index.ts`. Higher-level
coordinator utilities (`Coordinator` and
`createPersistedCollectionCoordinator`) live under `src/coordinator`, while
`createLocalCollection` remains under `src/utils`.

`LockBroadcastCoordinator` owns an internal Effection task. The task is not part
of the public Coordinator contract; its incoming request queue, leader lock,
broadcast channel handle, and pending work share one structured lifetime.
