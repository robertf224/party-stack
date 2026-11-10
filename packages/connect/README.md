# Connect

**Connect’s role is saving connections and turning them into authenticated access.**
It stores service instances and saved connections as ontology objects. A
native owner acquires authenticated access from a connection, then passes that
access to an ordinary backend constructor. The same backend can be exposed over
HTTP or a worker port using the ontology server.

- **Service** identifies an integration such as Foundry or Better Auth.
- **ServiceInstance** identifies its configured deployment.
- **ServiceConnector** is the native integration for OAuth, API keys or external sessions, and authenticated egress.
- **OAuthApplication** stores a registered client configuration.
- **OAuthConnection**, **ApiKeyConnection** and **ExternalSessionConnection** store concrete saved connections. Token/key properties are encrypted at the top level; an external session stores a selector that its service must verify.
- **OAuthAuthorizationAttempt** stores the single-use PKCE workflow.

`@party-stack/connect/spec` exports the portable IR and inferred record types.
Applications can extend its definitions and policy. There is no mandatory user or
ACL schema in the core ontology.

## Native owner

`makeConnectManager` requires an Effect `Runtime` and `Scope`. Runtime supplies Tables and
encryption keys; a persistent browser runtime must opt into persistent key storage.
`ConnectManager.layer(options)` provides the same service through an Effect Layer.

```ts
const connect =
    yield *
    makeConnectManager({
        services: [
            {
                connector: makeFoundryServiceConnector(),
                instances: [
                    {
                        id: "foundry",
                        instanceUrl: "https://example.palantirfoundry.com",
                        OAuthApplications: [
                            {
                                id: "app",
                                clientId,
                                redirectUrl,
                                scopes: ["api:use-ontologies-read", "offline_access"],
                            },
                        ],
                    },
                ],
            },
        ],
    });

const access = yield * connect.connections.acquire({ objectType: "OAuthConnection", id: connectionId });
const backend =
    yield *
    makeFoundryBackend({
        baseUrl: access.serviceInstance.instanceUrl,
        ontologyId,
        ir,
        context: { userId: access.userId },
        egress: access.egress,
    });
```

The manager holds scoped authenticated I/O, watches credential changes and
releases sockets/requests when their owner closes. Each outgoing request uses the
current credential. A response using old credentials cannot pause a newer login.
It does not persist a second connection inventory.

Only an instance URL and each OAuth application's client configuration are required.
Instance IDs default to a stable service + canonical URL key; application IDs default
to instance ID + client ID. Titles default to the connector's display name, and flow
defaults to `authorization-code`. Explicit IDs/titles/flow override those defaults.
The example keeps `app` as an explicit ID because its tab sign-in helper selects it.
Changing titles or reordering configuration does not change derived identities.

`OAuthApplications` contains per-application `scopes`. If omitted, the manager uses
the connector's `defaultOAuthScopes`; an explicit empty array requests no scopes.
Resolved configuration is persisted as ordinary ServiceInstance/OAuthApplication
records and exposed through the inventory policy without client secrets.

CLI/provider bootstrap can use `acquireConfiguredConnection({ manager,
serviceInstanceId, oauth, userId, browserAuthentication })`. It reuses a saved
account or runs the configured OAuth flow, then calls the same
`manager.connections.acquire`. API-key bootstrap supplies `apiKey` instead of
`oauth`. No separate CLI connection manager or credential inventory is created.

`makeAuthenticationClient({ backend, browserAuthentication })` provides Effect-native
commands and inventory queries. `createAuthenticationClient` is its Promise SDK facade.

`makeConnectBackend` is the lower-level constructor for owners supplying Tables
and encrypted values directly. Its `store` is trusted native persistence;
`backend` is the ordinary read/action interface.

## Serve and use it

Mount `connect.backend` as a named ontology on the normal ontology server. For
trusted local tabs, `connectPublicOntologyIR` allows inventory reads and explicit
authentication actions while excluding token properties and PKCE attempts.
Network servers must also scope that policy to their authenticated callers.

Select `"connect"` through `httpClient` or `workerClient`. No separate installation
protocol or authentication-method proxy is needed. Browser SDK commands live in
`@party-stack/ontology/authentication`:

```ts
const authentication = await createAuthenticationClient({
    client: workerClient(spawn, { ontology: "connect" }),
    runtime,
});
const oauth = authentication.oauth({ applicationId: "app", redirectUrl });
const signedIn = await oauth.signIn({ browserPresentation: "popup" });
const saved = await authentication.connections();
await authentication.signOut(signedIn);
await authentication.forget(signedIn);
```

The popup remains in the tab. `beginAuthorization` persists PKCE state;
`completeAuthorization` claims the attempt, performs the remote exchange, then
commits encrypted credentials. It checks state, callback location, expiry and
single-use consumption. An optional trusted `principalId` binds a server-hosted
attempt to its initiating caller. These workflow actions execute directly rather
than through an optimistic outbox.

Better Auth sign-in uses its normal tab SDK. `attachExternalSession` asks the
registered service connector to verify the actual session before saving its
selector. The resulting connection acquires a normal backend in the same way as
an OAuth connection. Neither variant requires forwarding a generic SDK over RPC.

Read inventory reactively using the ordinary Connect ontology and the
`authenticationObjects` descriptors from `@party-stack/ontology/authentication`.

## Maintenance and local data

The manager starts scoped periodic maintenance by default. Set
`startMaintenance: false` when an external owner calls `manager.maintenance.run`,
such as a Durable Object alarm. Configure the interval with `maintenance.intervalMs`. Sweeps expire PKCE attempts, refresh secrets and connection expiry state,
and collect the owned journal/delivery metadata.

`authentication.signOut(account)` invokes the ordinary Connect disconnect actions;
`authentication.forget(account)` removes the saved row as well. Both use
`AccountRef`: `{ kind: "oauth" | "api-key" | "external-session", id }`. Sign-in and
inventory results include this shape. Native backend acquisition retains
`ConnectionRef` with `{ objectType, id }`.

Signing out detaches credentials and attempts remote revocation. Forgetting also
clears the account's OAuth attempts and application reference. Revocation failure
is reported after the local change commits and cannot restore credentials. Neither operation will
delete the application's cached objects or pending actions. Managed replica routes on `makeOntologyServer` keep a persisted partition inventory
so `server.forget(name)` works after credentials expire.

For a private SharedWorker, `connectDeviceRoute(manager)` returns its route binding:

```ts
const server =
    yield *
    makeOntologyServer({
        enableRealtime: true,
        routes: { connect: connectDeviceRoute(manager) },
    });
```

This convenience uses `connectPublicOntologyIR`, the device-local inventory policy.
It does not isolate accounts between network callers. Public Connect deployments
must supply their own authenticated context and caller-specific policy.
Forget actions retain typed object-reference parameters and their normal
existence/visibility checks. Connect's current workflow executor does not provide
durable invocation receipts; a new command after account deletion can fail
reference validation. Account queries still reflect committed local deletion if
the command's reply is lost.

## OAuth workflow transactions

Authentication uses a regular backend `applyAction` implementation that dispatches
workflow commands. OAuth completion validates and claims its saved attempt in a
transaction, exchanges the code outside the transaction, then commits encrypted credentials in a second transaction. Refresh uses the
same claim/request/commit pattern. The remote exchange cannot be rolled back with
local storage.

These workflows use normal owned persistence, but do not implement the native
owned mutator's transaction-level authorization hook. Serve this generic backend
with `kind: "proxy"` and a policy; the name describes its server interface, not a
remote deployment. Policy checks happen before workflow execution. A public
server must bind ownership/principal rules in addition to the device-local policy.
Durable claims are not a general action-result/idempotency system, so these
commands bypass the replica outbox and ordinary automatic action replay.

This generic backend is temporary. A future owned implementation should use
first-class durable workflows with persisted steps, separate transactions,
configurable retries and compensations. No staged `prepare` hook is required for
the current proxy path. Its storage commits already publish ordinary journal/watch
notifications, independently of whether a command reply reaches the caller.
