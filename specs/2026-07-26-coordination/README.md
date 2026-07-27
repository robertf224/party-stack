# Standalone coordination

## Status

Authoritative design for Party Stack coordination. This document supersedes
the coordinator sections of the runtime and outbox specifications where they
conflict.

## Goals

Coordination connects all subsystems that share one runtime and persistence
scope. It provides:

- Typed request/response services.
- Typed ephemeral service events.
- A host/client split suitable for tabs and SharedWorkers.
- One global leadership term per coordination scope.
- One FIFO execution lane per service.
- Promise and `AbortSignal` public APIs.
- Effection-owned implementation lifetimes.

Persistence remains authoritative. Coordination messages, response caches,
leadership, and events are not durable state.

## Package boundary

`@party-stack/coordination` depends only on Effection. It must not depend on
TanStack DB, Party Stack runtime, ontology, blobs, or browser/Expo adapter
packages.

The root entry point exports:

- Coordination client and host contracts.
- Typed service client/server/handler helper types.
- Coordination errors and the host type guard.
- Lock and broadcast capability contracts.
- `SingleProcessCoordination`.
- `LockBroadcastCoordination`.

The `./shared-worker` entry point exports SharedWorker-specific client and host
implementations so worker and DOM types do not enter the root bundle.

TanStack-specific coordination remains in `@party-stack/runtime` as an adapter
over these generic contracts.

## Public contract

One Coordination value represents one connection and scope. A host is also a
client, but a client cannot register services or run leader work.

```ts
interface CoordinationClient {
  readonly role: "client" | "host";

  service<Service extends CoordinationService>(
    namespace: string
  ): CoordinationServiceClient<Service>;

  close(): Promise<void>;
}

interface CoordinationHost extends CoordinationClient {
  readonly role: "host";
  readonly isLeader: boolean;

  serve<Service extends CoordinationService>(
    namespace: string,
    handlers: CoordinationServiceHandlers<Service>
  ): CoordinationServiceServer<Service>;

  runAsLeader<Result>(
    callback: (context: { signal: AbortSignal }) => Result | Promise<Result>,
    options?: { signal?: AbortSignal }
  ): Promise<Result>;
}

type Coordination = CoordinationClient | CoordinationHost;

function isCoordinationHost(
  value: Coordination
): value is CoordinationHost {
  return value.role === "host";
}
```

The public API intentionally has no `ready` promise. Handshake and transport
startup are internal. Calls queue behind initialization and reject their own
promises if startup fails. Subscriptions installed during startup become
active when the connection is ready.

Effection types do not appear in this contract.

## Typed services

RPC methods and events belong to one typed, versioned service:

```ts
interface CoordinationService {
  methods: Record<string, (input: never) => Promise<unknown>>;
  events: Record<string, unknown>;
}

interface CoordinationServiceClient<
  Service extends CoordinationService
> {
  readonly methods: CoordinationServiceMethods<Service>;
  readonly events: {
    subscribe<Event extends keyof Service["events"]>(
      event: Event,
      callback: (value: Service["events"][Event]) => void
    ): () => void;
  };
}

interface CoordinationServiceServer<
  Service extends CoordinationService
> {
  readonly events: {
    publish<Event extends keyof Service["events"]>(
      event: Event,
      payload: Service["events"][Event]
    ): void;
  };
  close(): Promise<void>;
}
```

`CoordinationServiceMethods`, `CoordinationServiceHandlers`, and the other
helper types are mapped from `Service`. Handlers receive a
`CoordinationTaskContext` containing cancellation and the same Coordination
client for typed nested calls.

Methods are correlated client-to-server RPC. Server events are ephemeral
server-to-client fan-out. Clients do not publish events directly. A client
that must relay a one-way notification invokes an explicit typed service
method.

Service contracts should live in type-only modules. Page bundles may import a
service contract without importing the host implementation.

Every service namespace is versioned, for example:

- `party-stack.persistence.v1`
- `party-stack.outbox.v1`
- `party-stack.blobs.v1`

Payloads must be structured-clone-safe. Runtime validation and codecs are not
part of v1.

## Service registry and lanes

Each service namespace has one FIFO execution lane:

- Calls to one service execute serially in accepted order.
- Different services may execute concurrently.
- Repeated `service(namespace)` calls return the same logical proxy and event
  namespace.
- Only one server registration may exist for a namespace in one context.
- Closing a service server unregisters its handlers, events, and queued work.
- Closing Coordination closes all services and rejects pending work.

A nested call to the same service executes reentrantly so a handler does not
deadlock behind itself. A nested call to another service enters that service's
lane. Cyclic cross-service dependencies are forbidden.

Large byte or network operations should not occupy a lane. A subsystem uses
short commands such as claim, begin, commit, and fail around work performed
outside the lane.

### Future sub-lanes

V1 does not expose a lane key. If profiling shows a need, `serve` may later
accept a host-owned resolver such as:

```ts
lane: (method, input) => blobId
```

The resolver must be host-owned; clients cannot choose a lane to bypass
serialization. Before adding this, the implementation must define fairness,
bounded concurrency, reentrancy, cyclic calls, and shutdown across sub-lanes.

## Leadership

Leadership belongs to the Coordination connection, not to a service.

`runAsLeader`:

1. Waits for global leadership.
2. Invokes the callback once with a leadership-scoped `AbortSignal`.
3. Aborts that signal on leadership loss, Coordination close, or caller
   cancellation.
4. Waits for callback cleanup before the implementation releases its lock.
5. Does not release global leadership merely because one callback returns.

Multiple subsystem callbacks may run concurrently under the same leadership
term. They supervise autonomous work such as outbox draining, blob
reconciliation, garbage collection, and persistence maintenance.

Leader callbacks are not service-lane jobs. Authoritative transitions still
go through typed service methods.

## Implementations

### Single process

`SingleProcessCoordination` is both client and host, is immediately leader, and
implements the same service registry, FIFO lanes, events, reentrancy,
cancellation, and cleanup semantics without transport messaging.

### Locks and broadcast

`LockBroadcastCoordination` uses abstract `Locks` and `BroadcastChannels`
capabilities. One root Effection program owns:

- Broadcast subscription and handle cleanup.
- Request and response correlation.
- Service registry and lanes.
- Retry and response-cache lifetimes.
- Web Lock acquisition.
- The current leadership scope and child callbacks.

The wire protocol carries a protocol version, coordination scope, sender,
request ID, service, method or event, and payload. A protocol/scope mismatch
is rejected instead of mixing incompatible bundles.

Leadership loss halts all leadership children before releasing the lock.
Closing during acquisition, an in-flight handler, retry, or event delivery
must deterministically settle affected promises.

### SharedWorker

`SharedWorkerCoordinationClient` is page-side and exposes only the client
contract. It multiplexes all typed services over one `MessagePort`.

`SharedWorkerCoordinationHost` is worker-side, exposes the host contract, and
is always the leader for its scope. It owns service registration and event
fan-out to connected ports.

The application owns worker construction and bundling. The package accepts a
`SharedWorker`, `MessagePort`, or construction callback and does not assume
Vite or a worker URL.

Disconnect and protocol mismatch reject pending requests. Reconnection creates
a new connection identity; callers recover durable state from persistence.

## Runtime composition

`RuntimeAdapter` contains:

```ts
coordination?: Coordination;
```

It does not contain a provider abstraction.

- `createWebRuntime` constructs `LockBroadcastCoordination`.
- `createExpoRuntime` constructs `SingleProcessCoordination`.
- A SharedWorker page runtime may supply `SharedWorkerCoordinationClient`.
- A SharedWorker host runtime may supply `SharedWorkerCoordinationHost`.

Composition roots use `runtime.coordination` when present. A memory or custom
runtime receives one owned `SingleProcessCoordination` fallback.

Platform runtime cleanup closes platform-created Coordination after subsystem
servers and leader callbacks stop. The composition root closes only a fallback
it created, preventing double close.

## TanStack persistence mapping

`createPersistedCollectionCoordinator` remains in `@party-stack/runtime`.
Every context opens:

```ts
coordination.service<PersistenceCoordinationService>(
  "party-stack.persistence.v1"
);
```

A host context also serves:

```ts
interface PersistenceCoordinationService {
  methods: {
    ensureLeadership(
      input: { collectionId: string }
    ): Promise<void>;
    ensureRemoteSubset(
      input: EnsureRemoteSubsetInput
    ): Promise<void>;
    ensurePersistedIndex(
      input: EnsurePersistedIndexInput
    ): Promise<void>;
    applyLocalMutations(
      input: ApplyLocalMutationsInput
    ): Promise<ApplyLocalMutationsResponse>;
    pullSince(
      input: PullSinceInput
    ): Promise<PullSinceResponse>;
    relayMessage(input: {
      collectionId: string;
      message: ProtocolEnvelope<unknown>;
    }): Promise<void>;
  };
  events: {
    message: {
      collectionId: string;
      message: ProtocolEnvelope<unknown>;
    };
  };
}
```

The TanStack contract maps as follows:

- `getNodeId`: one random ID per shim context.
- `subscribe`: subscribe to `message` and filter by collection ID.
- `publish`: a host publishes through its service server; a client invokes
  `relayMessage`, which republishes the event.
- `isLeader`: true only for a leading Coordination host.
- `ensureLeadership`: host leadership or a typed remote-host availability
  check.
- Index, mutation, subset, and pull requests map to typed methods.

One Coordination/persistence pair shares one service/server, stream-position
authority, and idempotency cache across collections.

TanStack's sync-present wrapper starts source sync and upstream subset loading
in every context. It does not use `requestEnsureRemoteSubset` to suppress
follower upstream work. A follower may therefore call TanStack's synchronous
`publish()` after persisting external sync.

The client shim relays that envelope asynchronously because TanStack
`publish()` returns `void`. Relay failures are logged. Relay is idempotent by
envelope/transaction ID, preserves per-client order through the persistence
service lane, and caps pending work.

Relay transports notification only. It does not move the original persistence
write to the host or make events authoritative. Sequence gaps recover through
`pullSince` or full reload. Tests must cover duplicate, delayed, and dropped
relays.

## Subsystem composition

Each subsystem:

1. Acquires a typed service client.
2. Registers handlers if Coordination is a host.
3. Starts autonomous work with `runAsLeader` if host-capable.
4. Sends every authoritative transition through its service lane.
5. Closes the service server and leader work before closing Coordination.

Page-only SharedWorker clients never serve handlers or run leader work. The
worker host must construct the backend, persistence, outbox, and blob services
that it serves.

## Blob flow

Blob payloads do not travel through coordination. A client:

1. Calls `beginWrite` with blob ID, operation kind, and metadata.
2. Writes bytes directly to the shared byte store.
3. Calls `commitWrite` with the returned operation ID.

`beginWrite` durably records intent and rejects incompatible work.
`commitWrite` and `failWrite` fence stale operation IDs. Purge runs on the
service host because it can persist intent, delete bytes idempotently, and
delete metadata.

Only the leader runs reconciliation and garbage collection. Per-ID runtime
locks are removed after migration.

## Outbox flow

Outbox enqueue, edit, remove, retry, claim, complete, and fail are typed service
methods. The lowest sequence entry is a strict barrier:

- queued executes;
- failed blocks later entries;
- executing belongs to one execution ID;
- retry, edit, or removal releases a failed head;
- stale execution IDs cannot complete current work.

Remote action and attachment I/O occurs outside the short service lane between
claim and complete/fail.

The outbox root Effection resource owns:

- Collection preload and cleanup.
- Service registration and event subscriptions.
- Projection replay.
- Coalesced collection/connectivity wake signals.
- The leadership-scoped drain operation.

Projection restoration failures affect only the entry that failed. Cleanup
settles projection promises and halts leader work deterministically.

## Attachment boundary

V1 keeps attachment materialization and upload inside the durable outbox action
attempt. This gives durable action intent and action-level retry, but not
independent transfer progress.

Eager materialization remains a non-durable optimization and must be
idempotent for the stable attachment ID. Durable prerequisite jobs are deferred
until Foundry and remote-ontology expose a common independent materialization
model.

## Required conformance

All implementations run the same conformance suite for:

- Typed method and event behavior.
- Per-service FIFO and cross-service concurrency.
- Same-service reentrancy.
- Handler and transport errors.
- Leadership acquisition, loss, and cancellation.
- Service server close and Coordination close.
- Failover and protocol mismatch.
- Client/host role shape.

SharedWorker tests use paired MessagePorts and include disconnect/reconnect.
Compile-time tests prove method/event inference and reject unknown methods,
events, incomplete handlers, and invalid publish payloads.

## Non-goals

- Durable messaging.
- Exactly-once network delivery.
- Runtime schema validation.
- Client-selected lanes.
- Cross-service transactions.
- Cross-collection persistence transactions.
- Moving large blob payloads through coordination.
- Durable attachment jobs in v1.

