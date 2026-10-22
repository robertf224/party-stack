# @party-stack/ontology-server

HTTP remoting for LiveOntology with policy-aware describe/load/apply and structured errors.

The package was renamed from `@party-stack/remote-ontology`. The replica-state RPC HTTP transport uses
streaming NDJSON over Fetch, rather than SSE/EventSource framing. The same Effect
RPC definition can run over worker ports.

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
protocol. Selected snapshots currently replace membership in full; retained deltas,
incremental transfer and the remaining private-service ownership migration are unfinished.
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

Error responses use versioned envelopes (`v: 1`) with stable codes. Legacy `{ error: string }` bodies remain parseable by clients.

## Live view helpers

Connections additionally expose `.operations`: query functions, full/draft action
validation, attachment creation/metadata/bytes, owner outbox controls and trace
subscriptions. Supplying `ontology` to the server binds these helpers to the
owner's LiveOntology. They use named, schema-validated RPCs and mandatory per-call
authorization; action submissions and row reads still go through replica state.
Owned source-only servers can instead supply `backend` for query functions and
attachment staging/reads/metadata. These helpers still require explicit authorization;
row reads and action commits continue through the source protocol.

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
