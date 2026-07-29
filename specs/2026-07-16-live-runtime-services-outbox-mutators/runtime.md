# Runtime

Coordination has moved to the
[standalone coordination specification](../2026-07-26-coordination/README.md),
which is authoritative where this document still describes the previous
`Coordinator` API.

## Responsibility

`@party-stack/runtime` is platform-neutral. It provides runtime capability
types, the in-memory blob byte store, Effection wrappers,
`createPersistedCollectionCoordinator`, and `createLocalCollection`. Generic
coordination contracts and implementations live in
`@party-stack/coordination`. Runtime must not contain browser/Expo
implementations, platform factories, ontology, outbox, blob lifecycle, or
retry policy.

The packages are split by platform:

- `@party-stack/runtime`: capability/API types, in-memory blob bytes, the
  TanStack persistence coordination shim, and collection composition.
- `@party-stack/coordination`: typed client/host services, leadership,
  single-process, lock/broadcast, and SharedWorker implementations.
- `@party-stack/web-runtime`: OPFS bytes,
  `NavigatorNetworkConnectivity`, IndexedDB collection persistence, and a
  `LockBroadcastCoordination` composed over native Web APIs.
- `@party-stack/expo-runtime`: Expo filesystem bytes, Expo SQLite collection
  persistence, `ExpoNetworkConnectivity`, and single-process coordination.

`BlobBytesStore` exposes write, read, and idempotent delete by ID. It does not
enumerate byte keys; higher-level recovery is driven by durable metadata rather
than filesystem or object-store scans.

Platform entry points satisfy `RuntimeAdapterProvider` rather than defining
core presets:

- `createWebRuntime(owner, namespace): RuntimeAdapter` creates
  `@party-stack/db-indexeddb-persistence`, OPFS, Web-native coordination, and
  browser online/offline events. IndexedDB is
  the only web persistence implementation; there is no browser SQLite variant.
- `createExpoRuntime(owner, namespace): Promise<RuntimeAdapter>` creates Expo
  SQLite, Expo filesystem bytes, and
  `@react-native-community/netinfo`.

Runtime adapter providers return `RuntimeAdapter` resources with a required,
pre-constructed `coordination` connection plus their `owner` and `namespace`
scope. Coordination startup remains internal; consumers do not receive a
public `ready` promise.

`createLiveOntology` accepts a provider rather than an already-created
adapter. It derives the owner from `context`/`getUserId`, uses the ontology ID
as the namespace, awaits the provider, and owns the resulting adapter through
cleanup. Construction is therefore always asynchronous, including for
synchronous platform providers such as `createWebRuntime`.

No compatibility aliases are retained for the removed presets.

## Coordination

`Coordination` is the public contract. Typed, versioned services expose
per-service FIFO RPC lanes and server-to-client events. Host-capable values
register service handlers and run autonomous callbacks under one global
leadership term. `LockBroadcastCoordination` uses `navigator.locks` and
`BroadcastChannel` directly; `SingleProcessCoordination` serves single-process runtimes; SharedWorker
clients expose no host or leadership APIs.

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
local-only collection otherwise. Callers supply a local collection name; the
helper prefixes it with the runtime owner/namespace. Higher-level packages
should use this helper instead of repeating that selection logic.

The runtime's required Coordination supplies a
TanStack persistence-coordinator shim. Collection writes from every context
are sent to the same Party Stack leader, persisted serially, and broadcast as
committed transactions. The persistence shim depends only on the Party Stack
Coordination contract.

Internal durable collections include:

- Blob metadata.
- Outbox records.
- Future transfer jobs.

Whether ontology objects should be persisted is a live ontology composition
choice, not a runtime capability. `CreateLiveOntologyOpts.persistObjects`
owns that choice. When enabled, LiveOntology wraps backend-synced object
collections in `persistedCollectionOptions`; requesting it without a runtime
persistence adapter is an error. The option remains explicit because a
platform's ability to persist data must not automatically opt an ontology into
retaining potentially large or sensitive backend datasets.

One Coordination connection must be shared by collections and leader-only workers using the
same persistence scope. Creating independent coordinators would allow
persistence and outbox execution to land on different tabs.

## Ownership

A scoped runtime handle owns:

- Database/filesystem handles.
- Platform listeners.
- Cleanup of the underlying persistence adapter.

Every RuntimeAdapter owns and closes its Coordination connection. Collections
own their own subscriptions and collection cleanup.
Higher layers own timers, retries, and workflows.

## Remaining work

1. Persist or otherwise fence Coordination leadership terms across failover.
2. Decide whether retry work justifies adding `Clock`.
3. Add conformance tests for namespace isolation and cleanup.

## Effection integration

`@party-stack/runtime/effection` exposes scoped resources for:

- Acquiring and disposing runtime resources.
- Subscribing to runtime connectivity changes.

`@party-stack/coordination/effection` exposes the Web-specific resources
`useWebLock`, `useBroadcastChannel`, and `useMessagePort`.

The package entry point is implemented by `src/effection/index.ts`. The
TanStack-specific `createPersistedCollectionCoordinator` remains under
`src/coordinator`, while generic Coordination implementations own their
Effection lifetimes in `@party-stack/coordination` and
`createLocalCollection` remains under `src/utils`.
