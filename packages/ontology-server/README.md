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
// Configure readCache with makeReplica({ ..., demand: { idleMs: 60_000, maxSubsets: 128 } }).
const cachedServer =
    yield *
    makeOntologyServer({
        kind: "cached-proxy",
        backend: upstream,
        cache: readCache,
        authorize,
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

There is no writes flag. Authorization denies `ApplyAction` and `Submit` for read-only
access. The role defines execution responsibility; it does not grant permission.
Only the intermediate replica role exposes speculative replica-state replication.
Owned, proxy and cached-proxy roles expose committed backend operations without
opening child replication sessions.

The read cache shares subset demand with scoped `RcMap` leases. Concurrent callers
share one demand. The idle timeout restarts after the last request releases its lease.
At capacity, the oldest idle demand is released first; RateLimited applies only when
every slot is in use. Active reads are never evicted. These configurable demand-count
bounds are independent from row GC and do not impose a byte budget. Forwarded
writes never enter the read cache's outbox. A successful receipt invalidates coverage
for its affected types; incomplete targets invalidate all types. The next read repairs
coverage. An invalidation IO failure cannot turn a committed action into a failed one.
Use a dedicated read-cache replica, bound to the same trusted upstream identity.

`kind: "replica"` publishes composed state through its speculative extension. Its
ordinary backend facet still serves committed upstream rows and journal. Protocol
`Submit` returns parent acceptance; stateless `ApplyAction` waits for upstream confirmation.
The replica's surrounding scope must own its synchronization loop.

## Stateless backend operations

```ts
import { connectOntologyBackendHttp } from "@party-stack/ontology-server/rpc/http";

const backend = yield * connectOntologyBackendHttp({ url }).pipe(Effect.provide(FetchHttpClient.layer));
const snapshot = yield * backend.loadSubset({ objectType: "Issue", query });
const receipt = yield * backend.applyAction(invocation);
```

Mount the endpoint so it accepts the trailing slash appended by Effect's HTTP
client (`/rpc/` as well as `/rpc`). These typed RPC calls do not open a replication client session. Describe advertises
whether incremental `PullChanges` and change hints are available; ordinary requests
need no session acknowledgment/bookkeeping. The same transport supports full/draft
validation, query functions and explicit attachment/decrypt operations.

`makeOntologyServer` automatically installs finite hierarchical Query execution
when an ontology definition is available (inferred for owned, cached-proxy and
replica roles; supplied as `ir` or through `ontology` for a direct proxy).
Call it through `connection.operations.query(document, inputs)`. No custom Query
handler is required. Owned queries share one storage read transaction. Other roles
use their final backend read path, including cache hits; multiple provider calls
do not imply a provider-wide atomic snapshot. Incomplete source subsets are rejected.
Policy-projected servers use the authorized query executor. The low-level RPC
binding still permits endpoints without schema/query execution, and Describe
advertises whether finite queries are available.

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

Authenticate the caller before constructing a server, then bind its typed `context`.
`ir.policy` is the permission contract: hierarchical entity selections grant rows
and properties; action rules provide `check`, server-bound parameters and optional
additional mutator reads. Query functions have analogous checks/read grants.
The old native property lists, base predicates and action callbacks are removed.

```ts
// The enclosing HTTP handler has already authenticated this context.
const acquireServer = Effect.gen(function* () {
    return yield* makeOntologyServer({
        kind: "owned",
        backend,
        ir, // includes policy and context definitions
        context: { user: session.user.id, tenant: session.tenantId },
    });
});
```

The projection wraps the final read path, including cache hits. Its generated
protocol gate permits ordinary projected operations and rejects private
replica/admin methods; it does not authenticate a new caller. Never share a
principal-bound view across callers. Low-level `authorize(request, headers)` remains
available for trusted transport bindings; it does not set context or replace the IR
policy. A pass-through endpoint may rely on its correctly authenticated upstream
instead of applying a second local policy.

Owned execution binds parameters and evaluates policy/reference checks in the same
transaction as mutator reads/writes, receipt and journal publication. Shape validation,
idempotency lookup and staging external bytes can precede that transaction. Adapted
providers have their own authoritative transaction; the proxy enforces its policy
before forwarding. Neither grants nor request snapshots are retained across calls.

Caller filters are rewritten into policy grant paths where safe. Caller pagination
runs after authorization; policy windows remain semantic barriers. The full-policy
eager evaluator is private oracle infrastructure, not a configuration switch. A
future eager sync/offline pin controls demand acquisition and retention instead.

Context-only conditional selections specialize the public definition. Row-dependent
properties remain potentially available and optional; returned rows omit denied
cells. Filtering/ordering on conditionally available fields is conservatively denied.
The context definition and bound values form one shared contract, returned by
`Describe` together with the projected definition, capabilities, definition hash and
source ID. Credentials and private authentication state belong in server services,
not context. Partition paths in `ir.context.partition` derive the local storage
partition from those same values.

A gateway can replace the upstream context definition and policy with its own:

```ts
const tokenIR = {
    ...upstreamIR,
    context: {
        type: o.struct({
            fields: [
                {
                    name: "approval",
                    displayName: "Approval",
                    type: o.objectReference({ objectType: "PostApproval" }),
                },
            ],
        }),
        partition: [["approval"]],
    },
    policy: tokenPolicy,
};
const server =
    yield *
    makeOntologyServer({
        kind: "cached-proxy",
        backend: upstream,
        cache: trustedServiceAccountCache,
        ir: tokenIR,
        context: { approval: verifiedToken.approvalId },
    });
```

Each policy `bind` hides its parameter from the public action schema and replaces
caller input on the server. Compatible defaults and predictions are rewritten to
use the binding; predictions that cannot safely use the new context are omitted.
This gateway policy is enforced in addition to the provider's own permissions.
There is no separate `clientContext` option in the native constructor.

Projected attachments and decryption require an accessible source row/property and
re-find the exact attachment ID/ciphertext in that row. Checks happen before byte or
decryption providers are called. Standalone staging/eager-upload access is not granted;
action-associated HTTP uploads use the normal authorized action path.

Projected views omit raw journals, selected delivery and speculative state. Correct
visibility transitions for deletions/moves require a scoped delivery implementation.
Ordinary subset invalidation hints remain available, without row payloads.

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
It accepts `replicaStateSource(replica)` from an intermediate Replica. Authoritative
servers use the ordinary committed backend contract instead of speculative state.

`./rpc/http` composes the same contract with Fetch handlers and streaming NDJSON:

```ts
import { makeOntologyHttpHandler } from "@party-stack/ontology-server/rpc/http";

// Inside the server's scoped Effect program:
const handleRequest =
    yield *
    makeOntologyHttpHandler({
        backend: upstream,
        source: replicaStateSource(replica),
        ir,
        authorize: authorizeRequest,
    });
// Mount handleRequest at a dedicated HTTP route.
```

```ts
import { connectOntologyHttp } from "@party-stack/ontology-server/rpc/http";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";

// Inside the client's scoped Effect program:
const connection =
    yield *
    connectOntologyHttp({ url: "https://example.test/ontology/rpc" }).pipe(
        Effect.provide(FetchHttpClient.layer)
    );
// connectLiveOntology({ ir, connection: Effect.succeed(connection) }) composes
// the correct replica path with normal local row and blob storage.
```

The HttpClient service supplies authentication/fetch behavior; its Layer constructs
that service. The surrounding Scope owns client/server fibers and subscription
leases. Cancelling a demand releases it; reconnecting a change stream invalidates
the view so missed hints are repaired. Rich storage values retain their representation
through the shared codec.

Authorization is mandatory per operation. Sources must belong to the authenticated
principal's partition. Ordinary owned/cached-proxy delivery sends selected committed
snapshots followed by atomic patches; the replica role also transfers speculative
state and action handoff. Returned-state projection for untrusted speculative clients
and resumable delivery history remain future work. Protocol children use normal local
row/blob retention, metadata pushdown and streaming cold-cache byte reads.

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

## Public API and migration

The deprecated per-operation HTTP endpoints and their Promise transport/client
wrappers have been removed. The package root exports `makeOntologyServer` and its
options. `./client` exports the native scoped LiveOntology client composition;
`./rpc`, `./rpc/http` and `./rpc/worker` expose Effect RPC bindings. The old `./http`
and `./server` exports no longer exist.

Use `makeOntologyServer` for owned/proxy/cached-proxy/replica roles, and
`connectOntologyHttp` or `connectOntologyBackendHttp` from `./rpc/http` for HTTP
clients. Native HTTP supports NDJSON subscriptions and streaming multipart action
uploads. Worker clients use `connectOntologyWorker` with their platform Layer.
Describe provides the projected IR and shared context for dynamic clients.

Effect RPC preserves the common `BackendError` schema from ontology-backend.
There is no separate RemoteOntologyError envelope or legacy JSON parser.

## Live view helpers

Connections additionally expose `.operations`: query functions, full/draft action
validation, attachment creation/metadata/bytes, owner outbox controls and trace
subscriptions. Supplying `ontology` to the server binds these helpers to the
owner's LiveOntology. They use named, schema-validated RPCs and mandatory per-call
authorization. Servers supplying a `backend` also expose authorized stateless
subset reads, action commits and optional journal reads, without session allocation.

Trace snapshots use a sliding buffer and are subscribed only while the consumer
asks for them. Attachment downloads stream metadata followed by bounded byte frames.

The HTTP binding uses the same configured Effect HttpClient for RPC and binary IO.
Standalone attachment creation sends one streamed binary POST to the mounted URL;
actions carrying new bytes send a streamed multipart POST containing the portable
action request and files associated by attachment ID. Actions without new bytes
remain ordinary RPCs. A stateless proxy can consume those file streams directly in
its native backend's applyAction, without a staging registry or disk. The last file's
EOF is withheld until the complete multipart envelope and final authorization pass,
so provider action dispatch cannot precede upload validation. Files/metadata have
explicit per-request limits. HTTP does not use the multi-call chunk upload RPC.

Worker/MessagePort bindings use ordered, acknowledged 64 KiB chunk calls beneath a
scoped response stream. This host-local upload registry is bounded and expires on
idle/total deadlines; it is not a durable resumable session. Every chunk checks its
connection and authenticated upload owner. Full authorization runs on opening and
completion, rather than on every chunk. Closing the owning stream cancels incomplete
writes. Configure attachmentTransfers.uploadOwner for custom authentication or a
form/revision-scoped identity; the default fingerprints authorization/cookie headers.
Limits live under attachmentTransfers.limits (maxBytes, maxConcurrent, maxPerOwner,
maxReservedBytes, idleTimeoutMs, maxDurationMs). HTTP uses the size/deadline settings
per request; connection/owner admission applies to the message transport's host.

Both transports call the same attachment writer and native action executor. Owned
storage accepts one-shot bytes into its final byte store before fingerprinting or
committing rows; an intermediate replica needs its local attachment storage before
accepting uploads into an outbox. Parameters/outboxes persist attachment handles,
not stream objects. Provider-specific ID mappings return in the action receipt.
The application Blob convenience and memory store have explicit buffering limits;
the streaming storage/provider paths do not assemble a whole-file Blob.

Optional `ready` gates Describe and helper requests while a worker restores its
installation. Bootstrap failures retain their typed BackendError. Neither local
data deletion nor owner release is enabled by supplying a LiveOntology: those
require explicit `deleteLocalData` / `releaseOwner` callbacks and authorization.
Deletion acknowledgment and the optional owner-release notification are separate
so a transport failure during shutdown cannot turn an acknowledged deletion into
a reported deletion failure.
