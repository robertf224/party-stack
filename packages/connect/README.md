# @party-stack/connect

Connect models configured service instances, OAuth applications and saved authorizations:

- **Installation**: a service instance, such as a Foundry deployment or Salesforce organization.
- **OAuthConnector**: an OAuth app configuration for one installation and one flow (`authorization-code` or `client-credentials`). A connector can designate a saved connection for server-side execution.
- **OAuthConnection**: a saved provider authorization, with private credentials and lifecycle state.
- **OAuthAuthorizationAttempt**: a short-lived, single-use PKCE attempt. Completed attempts retain a small completion record until their expiry so a browser can recover a lost response.

Applications reference connectors. The credential authority resolves their designated connections and authorizes use. Personal and team connectors can be separate records, even when they use the same provider app registration.

## Exports

- `@party-stack/connect/spec`: portable ontology definitions and inferred core types. This entry point does not import Effect.
- `@party-stack/connect`: Effect service, native storage, OAuth provider integration, browser client, maintenance, and SDK/UI facades.
- `@party-stack/connect/server`: mountable HTTP handlers for server-mediated authorization.

The former `@party-stack/oauth` and `@party-stack/connections` packages have been consolidated here. Existing provider SDK and UI entry points remain Promise boundaries; OAuth storage and execution underneath them use Effect. The existing connection-manager status collections and installation selection API remain available while their higher-level lifecycle migration continues.

## Native authority

```ts
import { makeConnect, makeConnectStore, makeOAuthProvider, maintainConnect } from "@party-stack/connect";
import { EncryptionKeyring, makeEncryptedValues } from "@party-stack/ontology-storage/encrypted";
import { Tables } from "@party-stack/ontology-storage/tables";
import { Effect, Schema } from "effect";

const authority = Effect.gen(function* () {
    const tables = yield* Tables;
    const keys = yield* EncryptionKeyring;
    const namespace = "private-connections";
    const store = yield* makeConnectStore({ tables, namespace });
    const values = makeEncryptedValues(namespace, tables, keys);
    const connect = yield* makeConnect({
        store,
        values,
        provider: ({ connector, installation }) =>
            Effect.gen(function* () {
                // Resolve trusted provider configuration for this installation.
                const config = providerConfiguration(installation);
                const secret = connector.clientSecret
                    ? yield* values.decrypt(Schema.String, connector.clientSecret)
                    : undefined;
                return makeOAuthProvider({
                    ...config,
                    clientId: connector.clientId,
                    clientAuthentication: secret
                        ? { method: "client_secret_basic", secret }
                        : { method: "none" },
                });
            }),
    });
    yield* maintainConnect(connect);
    return { connect, store };
});
```

`providerConfiguration` is application/provider configuration, not a package function. It supplies endpoints, scopes and an Effectful `resolveSubject`. Different providers can implement `ConnectOAuthProvider` directly. The optional `refreshTokenExpiry` hook reads trustworthy provider-specific expiry metadata; access-token expiry is never treated as refresh-token expiry.

Provide the authority as a Layer or acquire it in the host's scope. `Connect.layer(options)` supplies the `Connect` service when its dependencies are already constructed. `maintainConnect` starts a scoped maintenance fiber; serverless hosts can instead call `collectExpired({ limit })` from a scheduled job/alarm. It uses indexed expiry predicates and bounded batches.

The native store is backed by ontology-storage on the supplied Tables driver (IndexedDB, memory, SQLite or PostgreSQL). Token ciphertext and record changes share that transaction. A separately supplied platform SecretStore cannot provide the same cross-store atomicity; prefer the runtime's encryption key service for native persistence.

## Server-mediated authorization

```ts
import { makeConnectServer } from "@party-stack/connect/server";

const handle = makeConnectServer({
    connect,
    store,
    callbackUrl: "https://app.example/api/connect/callback",
    appOrigin: "https://app.example",
    authenticate: (request) => authenticateApplicationSession(request),
    authorize: (input) => authorizeConnectorOperation(input),
});
```

Mount the handler under `/api/connect`. The host runs the returned Effect in its existing runtime. `authenticate` returns `{ id, sessionId }`: use a stable, non-secret session identifier, not the session cookie/bearer token. `authorize` handles `begin`, `complete` and `inspect`, and checks application project/org permissions. On begin it may return trusted extra attempt properties. Completion rechecks permissions before exchanging the provider code.

Routes:

- `POST /begin`: `{ connectorId, connectionId?, returnUrl, context? }`; requires the application Origin. Returns an opaque attempt ID and authorization URL. Omitted connection ID reconnects the connector's designated connection when present.
- `GET /callback`: the provider-registered callback. The server exchanges the code and redirects to the app return URL with `connectAttempt` and `state`, both containing the opaque attempt ID. Provider codes and tokens are not forwarded to the app completion page.
- `GET /result?state=...`: session-bound completion status and connection ID.
- `GET /status?connectorId=...`: authorized, credential-free connector connection status.

`makeServerConnectClient` uses the runtime's `BrowserAuthentication` capability for popup or full-page redirect presentation. Its `authorize` method opens the presentation, starts the server attempt and reads the result. After a full-page redirect, call `completeRedirect(location.href)` in the app completion page. For popups, the existing web-runtime callback relay can relay that app completion URL to the opener. No suspended in-memory Effect must survive navigation.

Connection and attempt rows are private to the credential authority. Connector client secrets also need restricted property access. Provider implementations inject credentials into authorized egress; clients use the ontology server protocol to invoke provider operations rather than receiving tokens.

## Application properties

Applications can extend definitions directly, without inheritance or schema lenses:

```ts
import { connectOntology, oauthConnectorDefinition } from "@party-stack/connect/spec";
import { o } from "@party-stack/ontology-spec";

const connector = {
    ...oauthConnectorDefinition,
    properties: [
        ...oauthConnectorDefinition.properties,
        {
            name: "project",
            displayName: "Project",
            type: o.objectReference({ objectType: "Project" }),
        },
    ],
};
```

Include this replacement and the application's `Project` definition in the IR supplied to `makeConnectStore`. Standard names, property types and primary keys must remain compatible. Extra properties are validated and preserved during updates. Add ownership properties to attempts/connections as needed; `connectionProperties(attempt)` populates trusted application fields when creating a connection. Server authorization determines their values.

Tokens and expiry timestamps are flat properties because Foundry structs do not support Cipher text fields. Native stores index connection, access expiry, refresh expiry and attempt expiry properties. Expired refresh material is removed while retaining connection identity; a still-valid access token may remain usable until its own expiry. Transient provider failures do not erase credentials. Concurrent refresh claims are durable, and an interrupted refresh with unknown outcome requires explicit reconnection rather than blindly reusing a potentially rotated refresh token.

## Remaining integration

The included authority store is the native ontology-storage implementation. Hosting these records in Foundry additionally needs trusted Foundry actions/Cipher writes implementing the same atomic claims and credential commits; ordinary independent SDK reads/writes are not an atomic transaction. That bridge is not supplied yet. Existing Foundry provider login uses native device storage, not Foundry-hosted Connect records.

Public LiveOntology decryption/cache APIs, Better Auth's server database adapter, and the remaining installation/connection-manager lifecycle consolidation are separate migration work. This change does not encrypt action inputs in the outbox.
