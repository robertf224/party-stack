# @party-stack/ontology-server

Transport bindings for native ontology backends and replicas, with policy-aware
describe/load/apply and structured errors. The server package does not depend on
the application SDK.

The package was renamed from `@party-stack/remote-ontology`. The replica-state RPC HTTP transport uses
streaming NDJSON over Fetch, rather than SSE/EventSource framing. The same Effect
RPC definition can run over worker ports.

## Server roles

`makeOntologyServer` is a scoped, transport-neutral Effect. Configure one binding
or a table of routes. HTTP and worker helpers serve the same server. Choose the
role by where writes commit:

```ts
import { makeOntologyServer } from "@party-stack/ontology-server";

// Authoritative storage; commits actions, receipts and journal atomically.
const ownedServer =
    yield *
    makeOntologyServer({
        kind: "owned",
        backend: owned,
        authenticate,
    });

// Direct forwarding, with no local outbox or client-session registry.
const proxyServer =
    yield *
    makeOntologyServer({
        kind: "proxy",
        backend: upstream,
        ir,
        authenticate,
    });

// Confirmed read cache; writes still forward directly to upstream.
// Configure readCache with makeReplica({ ..., demand: { idleRetentionMs: 60_000, maxSubsets: 128 } }).
const cachedServer =
    yield *
    makeOntologyServer({
        kind: "cached-proxy",
        backend: upstream,
        cache: readCache,
        authenticate,
    });

// Intermediate replica: accepts durable local actions into its own outbox.
const replicaServer =
    yield *
    makeOntologyServer({
        enableRealtime: true,
        kind: "replica",
        backend: upstream,
        replica,
        dangerouslyAllowInternalAccess: true,
    });
```

Configure several targets with the same constructor:

```ts
const server =
    yield *
    makeOntologyServer({
        routes: {
            issues: { kind: "owned", backend: owned, authenticate },
            "forms/:formId": Effect.fnUntraced(function* ({ formId }: Readonly<Record<string, string>>) {
                return { kind: "proxy" as const, backend: yield* openForm(formId!), ir, authenticate };
            }),
        },
        idleRetentionMs: 60_000,
    });
const handleRequest = yield * makeOntologyHttpHandler(server);
```

Exact names use a map; parameter patterns are compiled at construction. Acquired
routes remain alive through active requests and streams, followed by the idle
retention interval. Each route binds authentication and policy independently.
`makeOntologyHttpClient` and `makeOntologyWorkerClient` open a shared root client;
`client.ontology(name)` acquires a selected handle without opening another transport.
For a single binding, use `client.ontology()`.

Managed replica routes return
`{ kind: "replica", ir, context, backend, ...replicaOptions }` from a route. The
server owns sharing and persistent partition inventory. `server.forget(name)`
deletes the stored partition even after its credentials expire. Direct and cached
proxy bindings do not acquire a replica catalog. Managed routes require the
`Runtimes` service; this requirement is inferred from the route declaration.
Omitting `replicas` and passing `replicas: {}` are equivalent.

An optional `replicas: { scope }` isolates both the inventory and data namespaces
when multiple servers share a runtime platform. Omitted scope preserves each
replica's configured namespace. Scope is storage isolation, not authorization.

There is no writes flag. IR policy controls read-only access. The role defines execution responsibility; it does not grant permission.
Only a private intermediate replica without a local IR policy exposes speculative
replica-state replication.
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

## Client synchronization

Finite queries and actions work by default. Opt into downstream watches, change-feed
reads, and replication sessions with `enableRealtime: true` on `makeOntologyServer`.
A routed server uses this as its default; an individual route can override it with
`enableRealtime: false`. Capabilities are advertised only when the backend and policy
support them, and no subscription is acquired until a client requests it. Disabled
synchronization calls are rejected, including direct RPC calls. Backend maintenance
and upstream sync are independent of this setting.

Error disclosure follows the route's IR policy automatically: policy-bound routes
project messages/issues; private no-policy routes forward the original typed error,
including its cause.
See the website's authorization boundaries guide for receipts and planned projected
change feeds.

## Stateless backend operations

```ts
import { objectSubset } from "@party-stack/ontology-backend/subset";
import { makeOntologyHttpBackend } from "@party-stack/ontology-server/rpc/http";

const backend = yield * makeOntologyHttpBackend({ url }).pipe(Effect.provide(FetchHttpClient.layer));
const snapshot = yield * backend.loadSubset(objectSubset("Issue", query));
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
Call it through `client.operations.query(document, inputs)`. No custom Query
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

`changes.watch` acquires wake-up hints for `changes.pull(cursor)`, not row payloads.
`watchSubset` acquires subset invalidations independently of a journal. Both return
scoped Effects that establish and buffer the real subscription before returning its
stream. Policy composition establishes every dependency feed before it reports ready.
RPC sends its opening notification after acquisition; the remote backend client
consumes that notification as readiness rather than invalidating a just-started read.
Subsequent notifications still invalidate data or request reconnect repair.

Foundry uses `watchSubset`; Salesforce currently uses polling because its CDC client does not yet
report reconnect gaps/stream health. Neither currently exposes a resumable native journal.

## Authorization and error disclosure

Supply `authenticate(request)` to resolve the IR context on each HTTP request.
The backend and HTTP owner are acquired once; request scopes own policy bindings,
active requests and streamed responses. `ir.policy` remains the domain permission
contract for objects, properties, actions and query functions.

```ts
return (
    yield *
    makeOntologyServer({
        kind: "owned",
        backend,
        ir,
        authenticate: (request) => authenticatedContext(request),
    })
);
```

`authenticatedContext` is the application's Effect returning values matching the
IR context type, such as `{ userId, tenant }`. It fails with `Unauthenticated` for a
missing/invalid session. The server applies policy on the final read path, including
cache hits. Public endpoints deny internal replication, diagnostics and administration.
Already authenticated native bindings can instead supply a fixed `context`.

`dangerouslyAllowInternalAccess` adds diagnostics and administrative commands: replica
status, traces, outbox recovery, local-data deletion and owner release, where supplied.
These can inspect or change state outside the caller's policy; enable them only for
callers allowed to operate the whole endpoint. The setting never disables IR policy:
reads, schema projection, action checks, parameter bindings and attachment guards
still apply. Trace recording is configured separately.

Use `true` for a private endpoint, or a synchronous predicate over validated context:

```ts
dangerouslyAllowInternalAccess: (context) => context.role === "internal-admin",
```

Authentication still runs per request. A predicate must return a boolean; session
and database checks belong in `authenticate`. Worker helpers enable internal access
for private app ports. Without an IR policy, explicit internal access grants the raw
backend/replica protocol. With a policy, raw journals and selected/speculative state
remain unavailable because those streams are not yet policy-projected.

The low-level RPC guard is internal permission enforcement for transport binders;
normal server construction has no `authorize` callback. Authentication does not
replace the IR policy or grant domain permissions by itself.

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
Ordinary subset invalidation hints are available with `enableRealtime: true`, without row payloads.

Policy-bound routes project errors to safe normalized messages, exposed parameter
paths, and standard input constraints. Reference failures become a generic
invalid-reference issue; custom submission criteria remain hidden. Private routes
without a policy preserve the original typed errors, including causes. No separate
error-mode option is needed. An upstream connector authentication failure on a
policy-bound route becomes Unavailable for a downstream caller who cannot fix that
connector by signing in.

An action/function check authorizes its declared return value. Object grants do not
filter return values again. Affected receipt IDs are separately checked against the
base object policy: unconditional and primary-key/context-only grants can prove
visibility without a read; other rules use a policy-filtered read. Unproven IDs become
coarse type invalidations, without changing a committed action's success.

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
import { makeOntologyHttpClient } from "@party-stack/ontology-server/rpc/http";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";

// Inside the client's scoped Effect program:
const client =
    yield *
    makeOntologyHttpClient({ url: "https://example.test/ontology/rpc" }).pipe(
        Effect.provide(FetchHttpClient.layer)
    );
// makeLiveOntology({ ir, client: Effect.succeed(client) }) composes
// the correct replica path with normal local row and blob storage.
```

The HttpClient service supplies authentication/fetch behavior; its Layer constructs
that service. The surrounding Scope owns client/server fibers and subscription
leases. Cancelling a demand releases it; reconnecting a change stream invalidates
the view so missed hints are repaired. Incremental `SubscribeState` owns upstream
demand for its selected subsets; there is no parallel `Demand` RPC in that path.
Committed `SubscribeSelection` owns demand in the same way. The snapshot strategy
uses separate demand leases with finite state reads. Rich storage values retain their representation
through the shared codec.

Snapshot demand leases are streams: the first element confirms acquisition and later
failures remain observable. The protocol client performs one attempt; Replica's
shared watch supervisor owns retry/backoff, retry-after deadlines and credential
reactivation. Demand failures appear in `status.get.demands[].watchError`; failures
of the shared change-hint stream appear in `status.get.watchError`. Terminal failures
stop retrying, and closing the consumer closes its lease. A local parent remains
reachable independently of the device's upstream network status.

Authorization is mandatory per operation. Sources must belong to the authenticated
principal's partition. Ordinary owned/cached-proxy delivery sends selected committed
snapshots followed by atomic patches; the replica role also transfers speculative
state and action handoff. Returned-state projection for untrusted speculative clients
remains future work. Delivery resumes from a stored acknowledged position while
history remains available; expired history requires a snapshot without discarding
pending actions. Protocol children use normal local
row/blob retention, metadata pushdown and streaming cold-cache byte reads.

## Worker transport

`./rpc/worker` uses Effect's platform worker services, without a generic service/
method envelope. Supply the browser platform Layer on each side:

```ts
import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import { makeOntologyWorkerClient } from "@party-stack/ontology-server/rpc/worker";

// Inside the tab's long-lived scoped program:
const source = yield * makeOntologyWorkerClient().pipe(Effect.provide(BrowserWorker.layer(() => worker)));
```

```ts
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { serveOntologyWorker } from "@party-stack/ontology-server/rpc/worker";
import { Fiber } from "effect";

// Inside the owning worker's scoped program:
const server =
    yield *
    serveOntologyWorker({ source, authorize, enableRealtime: true }).pipe(
        Effect.provide(BrowserWorkerRunner.layer)
    );
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
`makeOntologyHttpClient` or `makeOntologyHttpBackend` from `./rpc/http` for HTTP
clients. Native HTTP supports NDJSON subscriptions and streaming multipart action
uploads. Worker clients use `makeOntologyWorkerClient` with their platform Layer.
Describe provides the projected IR and shared context for dynamic clients.

Effect RPC preserves the common `BackendError` schema from ontology-backend.
There is no separate RemoteOntologyError envelope or legacy JSON parser.

## Live view helpers

Connections additionally expose `.operations`: query functions, full/draft action
validation, attachment creation/metadata/bytes, owner outbox controls and trace
subscriptions. Supplying a native `replica` enables its local operations; data/action
capabilities come from `backend`. They use named, schema-validated RPCs and mandatory per-call
authorization. Servers supplying a `backend` also expose authorized stateless
subset reads, action commits and optional journal reads, without session allocation.

Trace snapshots use a sliding buffer and are subscribed only while the consumer
asks for them. Attachment downloads stream metadata followed by bounded byte frames.
Describe reports attachment access/staging and decryption capabilities; a protocol
backend does not manufacture absent capabilities or staging for read-only attachments.

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

HTTP and MessagePort bindings do not schedule backend maintenance. The owned
backend's acquisition Scope owns its periodic sweep, or an external owner invokes
maintenance (the Alchemy DO resource uses its alarm). Mounting another transport
over the same backend therefore does not start another cleanup loop.

## Framework Web handlers

`@party-stack/ontology-server/http` exports `OntologyHttpServer.layer(open)` and
`toWebHandler(layer)`. The latter uses Effect's native Web-handler Layer bridge
and returns `{ handler, dispose }`. The Layer owns backend resources and
maintenance; request/response scopes own active RPC and byte streams. Abort before
response headers cancels the RPC. Dispose the owner during shutdown or HMR.

Mount `handler(request)` in TanStack Start or export it as Next.js GET/POST. The
same handler signature fits a Worker with a Worker-compatible backend; a Node
SQLite Layer itself is not portable. See the [server guide](../../apps/website/content/docs/server.mdx).
