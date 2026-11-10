# foundry-ontology

Native Foundry data, metadata, and account-connection capabilities.

## Metadata queries

Open a native metadata backend with selected Connect egress:

```ts
import { makeFoundryMetadataBackend } from "@party-stack/foundry-ontology";

const backend =
    yield *
    makeFoundryMetadataBackend({
        baseUrl,
        ontologyId: "ri.ontology.main.ontology.example",
        egress,
        refetchInterval: 30_000,
    });
```

Object-type name and RID filters use Foundry's batch lookup endpoints. Value-type
name filters use direct lookups. Link queries constrained by an object type load
that type's outgoing links and the inverse definitions needed to reconstruct each
link. Unbounded queries use the corresponding listing endpoints.

The backend narrows provider requests where it can prove they include every
matching row. The shared query engine then applies residual predicates, ordering,
and limits. A bounded fetch never certifies that the whole object type is loaded.

`refetchInterval` supplies a recommended polling interval, in milliseconds. The
replica schedules polling; the adapter does not run a separate timer. `false`
disables the recommendation, and omission defaults to no polling. An explicit
replica demand refresh policy takes precedence.

Metadata is an ordinary backend, usable directly for native pull or
with the shared meta ontology IR in a replica. `makeFoundryBackend` opens a data
backend; `makeFoundryAdminBackend` from the `users` export opens the explicit users
ontology. These helpers do not create SDK views or installations.

For saved connections, register `makeFoundryServiceConnector` with Connect and
acquire authenticated egress through `connect.connections.acquire(connectionRef)`.
Pass that egress to the normal backend constructor. `makeOntologyServer` routes
Connect and managed replicas through the same ontology protocol;
`serveOntologyWorker(server)` binds it to a worker transport. In tabs, `createAuthenticationClient`
handles authentication and `OntologyEnvironmentProvider` opens named views. See the
[Foundry guide](../../apps/website/content/docs/foundry.mdx) for the complete setup.

## Link metadata

- Only FK-backed Foundry links are converted into Party Stack IR.
- Non-FK / object-backed links are omitted (unsupported; no synthetic FK).

## Action metadata

Uses public Foundry APIs (`ActionTypesV2` / `ActionTypesFullMetadata`) for:

- Action parameter and type conversion
- Full logic-rule conversion
- Synthetic UUID / current-time default parameters from public logic metadata

Foundry UI prefills are loaded from the private OMS bulk metadata endpoint when
available. Static values and object-parameter property references become action
parameter defaults. Closed string one-of constraints and text regex constraints
are used when public metadata does not provide them. Open string one-of values
are preserved as suggestions. Object-query and struct-field prefills are omitted
until the expression model supports them, and failures from the private endpoint
do not prevent public action metadata from loading.

## Native backend integration

Object, metadata, and Admin Users reads use the native backend's Effect-valued
`loadSubset` interface. Replica owns demand, persistent rows, action receipts,
confirmation reads, and optimistic state; TanStack collections materialize that
state for applications. Provider collection-option helpers are no longer exported.

The Foundry backend uses the scoped Effect object-set watcher. Watch messages are
invalidation hints; Replica refreshes the affected demand. They do not establish a
durable edits-history cursor. Actions save receipts before confirmation reads, so
a failed read does not cause the action to be submitted again.

`makeFoundryServiceConnector(options)` registers native OAuth exchange, refresh,
identity verification, and authenticated HTTP/WebSocket egress. Credentials remain
beside the backend. Interactive OAuth uses the ordinary Connect actions and the
tab runtime's browser presentation capability. Opening a saved connection does
not start interactive authentication.
