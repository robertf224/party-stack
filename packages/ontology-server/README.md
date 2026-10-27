# @party-stack/ontology-server

HTTP remoting for LiveOntology with policy-aware describe/load/apply and structured errors.

The package was renamed from `@party-stack/remote-ontology`. The replica-state RPC HTTP transport uses
streaming NDJSON over Fetch, rather than SSE/EventSource framing. The same Effect
RPC definition can run over worker ports.

## Server roles

`makeOntologyServer` is a scoped Effect. Choose the role by where writes commit:

```ts
import { makeOntologyServer } from "@party-stack/ontology-server";

// Authoritative storage; commits actions, receipts and journal atomically.
const ownedServer =
    yield *
    makeOntologyServer({
        kind: "owned",
        backend: owned,
        authorize,
    });

// Direct forwarding, with no local outbox or client-session registry.
const proxyServer =
    yield *
    makeOntologyServer({
        kind: "proxy",
        backend: upstream,
        authorize,
    });

// Confirmed read cache; writes still forward directly to upstream.
const cachedServer =
    yield *
    makeOntologyServer({
        kind: "proxy",
        backend: upstream,
        cache: readCache,
        authorize,
        demand: { idleDemandMs: 60_000, maxSubsets: 1_024 },
    });

// Intermediate replica: accepts durable local actions into its own outbox.
const replicaServer =
    yield *
    makeOntologyServer({
        kind: "replica",
        backend: upstream,
        replica,
        authorize,
    });
```

There is no writes flag. Authorization denies `Invoke` and `Submit` for read-only
access. The role defines execution responsibility; it does not grant permission.
A direct protocol proxy can also supply `source: upstreamSource` to delegate
replication sessions without maintaining another registry.

The read cache shares subset demand with scoped `RcMap` leases. Concurrent callers
share one demand. The idle timeout restarts after the last request releases its lease.
At capacity, the oldest idle demand is released first; RateLimited applies only when
every slot is in use. Active reads are never evicted. These configurable demand-count
bounds are independent from row GC and do not impose a byte budget. Forwarded
writes never enter the read cache's outbox. A successful receipt invalidates coverage
for its affected types; incomplete targets invalidate all types. The next read repairs
coverage. An invalidation IO failure cannot turn a committed action into a failed one.
Use a dedicated read-cache replica, bound to the same trusted upstream identity.

`kind: "replica"` serves composed state, including its optimistic overlay. Protocol
`Submit` returns parent acceptance; stateless `Invoke` waits for upstream confirmation.
The replica's surrounding scope must own its synchronization loop.

## Stateless backend operations

```ts
import { connectOntologyBackendHttp } from "@party-stack/ontology-server/rpc/http";

const backend = yield * connectOntologyBackendHttp({ url }).pipe(Effect.provide(FetchHttpClient.layer));
const snapshot = yield * backend.loadSubset({ objectType: "Issue", query });
const receipt = yield * backend.invoke(invocation);
```

Mount the endpoint so it accepts the trailing slash appended by Effect's HTTP
client (`/rpc/` as well as `/rpc`). These typed RPC calls do not open a replication client session. Describe advertises
whether incremental `PullChanges` and change hints are available; ordinary requests
need no session acknowledgment/bookkeeping. The same transport supports full/draft
validation, query functions and explicit attachment/decrypt operations.

Source identity is supplied by the server's backend/source in Describe. An owned
backend generates and persists a namespace-scoped identity on initialization; deleting
that state creates a new source. Adapter backends supply stable provider identities
(Foundry base URL + ontology RID, Salesforce instance URL). A cached proxy retains
its upstream identity, while an intermediate replica has its own persisted identity.
Clients learn it from Describe; it is independent from schema revisions and login/session IDs.

changes.watch is a wake-up hint for changes.pull(cursor), not a stream of row payloads.
watchSubset supplies subset invalidations independently of a journal. Foundry uses
watchSubset; Salesforce currently uses polling because its CDC client does not yet
report reconnect gaps/stream health. Neither currently exposes a resumable native journal.

## Authorization and error disclosure

Bind `projectOntologyBackend({ backend, ir, context, policy })` after authenticating
the caller. Its policy supplies allowed object properties, optional row predicates,
action/query visibility, fixed action parameters, context projection and operation
authorization callbacks. Row predicates run before pagination; hidden properties
cannot be probed in filters or sort keys. Query-function callbacks remain responsible
for returned-value authorization. Base predicate values can also be functions of
`{ctx, objectType}`; ctx is the authenticated server context bound to this projection.
They still return flat predicates rather than relational queries.

Projected attachment metadata and reads require a source row/property, load that row
through the projected subset path, and re-find the ID through its declared attachment
type (including containers). Hidden properties, inaccessible rows, detached or invented
handles are denied without calling the byte provider. This does not grant staging or
eager-upload access. Decrypt capabilities require separate explicit authorization.
Never reuse a principal-bound projection across users.

A projection without row predicates can filter a journal to visible object types and
properties. Row-filtered projections omit journal access: tracking deletes and moves
across predicate boundaries requires before/after visibility or query watching.

The server defaults to `errors: "projected"`: safe normalized messages, exposed
parameter paths and standard input constraints. Configured input messages become
standard wording. Reference failures become a generic invalid-reference issue; custom
submission criteria remain hidden. `errors: "forward"` preserves normalized details
for a trusted audience. A function can transform/filter errors, e.g. Forbidden to
NotFound, without changing retry/outcome facts. Raw causes are never serialized.
An upstream connector authentication failure becomes Unavailable for a downstream
caller who cannot fix that connector by signing in.

This projects stateless operations. Privileged replica-state access also exposes
outbox parameters and confirmed base, so it requires an explicitly trusted,
principal-bound source; this wrapper does not automatically secure that protocol.

## Replica-state Effect RPC

The separate `./rpc` export defines typed client sessions, selected state reads,
ordered actions, applied acknowledgments, demand leases and invalidation streams.
It accepts an `OntologySource` from `ontology-backend/protocol`: either an owned
backend's `.protocol` or `replicaStateSource(replica)` for an intermediate Replica.

`./rpc/http` composes the same contract with Fetch handlers and streaming NDJSON:

```ts
import { makeOntologyHttpHandler } from "@party-stack/ontology-server/rpc/http";

// Inside the server's scoped Effect program:
const handleRequest =
    yield *
    makeOntologyHttpHandler({
        source: owned.protocol,
        authorize: authorizeRequest,
    });
// Mount handleRequest at a dedicated HTTP route.
```

```ts
import { connectOntologyHttp } from "@party-stack/ontology-server/rpc/http";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";

// Inside the client's scoped Effect program:
const source =
    yield *
    connectOntologyHttp({ url: "https://example.test/ontology/rpc" }).pipe(
        Effect.provide(FetchHttpClient.layer)
    );
// Pass source to makeReplica({ ..., source, gc: false }).
```

The HttpClient service supplies authentication/fetch behavior; its Layer constructs
that service. The surrounding Scope owns client/server fibers and subscription
leases. Cancelling a demand releases it; reconnecting a change stream invalidates
the view so missed hints are repaired. Rich storage values retain their representation
through the shared codec.

This path is still being integrated. Authorization is mandatory per operation;
sources must belong to the authenticated principal's partition. Restricted sources
also need returned-state projection, including action parameters and confirmed base.
The existing row/property policies below are not automatically applied to this new
protocol. Selected snapshots currently replace membership in full. Retained replica-state
deltas and protocol-child row/blob GC remain follow-up work.
Issue-tracker now uses the SharedWorker/memory-tab placement described below.

## Worker transport

`./rpc/worker` uses Effect's platform worker services, without a generic service/
method envelope. Supply the browser platform Layer on each side:

```ts
import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { connectOntologyWorker } from "@party-stack/ontology-server/rpc/worker";

// Inside the tab's long-lived scoped program:
const source = yield * connectOntologyWorker().pipe(Effect.provide(BrowserWorker.layer(() => worker)));
```

```ts
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { Fiber } from "effect";

// Inside the owning worker's scoped program:
const server =
    yield * serveOntologyWorker({ source, authorize }).pipe(Effect.provide(BrowserWorkerRunner.layer));
yield * Fiber.join(server);
```

The server fiber is owned by the calling Scope. Separate port servers may also use
`BrowserWorkerRunner.layerMessagePort(port)` with the same source. Closing a client
releases its streams without closing other clients or deleting accepted work.
The client handshake has a configurable timeout; startup failure can select an
explicit fallback before constructing the tab Replica. An active Replica must not
silently switch to a new source after submitting work.

## Describe projection

Describe retains the full object and link schema when no object-visibility
policy is configured. When `allowedObjectTypeProperties` or
`baseObjectTypeQueries` is configured, it automatically projects authorized
object types and properties, prunes broken links, hides actions and queries
that reference hidden types, and drops unreachable named types.

## Errors

Effect RPC preserves the shared `BackendError` schema from ontology-backend. The
older policy HTTP endpoints retain versioned envelopes (`v: 1`) and legacy body
parsing while applications move to the common RPC server.

## Live view helpers

Connections additionally expose `.operations`: query functions, full/draft action
validation, attachment creation/metadata/bytes, owner outbox controls and trace
subscriptions. Supplying `ontology` to the server binds these helpers to the
owner's LiveOntology. They use named, schema-validated RPCs and mandatory per-call
authorization. Servers supplying a `backend` also expose authorized stateless
subset reads, action commits and optional journal reads, without session allocation.

Trace snapshots use a sliding buffer and are subscribed only while the consumer
asks for them. Attachment downloads stream metadata followed by bounded byte frames.
Uploads use ordered, acknowledged 64 KiB chunk calls beneath a scoped response
stream because Effect RPC supports streamed responses, not streamed request payloads.
Closing that stream discards incomplete transfers. Sequence/size checks reject
partial uploads; authorization runs before allocation and for each chunk. No
durable resumable upload session is introduced. The Blob API still materializes
content at storage boundaries; the transport avoids a single whole-file RPC frame.

Optional `ready` gates Describe and helper requests while a worker restores its
installation. Bootstrap failures retain their typed BackendError. Neither local
data deletion nor owner release is enabled by supplying a LiveOntology: those
require explicit `deleteLocalData` / `releaseOwner` callbacks and authorization.
Deletion acknowledgment and the optional owner-release notification are separate
so a transport failure during shutdown cannot turn an acknowledged deletion into
a reported deletion failure.
