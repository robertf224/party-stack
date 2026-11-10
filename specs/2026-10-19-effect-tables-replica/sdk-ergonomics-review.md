# SDK ergonomics checkpoint — November 4

## Acquisition

`createLiveOntology` accepts either `{ ir, backend }` or `{ client, ir? }`.
Both share generated ontology typing, local demand/cache/authentication settings,
write settings, tracing and cleanup. `makeLiveOntology` is the scoped counterpart.
The separate connected constructor and `ontology/client` export are removed.

The shared resource acquisition validates supplied IR against the client's
advertised definition, uses authenticated context, and closes views/replication
before the transport, then local platform resources. Startup failures close any
partially acquired resources. Constructor regressions cover cleanup order and
failure before runtime acquisition.

`contextPartition` returns an owner key from the declared context fields (with the
existing user/anonymous default). It does not return a complete RuntimePartition.
The namespace separately identifies local storage for one ontology/source. For a
client, the default namespace is `JSON.stringify(["source", sourceId])`.
An explicit `id` overrides the cache namespace. A regression checks source
separation under a composite tenant/user owner.

`createInstallation` accepts either native configuration or an existing client
Effect. It owns startup, failure and cleanup scopes. Browser setup uses the Promise
entry point; platform/transport Layers remain explicit at construction. Each
`installation.open` acquires an independently closable SDK view while the native
installation shares replicas. Tests cover two-view ownership and partial startup.

## Queries

Code generation emits `collections.ts` alongside SDK helpers, exporting typed
`objects` and `cachedObjects`. Descriptors contain no account data or acquired
resources. They resolve through the current DbClient to the same collections as
SDK getters. Generated factories accept backend or client settings and supply
their known IR. `--no-live` omits SDK helper files, including descriptors.

Issue-tracker queries consume the generated descriptors. `ontology-react` supplies
DbProvider through OntologyProvider, so descendants can use descriptors without
passing the client to each hook. The optional useOntology hook exposes commands.

## Offline pins

LiveOntology.pins exposes get/set/clear and subscribe. Installation clients
explicitly target the persistent device owner; arbitrary remote clients keep
local pins. One multi-root graph belongs to the application per replica partition.

Native demand.pinStatusChanges maps the existing replaying notification source to
current status. Trusted installation controls stream it over RPC, with the native
acquisition lease owned by the subscription. SDK unsubscribe releases that stream.
No polling lifecycle or extra status cache is introduced. Tests cover replay,
readiness, clearing, unsubscribe, cross-tab notifications and reload.

## Remaining work

Named pins can follow if independent features need separate saved graphs.
Fragments, SSR data handoff, and the deferred TanStack derived-query cleanup issue
remain separate projects. This checkpoint adds no new sync or IVM implementation.

## Browser setup and provider ownership

`ontology/http` supplies `httpClient(url, options)`, a lazy Fetch-backed client with
relative browser URLs, headers, credentials and a replaceable fetch implementation.
Native HttpClient Layers remain available through ontology-server. `webRuntime`
is the browser runtime's ergonomic export; the native `layer` export remains.

`OntologyProvider options={options}` now owns acquisition and cleanup. Its owner
makes an initial empty commit before reading its acquisition Promise through the
caller's Suspense boundary; there is no custom pending prop or global resource cache.
A component-local lease defers final release to a microtask, preserving the same
view across StrictMode's immediate effect replay, including Suspense reveal. No
resource is opened by an abandoned render or SSR. Option changes and unmount close
acquired views; late acquisitions close immediately. Borrowed views and selected
installation views keep their existing ownership contracts. Options must stay
referentially stable. Startup errors reach the nearest error boundary.

`ontology/worker` supplies lazy `workerClient(spawn)` and a trusted same-origin
`serveOntologyWorker(options)` entry point. The latter acquires native resources
without SDK collections, serves every worker port, and retains its Runtime layer
for the whole server loop. Providing that layer only to the opening effect closes
its LayerMap as soon as opening returns; the two-tab action regression covers this.
Client cleanup closes owned physical ports after releasing protocol resources.
Shared-worker diagnostics default to a live feed, without a history buffer.

Tests cover late provider acquisition, option/selection changes, SSR, StrictMode, per-view
cleanup, retained HTTP configuration, and two SDK tabs confirming actions while
one tab closes. Device-wide pin controls still use the trusted installation
binding; the plain worker binding keeps the ordinary client-local pin behavior.

The server HTTP entry point now supplies an OntologyHttpServer service Layer and
Effect-native toWebHandler bridge. SQLite storage can consume SqlClient directly;
its native Layer owns the connection. That form returns the storage namespace for
owned-backend composition. The existing database-adapting overload preserves its
original { tables, blobs } result so existing platform namespaces do not change.

## Foundry setup, identity and CLI cleanup

Historical checkpoint: the installation-specific worker/React APIs described
below were superseded by ordinary multi-ontology routing. See the November 5
checkpoint in migration-status.md for the current implementation.

The installation selection and public account records now use `userId`, matching
Connect's saved provider subject. The scope of that identifier is the installation;
it is not a global identity and does not choose an application's context partition.
Storage `owner` remains a partition key because declared partitions can combine
non-user context fields. The partition catalogue migrates its former `accountId`
rows in bounded transactions so forgetting old local data remains possible.

Connection implementations are `Connector` services acquired with an Effect.
`ConnectionManagerOptions.connector` replaces the provider callback; `ConnectorContext`
supplies the installation identity where needed. `makeFoundryConnector`,
`makeSalesforceConnector` and `makeBetterAuthConnector` retain provider-specific
session/egress behavior over shared Connect credential services. Connection records
and authentication state remain separate from the connector implementation.

`ontology/worker` now supplies `installationWorkerClient(spawn, options)` and
`serveOntologyInstallationWorker(options)`. The latter owns the native installation, platform
runner and Runtime layer, without constructing SDK collections. Real two-tab tests
exercise these entrypoints, persistent credential restoration, multiple ontology
keys, action confirmation, byte transfers, pins and forget.

`OntologyInstallationProvider` owns the SDK installation, while `OntologyProvider`
owns one selection from it. Existing installations/views can be borrowed explicitly.
`useInstallation` exposes authentication and account controls, and
`useInstallationAccounts` subscribes to the native connection stream. Selection
acquisition never triggers interactive authentication. Tests cover SSR, StrictMode,
late acquisition, owner replacement and subscription cleanup.

Both CLI entrypoints use Effect CLI and Node platform services. The shared generate
command retains existing flags and deterministic output; help does not load app
configuration. Commander is removed from both manifests. Effect platform drivers
remain on 4.0.5; the 4.1 upgrade is a separate task.

Deferred: revisit builder ergonomics and the IR definition approach, including
whether Effect Schema can reduce duplication without bringing Effect into the
plain spec runtime entrypoints. This pass changes CLI ownership/parsing only.

The real worker upload test also exposed an OPFS addressing bug: declared context
partitions contain JSON backslashes, which cannot be filesystem component names.
The byte store now hashes invalid/reserved/oversized components, retaining existing
valid directory and URI-encoded file addresses. Unit tests cover reopening, isolation,
legacy addresses, deletion and clear; real two-tab uploads exercise the composite key.
Follow-up: when a multi-call upload's writer fails before the next chunk, preserve
that original failure instead of allowing a secondary transfer-closed error to win.

Pull config now supplies a scoped `backend` Effect directly, plus an optional
`transformPulledOntology`. The former PullSource installation/identity wrapper is
removed. Foundry and Salesforce helpers acquire authenticated metadata backends;
pull queries them through `backend.query`, without a replica or SDK collections.
Transforms run before final IR validation and fail through `InvalidConfiguration`.
Foundry's attachment-override DSL is removed; issue-tracker's explicit app transform
sets its three image-attachment fields and adds its User type, preserving provider
metadata and declared context partitions.

Foundry guide cleanup: context and partition are applied by the pull transform,
so codegen and worker setup use the same generated ontology module. The example
uses the upstream RID directly and groups Connect construction imports under
`foundry-ontology/connect`. The worker boundary is named
`serveOntologyInstallationWorker` to distinguish it from one-ontology serving.

OAuth no longer relies on guessed methods on generic provider Promise clients.
Connectors expose an explicit native authorization binding; the worker mounts its
policy-projected Connect backend through ordinary ontology handlers. The tab's
`authentication.oauth.signIn()` helper invokes the existing begin/complete actions.
Tokens and PKCE attempts stay private, and policy bindings fix the connector,
principal and redirect URL. Native tests exercise the worker round trip and verify
that supplied parameters cannot override those bindings.

`webRuntime()`, `nodeRuntime()` and `expoRuntime()` provide the Runtimes service,
including browser presentation before any partition is acquired. Installation
clients obtain it from their runtime instead of taking another browser argument.
The tab owns presentation and callback transport; the credential owner owns PKCE,
exchange, refresh and storage. A callback outside the popup can be completed through
`authentication.oauth.complete(callbackUrl)`.

Better Auth sign-in stays in the tab SDK; `refreshConnections()` restores owner
sessions afterward. Issue-tracker no longer forwards email login/session listing
through the generic authentication-method bridge. The library still supports that
bridge for provider-specific clients. Standardized capabilities for additional
authentication methods and dynamic ontology route configuration remain future work.

Foundry metadata now declares its existing `currentUser -> context.user` mapping
on the Ontology descriptor. The action converter and descriptor share the same
field constant. Native pull therefore includes the provider context without an
application transform; the guide's transform only specifies the cache partition.
This does not infer application-specific tenant context or dictate partitioning.

## Native backend acquisition and provider props — November 5

React construction props are flat. The environment supplies a shared client and
view defaults; each ontology provider can override them or supply a native backend.
Explicit backends take precedence over the environment client. Primitive-prop
rerenders preserve the acquisition; existing views are still borrowed.

SDK/backend adapter factories and `.open(context)` wrappers are removed. A local
SDK view accepts an acquired OntologyBackendService or a scoped Effect acquiring
one, with Runtime/Runtimes available. Acquired services are borrowed. Backend
constructors bind their own IR/context; the SDK no longer injects them through a
callback. Foundry/Salesforce constructors, metadata acquisition, SQLite conformance
helpers and app/worker fixtures use the native contract.

Connect's current custom applyAction/workflow backend remains an explicit open
architecture item. The user wants it represented as an owned backend, using a
proper durable workflow model if needed rather than a narrow prepare hook.
Investigate Effect Workflow/Activity and the native owned executor together. Remote
code exchange is not atomic with local storage; unknown provider outcomes must
not be blindly replayed. Refresh fences its final commit with operationId; OAuth
completion currently does not re-read its claimed attempt before committing.
This inconsistency needs a regression test and a uniform final-commit rule in the
owned workflow design. No staged-action execution hook was introduced in this pass.
The user approved retaining the generic proxy backend for now, provided its results
continue through ordinary replication. Future workflow support should provide durable
steps, multiple transactions, retries and compensations rather than a narrow prepare
phase. The SDK regression covers a mounted account query receiving commits even when
the command caller loses the reply, without entering an optimistic outbox.

Other explicit boundaries: Connect authentication commands execute directly;
AuthenticationProvider acquires a command handle and a separate reactive view over one
transport; worker auth status currently reaches the inspector through diagnostics;
OAuth helpers still repeat public application/redirect configuration. Public
status hooks and OAuth configuration discovery remain to be designed.

## Connect/hosting API follow-up

Foundry backend conveniences now export from the package root; `/connect` is removed.
`connectPublicOntologyIR` names the device projection explicitly, and
`connectDeviceRoute(manager)` hides its temporary generic-backend composition.
The helper deliberately does not claim to isolate public network callers.
`ConnectionAccess` names the native scoped acquisition result: the saved reference,
verified user, service instance, authenticated egress and authentication monitor.

The Better Auth guide now includes the four private auth types, model lenses,
Effect SQLite owner and HTTP mount. Its authored definition has a sign-up/session
integration test against native owned storage.

Implemented after the next review:

- OAuthApplication stores requested scopes; connectors expose defaultOAuthScopes.
  Explicit scopes, including [], win. Foundry/Salesforce bootstrap and issue-tracker
  now configure scope per application.
- ServiceConnector.displayName supplies default instance/application titles. Stable
  instance IDs derive from service plus canonical URL, application IDs from instance
  plus client ID. Explicit overrides remain. The config array is OAuthApplications.
- Route parameters infer from literal patterns, including multiple named parameters
  and wildcards, while preserving Effect service requirements. Use a contextually typed
  arrow returning an inline Effect for inference through the route table.

Remaining design recommendation:

- Add a small public upstream-authentication status stream and scoped SDK monitor,
  then React network/authentication hooks. Do not implement UI hooks by subscribing
  to privileged full replica diagnostics. Network status and authentication stay separate.

Describe projection is covered by the Post Approval HTTP integration test: policy
is omitted, only allowed properties survive, the approval action argument is hidden
and supplied server-side, and the upstream user context is replaced. Declared token
context values still travel to the client. Visible definition names, labels,
metadata and valid prediction computations are not automatically scrubbed.

Streamline hosting fits the existing roles: shared metadata/form-definition cache
owners in DOs, direct proxy form-data routes initially, optional per-session cached
proxies later. Each form revision supplies its projected IR/policy/context type;
authentication verifies the form token and derives that context for each request.
Saved service credentials stay server-side. Cache identities must include the
authorization boundary and schema/form revision. Long-lived streams also need an
explicit policy for token expiry/revocation and revision changes; request authentication
alone does not reauthenticate an already-open stream. This is integration design,
not an implementation in the Streamline repository.
