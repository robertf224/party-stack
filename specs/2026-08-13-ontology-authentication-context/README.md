# Ontology authentication and context

## BLUF

Add a typed context schema to ontology IR with one conventional `user` field
that references an app-defined User object type. A runtime-backed connection
library manages backend installations and stable per-user Connections; an
`OntologyBackendInstallation` uses those Connections to create
immutable-context `LiveOntology` instances.

Apps query the user through the ordinary User collection. Foundry can
stitch its Admin User API into an app-defined User object with a small typed
collection mapping; databases Party Stack controls can implement the app schema
directly.

## Background

Party Stack apps need to:

1. Observe authentication state.
2. Know the current user reference before its row finishes loading.
3. Query current and non-current users through the same app-defined collection.
4. Log in/out without exposing provider credentials.
5. Support independently authenticated live ontologies, such as a primary app
   ontology and Outlook.
6. Make other typed execution facts available to expressions when needed.

Current seams:

- `CreateLiveOntologyOpts` has arbitrary `context` and `getUserId`; the latter
  only derives runtime owner
  ([`LiveOntology.ts`](../../packages/ontology/src/live/LiveOntology.ts#L93-L112)).
- Foundry imports current user as `["userId"]`
  ([`convertMetaActionType.ts`](../../packages/foundry-ontology/src/meta/convertMetaActionType.ts)).
- Foundry already has an on-demand Admin User collection
  ([`userCollectionOptions.ts`](../../packages/foundry-ontology/src/users/userCollectionOptions.ts)).
- `OntologyClient.tokenProvider` is already the private dynamic credential seam
  ([`client.ts`](../../packages/foundry-client/src/client.ts)).
- Remote ontology already either forwards server context or projects it for the
  client through `RemoteOntologyClientContextPolicy`
  ([`server.ts`](../../packages/remote-ontology/src/server.ts#L112-L114)).

Zero separately accepts `userID` for client storage partitioning and a
permission context that commonly repeats the same ID
([Zero authentication](https://zero.rocicorp.dev/docs/auth#context)). Party
Stack can avoid that duplication by deriving the existing runtime `owner` from
the standard user field in context.

The [lenses spec](../2026-08-13-ontology-lenses/README.md) defines the
source-agnostic move/select operations used to derive the app User schema
from Foundry's fixed user schema. First-class interfaces are future work in the
lenses roadmap.

## Proposal

### Lens-derived User object

The Foundry configuration provides the target name and a lens from the standard
FoundryUser source schema:

```ts
export const foundryUserToUser = {
    operations: [
        o.LensOp.move({
            from: ["profilePicture"],
            to: ["avatar"],
        }),
        o.LensOp.select({
            properties: [
                "id",
                "givenName",
                "familyName",
                "email",
                "avatar",
            ],
        }),
    ],
} satisfies Lens;

export const foundryUsers = defineFoundryUsers({
    objectType: "User",
    lens: foundryUserToUser,
});
```

Foundry pull applies the lens to derive/add the final User ObjectTypeDef. The
committed/generated app IR contains a normal User object type; SQLite can store
that same derived schema directly.

There is no mandatory global User schema in V0, and the app does not duplicate
the derived User IR by hand.

### Typed context in IR

Add one context schema to root IR:

```ts
interface OntologyIR {
    // existing fields...
    contextType?: TypeDef;
}
```

The final generated issue tracker ontology contains:

```ts
defineOntology({
    contextType: o.struct({
        fields: [
            {
                name: "user",
                displayName: "User",
                type: o.optional({
                    type: o.objectReference({ objectType: "User" }),
                }),
            },
        ],
    }),
    objectTypes: [User, Issue],
    // ...
});
```

Other apps may add ordinary fields:

```ts
contextType: o.struct({
    fields: [
        {
            name: "user",
            type: o.optional({
                type: o.objectReference({ objectType: "Membership" }),
            }),
        },
        { name: "requestIp", type: o.optional({ type: o.string({}) }) },
    ],
});
```

V0 reserves the field name `user` when present:

- its type must be optional or required `objectReference` or
  `interfaceReference`;
- it represents the entity making the current request;
- authentication adapters are expected to fill it;
- anonymous context omits it.

No per-field authority/exposure/lifetime metadata is added now.

`contextReference` validation traverses `contextType`, so:

```ts
o.Expression.contextReference({ path: ["user"] })
```

generates the referenced object's key type, while other fields receive their
declared types.

### Server and client context

The server constructs authoritative context from authentication, request, and
runtime data.

Remote ontology keeps its existing projection boundary:

```ts
type RemoteOntologyClientContextPolicy<Context> =
    | "forward"
    | ((ctx: Context) =>
          Record<string, unknown> | undefined |
          Promise<Record<string, unknown> | undefined>);
```

- `"forward"` sends the full safe context.
- A projection callback returns the safe client subset.
- Tokens, cookies, private claims, and provider session handles never enter
  ontology context.

The projected context is returned by remote `describe` and exposed as
`LiveOntology.context`. A future policy/exposure design may formalize
server-only versus client-visible fields; V0 keeps the existing callback.

### Generated context type

Codegen derives:

```ts
interface IssueTrackerContext {
    user?: string; // User primary key
}
```

and:

```ts
interface LiveOntology<
    Ontology extends OntologyDefinition,
    Context,
> {
    readonly context: Readonly<Context>;
    // existing fields...
}
```

The system client creates a new LiveOntology for a `(userId, ontologyId)` pair.
Its context does not mutate during that instance's lifetime. App code reads:

```ts
ontology.context.user;
```

rather than supplying a second caller-controlled ID.

### Connections, authentication, users, and state

```ts
type ConnectionState =
    | { status: "pending" }
    | {
          status: "active";
          expiration?: {
              expiresAt: number;
              refreshable: boolean;
          };
      }
    | { status: "inactive" }
    | { status: "needs-auth"; error?: string }
    | { status: "error"; error: string };

type ConnectionStatus = ConnectionState["status"];

interface Connection<
    Status extends ConnectionStatus = ConnectionStatus
> {
    userId: string;
    state: ConnectionState & { status: Status };
}

interface ConnectionManager<
    AuthenticationClient extends object = object
> {
    readonly authentication: AuthenticationClient;
    readonly connections: Collection<Connection, string>;
    disconnect(userId: string): Promise<void>;
    egress(userId: string): ConnectionEgress | undefined;
}

interface ConnectionMonitor {
    readonly state: ConnectionState;
    subscribe(
        listener: (state: ConnectionState) => void
    ): () => void;
    reportUnauthenticated(
        error: UnauthenticatedError
    ): Promise<void>;
}
```

`authentication` is an adapter-defined, strongly typed client. Supporting
operations such as sending an OTP remain provider-specific; terminal sign-in
operations call the manager-owned `ConnectionController.connect()` after they
establish a usable session. `disconnect(userId)` remains centrally managed and
delegates provider teardown to the live `ConnectionSession` before recording
the connection as inactive.

Within one backend installation and adapter, `userId` identifies a stable
Connection. Status, expiry, and identity metadata belong to the reactive
serializable Connection collection, while transport authority is retrieved
explicitly from the manager. Credential refresh updates a stable
transport delegate without replacing `LiveOntology` or its outbox. Another user
gets a separate Connection, LiveOntologies, and outboxes.

The backend installation derives a user-scoped ConnectionMonitor from the
reactive collection and passes only that monitor to LiveOntology. The monitor
can report normalized connection errors but cannot connect/disconnect users;
LiveOntology never receives ConnectionManager authority.

`inactive` means explicitly disconnected or not recoverable at startup; network
offline state remains a separate RuntimeAdapter concern. `needs-auth`
means a previously usable connection received an authentication failure and
requires user action.

### Querying the current user

```tsx
const userId = ontology.context.user;

const { data: currentUser } = useLiveQuery(
    (q) => {
        if (!userId) return undefined;

        return q
            .from({ user: ontology.objects.User })
            .where(({ user }) => eq(user.id, userId))
            .findOne();
    },
    [userId],
);
```

The same `User` collection powers current-user and assignee UI.

Issue-tracker UI derives presentation without changing the stored ontology
shape:

```ts
function getUserDisplayName(user: User): string {
    const fullName = [
        user.givenName,
        user.familyName,
    ].filter(Boolean).join(" ");

    return fullName || user.id;
}

function getUserInitials(user: User): string {
    return (
        [user.givenName, user.familyName]
            .filter(Boolean)
            .map((name) => name![0])
            .join("")
            .toUpperCase() ||
        user.id.slice(0, 2).toUpperCase()
    );
}
```

### Foundry Users integration

The Foundry adapter owns a standard native `FoundryUser` IR definition and its
Admin User API collection implementation.

The native schema includes a virtual attachment:

```ts
FoundryUser {
    id: string;
    givenName?: string;
    familyName?: string;
    email?: string;
    profilePicture?: attachment;
}
```

Admin User rows do not eagerly fetch profile-picture bytes. The collection
emits a lazy handle such as:

```ts
{
    id: `foundry-user-profile-picture:${user.id}`,
}
```

The Foundry attachment adapter recognizes that ID/source, calls
`Users.profilePicture(client, userId)` on demand, and returns the image Blob.
Metadata reads use response headers when available. The lens moves
`profilePicture` to the app's `avatar` property, so normal
`ontology.attachments.blob(user.avatar)` and blob caching work unchanged.

The app supplies the target object type name plus the source-agnostic lens value
defined above.

The lens has no source/target names. `defineFoundryUsers` binds it from the
adapter's native FoundryUser schema to the app target `User`.

Use the same definition for pull and runtime:

```ts
// ontology/config.ts
export default {
    source: foundryOntologyPullSource,
    options: {
        users: foundryUsers,
    },
    // ...
};

// app runtime
const backend = createFoundryOntologyBackend({
    client,
    users: foundryUsers,
});
```

During pull:

1. Load the standard FoundryUser ObjectTypeDef.
2. Apply the lens to derive the final app User ObjectTypeDef.
3. Add User to final app IR.
4. Convert Foundry user-formatted properties/action parameters to
   `objectReference({ objectType: "User" })`.
5. Add/type `context.user`.
6. Convert Foundry `currentUser` action values to
   `contextReference(["user"])`.

During runtime:

1. `getCollectionOptions("User")` routes to Admin Users inside the Foundry
   adapter.
2. The same lens compiles to row projection and target→source query path
   rewriting.
3. User profile-picture attachment IDs route to `Users.profilePicture`.
4. Every other object/action/query function/attachment uses the normal Foundry
   adapter implementation.

No general composite/module API is required for this vertical slice.

A SQLite backend implements the derived app User schema normally and needs no
Foundry-specific configuration.

An integration such as Outlook that requires a separate login remains a
separate `LiveOntology`. Application composition may group multiple live
ontologies without introducing another core connection wrapper.

### Pull credentials and config naming

V0 defers durable credential persistence. Foundry pull accepts:

```ts
type FoundryPullAuth =
    | {
          type: "token";
          token: string | (() => Promise<string>);
      }
    | {
          type: "local-oauth";
          clientId: string;
          redirectUrl: string;
      };
```

Configuration:

```ts
options: {
    auth: process.env.FOUNDRY_TOKEN
        ? {
              type: "token",
              token: process.env.FOUNDRY_TOKEN,
          }
        : {
              type: "local-oauth",
              clientId: process.env.FOUNDRY_CLIENT_ID!,
              redirectUrl: process.env.FOUNDRY_REDIRECT_URL!,
          },
    users: foundryUsers,
}
```

The token branch feeds the existing `OntologyClient.tokenProvider`; the OAuth
branch keeps today's flow. No backend-specific credential storage is added.

The pull API names the provider-specific metadata source directly:

```ts
OntologyPullSource
OntologyPullConfig.source
```

and distinguish provider normalization from app transforms:

```ts
interface OntologyPullSource<Options> {
    createBackend(options: Options): Promise<OntologyBackendAdapter>;
    transformPulledOntology?(
        ontology: OntologyIR,
        options: Options,
    ): OntologyIR | Promise<OntologyIR>;
}

interface OntologyPullConfig {
    source: OntologyPullSource;
    transformOntology?(
        ontology: OntologyIR,
    ): OntologyIR | Promise<OntologyIR>;
}
```

Foundry user-formatting conversion belongs to the Foundry pull source because
it interprets Foundry metadata. App-specific attachment/schema overrides belong
to a future app-level pull transform.

For this implementation slice, attachment constraint overrides are the only
app-level `transformOntology` use. User IR derivation, user-formatted reference
conversion, context typing, and current-user rule conversion all belong to the
Foundry pull source. Once attachment constraints come from authoritative
provider metadata, the issue tracker may need no app transform at all.

### Foundry `currentUser` conversion

The Foundry metadata converter changes:

```ts
const FOUNDRY_CURRENT_USER_CONTEXT_PATH = ["user"];
```

Foundry action rules that reference `currentUser` then emit:

```ts
o.Expression.contextReference({ path: ["user"] });
```

The ontology context schema validates `user` as
`objectReference({ objectType: "User" })`, and the Foundry connection adapter
fills it with the same stable provider user ID used by the User collection.

### Backend connection adapter and transport

The provider-agnostic package resolves user identity and a secretless
networking capability separately from ontology context:

```ts
interface ConnectionSession {
    refresh?(): Promise<EstablishedConnection>;
    disconnect(): Promise<void>;
    egress?(
        handlers: ConnectionEgressHandlers
    ): ConnectionEgressHandlers;
    cleanup?(): void | Promise<void>;
}

interface EstablishedConnection {
    connection: Connection<"active">;
    session: ConnectionSession;
}

interface ConnectionController {
    connect(connection: EstablishedConnection): Promise<void>;
    disconnect(userId: string): Promise<void>;
}

interface BackendConnectionAdapter<
    AuthenticationClient extends object = object
> {
    readonly name: string;
    createAuthenticationClient(
        controller: ConnectionController
    ): AuthenticationClient;
    restoreConnections(): Promise<readonly EstablishedConnection[]>;
    cleanup?(): void | Promise<void>;
}

type BackendConnectionAdapterProvider = (
    context: BackendConnectionAdapterContext
) => BackendConnectionAdapter | Promise<BackendConnectionAdapter>;

interface ConnectionEgressHandlers {
    fetch(request: Request): Promise<Response>;
    createWebSocket(
        url: string | URL,
        protocols?: string | string[]
    ): Promise<WebSocket>;
}

interface ConnectionEgress {
    fetch: typeof globalThis.fetch;
    createWebSocket(
        url: string | URL,
        protocols?: string | string[]
    ): Promise<WebSocket>;
}
```

`OntologyBackendInstallation.openOntology` turns the selected Connection's
`userId` into typed context, normally `{ user: connection.userId }`.
Credentials never enter context, connection state, or backend code. The
adapter wraps base ConnectionEgressHandlers to inject credentials for HTTP and
WebSocket traffic. The connection manager owns an in-memory map of live
`ConnectionSession` handles while persisting only their safe `Connection`
projection. The resulting ergonomic ConnectionEgress can later cross a worker
or sandbox boundary.

Public authorization-code OAuth is implemented by `@party-stack/oauth` on top
of `oauth4webapi`. The driver stores PKCE state and token sets through
`RuntimeAdapter.secrets`; ordinary persisted storage is available only behind
the explicit `dangerouslyPersistSecrets` option. Connection metadata remains in
normal local collections. The runtime's `BrowserAuthentication` capability
normalizes full-page,
popup, and native system authentication sessions. Full-page redirect callbacks
are completed explicitly by the app's callback route; `restoreConnections()`
only restores sessions whose authorization flow already completed.

OAuth restoration is local-only: it rebuilds live handles from indexed secret
records without calling the refresh endpoint. Expired refreshable handles are
returned with their expiration metadata so the connection manager can refresh
them immediately when online. OAuth serializes refresh-token rotation through
runtime coordination and reloads SecretStore before on-demand refresh so tabs
do not reuse stale rotated credentials. Terminal `invalid_grant` and
`invalid_token` responses become `UnauthenticatedError`; transient failures
retain the live session for retry.

The Foundry adapter composes that public OAuth driver with Foundry identity
resolution and Bearer egress. Server-only client credentials continue to use
Foundry's confidential OAuth client and are rejected in browser runtimes.

### Party Stack hosted applications

```text
browser request
    -> Party Stack hosting auth middleware
    -> provider adapter (Auth0/Stytch/etc.)
    -> authoritative typed context
    -> Party Stack application session
    -> scoped remote ontology
    -> client User + immutable LiveOntology.context
```

Party Stack hosting mounts generic session/login/callback/logout routes. The
provider adapter resolves the user and other safe context fields, then Party
Stack hosting creates an HTTP-only app session.

Cookie systems may keep multiple server-side user sessions behind one root
HttpOnly browser cookie. The client stores only a non-secret session selector;
each request sends the cookie plus selector, and the server verifies that the
selected user belongs to that browser session.

`@party-stack/better-auth` implements this model using Better Auth's
multi-session plugin. Its typed authentication client delegates sign-in and
session management to Better Auth, while each live `ConnectionSession` captures
one Better Auth session token as a selector. Server-side resource handlers list
the sessions authorized by the root HttpOnly cookie and accept the selector
only when it belongs to that browser session. Better Auth remains independent
from remote ontology; applications compose authenticated context in
`RemoteOntologyServer.getContext`.

The browser does not run Foundry OAuth when Party Stack hosting owns auth.
Party Stack hosting retains provider/Foundry credentials server-side and uses
the existing remote-context projection callback to decide what the app sees.

### Backend installations and multiple LiveOntologies

One `OntologyBackendInstallation` represents one concrete deployment. It
manages stable per-user Connections, and each Connection may open multiple
ontology IDs using the same transport:

```ts
const foundry = await createFoundryBackendInstallation({ /* ... */ });
const connection = await foundry.authentication.signIn.oauth();
const admin = await foundry.openOntology({ connection, ontologyId: "admin" });
const app = await foundry.openOntology({ connection, ontologyId: appRid });
```

Apps provide ontology resolvers explicitly. Foundry Admin is an optional
resolver so apps that omit it do not bundle Admin SDK code.

### Existing API mapping

Existing real APIs remain:

- generated factories such as `createIssueTrackerLiveOntology`;
- `createLiveOntology`;
- `createFoundryOntologyBackend`;
- `createOntologyClient`;
- `createRemoteLiveOntology`;
- `createHttpRemoteOntologyTransport`.

Proposed additions:

- `OntologyIR.contextType`;
- generated context types;
- `@party-stack/connections`;
- optional runtime `SecretStore`;
- `OntologyBackendInstallation`;
- immutable `LiveOntology.context`;
- Foundry Users pull/runtime configuration;
- source-agnostic User lens shared by pull and runtime.

No `createFoundryLiveOntology` or public `fetchCredentials` API is assumed.

### Transitions and persistence

An opened LiveOntology keeps one fixed user/context and a stable Connection.
Authentication loss does not unload it: local work continues and the Effection
outbox waits on both network connectivity and Connection state. Reconnecting
the same user updates the Connection transport in place. Connecting another
user opens separate LiveOntologies rather than mutating ownership.

Keep existing `RuntimeAdapterProvider(owner, namespace)`:

- `owner` is derived from backend installation plus `context.user`;
- `namespace` includes adapter name, backend installation, and ontology ID.

Anonymous owners are installation-specific. Outbox/object persistence never
moves between users.

## Testing

IR/codegen:

- Context schema validates field/reference types.
- `user` rejects non-reference types.
- Generated server/client context types match projected shapes.
- `contextReference` paths infer declared types.

Context projection:

- Forward mode preserves context.
- Projection callback removes private fields.
- Client cannot override server-authored context.
- User changes select/open another LiveOntology; credential refresh for the
  same User keeps the existing instance.

Foundry Users integration:

- FoundryUser source IR is stable and validates.
- User lens derives the expected final User ObjectTypeDef.
- Pull and runtime use the same configured lens.
- User-formatted properties/parameters become object references to User.
- User collection routes to Foundry Admin Users.
- Other objects/actions/functions/attachments keep normal Foundry behavior.
- SQLite implements the derived User schema directly.
- Pull uses environment token when configured and local OAuth otherwise.

Auth adapters:

- List/connect/refresh/disconnect/cleanup adapter conformance.
- Runtime-backed Connection metadata, stable per-user Connection identity, and
  single-leader refresh.
- Multiple connection methods/default selection.
- Private credentials never appear in context/state.

Integration:

- Current and assigned users query the same collection.
- Hosted Auth0/Stytch context projection.
- Main/Outlook contexts remain independent.
- Runtime owner/namespace isolate users.

## Rollout

1. Add `OntologyIR.contextType` and context codegen/validation.
2. Reserve/validate `context.user` reference semantics.
3. Add immutable `LiveOntology.context`.
4. Add `@party-stack/connections`, installation IDs, stable per-user
   Connections, ConnectionEgress, and BackendConnectionAdapter lifecycle.
5. Add `OntologyBackendInstallation`; derive runtime owner from Connection user.
6. Add Foundry Users config with target object name + lens.
7. Apply the lens during pull and runtime collection/query setup.
8. Add environment-token pull with local OAuth fallback.
9. Convert runtime Foundry auth to installation-scoped ConnectionEgress.
10. Add public OAuth/client-credentials BackendConnectionAdapters.
11. Move Foundry current user to `context.user`.
12. Add installation/Connection/LiveOntology React vertical slice.
13. Add hosted auth context projection.
14. Add multi-ontology auth test.

## Open questions

1. Must `user` be the exact reserved field name?
2. Is user required to be optional in contexts supporting anonymous access?
3. Is V0 `contextType` limited to structs, or can it itself be a reference?
4. Should BackendConnectionAdapters return any safe context fields beyond
   `userId`, or should ontology installations always create context?
5. Does disconnect retain sealed pending outbox work?
6. Is connection-method selection part of `connect()` or host UI?
7. Should the Foundry Users config be one shared exported value consumed by
   pull and runtime, or should pull generate a runtime artifact?
8. How should a future group-formatted value be represented without changing
   V0 User references?

## Alternatives considered

### Context is only one reference

Very simple and covers users/memberships/tokens, but cannot represent useful
ephemeral request facts such as server-observed IP. A typed struct with standard
user keeps the reference while allowing additional fields.

### Separate user ID and context

Matches Zero, but duplicates identity. Deriving runtime owner and UI identity
from `context.user` avoids two caller-supplied values drifting.

### Authentication-specific context object annotation

Identifies the user collection but duplicates information expressible by the
typed `user` field and prevents other typed context fields.

### Standard Actor interface now

More polymorphic across users/bots/agents, but requires interface IR,
interfaceReference, and custom on-demand collections before auth can ship.

### Provider claims as context

Convenient but stale/provider-specific and risks exposing private credentials
or untyped claims.
