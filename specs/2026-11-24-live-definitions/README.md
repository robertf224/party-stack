# Live definitions

## Status

Built for replicas the server manages. A replica follows its definition, whether it comes
from a metadata backend (read through its own meta replica) or from a parent server (`upstream`
routes); servers serve whatever
definition their replica is open under; schema errors trigger a recheck; a managed replica
starts offline under the definition it last had open; and children resume after a reopen
with only the changed types sent again. Reopening is the only way a replica changes
definition: the route-level swap and the catalog's `rebuild` are gone. An in-app
`LiveOntology` keeps one definition and reports when it is stale; `OntologyProvider` reopens
it, and an idle view learns of a change by watching the route's `meta` resource. A browser
worker's replica still opens under one definition.

## BLUF

A replica follows its definition instead of being opened with a fixed one. When the definition
changes, the replica reopens itself behind the same handle, clearing only the object types whose
contract changed, and its children receive only those types again. Servers describe whatever
definition the replica has now.

## Replica construction

```ts
// Static.
yield* makeReplica({ definition: { kind: "static", ir }, backend, context });

// Dynamic: read from a metadata backend.
const replica = yield* makeReplica({
    definition: {
        kind: "dynamic",
        meta: metadata,
        select: { objectTypeNames: ["Task", "Project"], transform },
    },
    // A fixed backend, or one built for each definition (adapters that compile the IR).
    backend: (ir) => makeProviderBackend({ ...connection, ir, context }),
    context,
    onDefinitionChange: "reset", // later "migrate"
});

replica.ir; // the definition it is open under now
replica.definition.current; // Effect<OntologyIR>
replica.definition.changes; // Stream<OntologyIR>, current first
```

`definition` is static or dynamic:

```ts
type ReplicaDefinition =
    | { readonly kind: "static"; readonly ir: OntologyIR }
    | DynamicReplicaDefinition;
interface DynamicReplicaDefinition {
    readonly kind: "dynamic";
    /** Serves the meta ontology. */
    readonly meta: OntologyBackendService;
    /** pull's objectTypeNames, actionTypeNames, queryFunctionTypeNames and transform. */
    readonly select?: DefinitionSelection;
}
```

A dynamic replica opens a replica of `meta` on the same runtime (its own namespace, with the same
`live` setting and demand policy, so the same freshness rules apply) and reads
the definition from its local rows, compiled by the same code as `pull`. The read demands
exactly the rows it used, so they stay cached for an offline start and in sync (watch or
polling) while the replica runs. A change to any of those rows, or a revalidation, reads the
definition again once every row it was read from is current, so a provider that delivers one
edit a type at a time reopens the replica once. A managed replica reopens its account's
partition without reading the definition; only a first open for an account pulls it directly,
because the storage partition depends on the definition's context.

Definitions hash independently of the order of their named collections and of optional fields
set to `undefined`, so a definition read back from meta rows hashes the same as the original.
Definitions may carry a provider `id`, which defaults to the name (a link type's to its source
object type and `target.name`) and is required on meta rows. Ids are left out of the contract, so
generated definitions stay compatible with the provider's; a replica still clears a type whose
id changed.

`backend` may be a function of the definition. It returns a backend, or `{ backend, source }`
for a replica fed by another server.

### Reopening

When `changes` emits a definition with a different contract, the replica:

1. holds new calls and waits for writes in progress,
2. closes its engine (background work, watches, delivery streams),
3. marks the changed types' delivered rows stale for every child stream,
4. opens a new engine under the new definition, building the backend again when `backend` is a
   function; the startup transaction clears only object types whose contract changed or that
   were removed,
5. releases held calls on the new engine.

The handle stays the same. Reads and waits that were running run again on the new engine, live
queries switch to it and emit again, and demand held across the reopen is acquired again.
Outbox entries, receipts and downloads are kept as for a reset at open. If the new definition
cannot be opened, the startup transaction rolls back and the replica reopens under the previous
one. `replica.status.definition` reports the open definition's hash and an error when a newer
definition could not be read or opened, until one opens. Before an engine closes for a reopen
it is retired: calls and streams still on it fail with a retryable `Unavailable`, so children
resume against the new engine instead of stopping.

### Errors that suggest a stale definition

A backend reports `SchemaMismatch` when the provider rejects a request for referencing a type,
property, link, action or parameter it does not know, or for using a property in a way it no
longer allows. The Foundry adapter maps those errors (`PropertiesNotFound`,
`ObjectTypeNotFound`, `LinkTypeNotFound`, `ActionTypeNotFound`, `ParametersNotFound`,
`ActionEditedPropertiesNotFound`, `InvalidPropertyType`, `PropertiesNotSearchable`,
`PropertiesNotSortable`); `OntologySyncing` becomes a retryable `Unavailable`. A dynamic replica
then revalidates its meta replica (every row the definition was read from) and reads the
definition again. If the definition changed, the reopen follows
and demand loads again on the new engine; if not, the original error stands. "Not found" for a
type can also mean "no access", which the recheck settles.

## Server and route construction

```ts
makeOntologyServer({
    routes: {
        "accounts/:account/:ontology": {
            dangerouslyAllowInternalAccess: true,
            open: (params) =>
                Effect.gen(function* () {
                    const connection = yield* connectAccount(params.account);
                    return {
                        kind: "replica",
                        context: connection.context,
                        definition: { kind: "dynamic", meta: connection.metadata },
                        backend: (ir) => makeProviderBackend({ ...connection, ir }),
                        onDefinitionChange: "reset",
                    };
                }),
        },
    },
});
```

- A replica binding serves its replica's current definition and backend. A new definition gets
  its own endpoint, so requests and connections stay open while requests to the old one finish.
  This applies to managed routes and to a replica passed in directly (as `serveOntologyWorker`
  does).
- Every route with a definition serves it as meta rows on its `meta` resource (the same
  resource mechanism as `pins`), with Describe's access.
- `Describe` is a manifest (protocol version 2): source, context, capabilities, `definitionHash`
  and `contractHash`. Clients require version 2 from a fresh description; a retained version 1
  description still opens with the definition it was accepted with.
  A client reads the definition from the `meta` resource in one request (`pull` fetches every
  value type with the rest and keeps the ones used) and checks it against `definitionHash`,
  describing again if the route changed in between. A local client uses its server's
  definition object while it is the one described. A retained client is opened with
  its accepted description and the definition it was accepted with.
- Clients notice a new definition through the contract hash on frames and requests, and,
  while something follows `client.definition.changes`, through a watch on the `meta` resource
  that checks the description again, after a random delay of up to two seconds so clients spread
  out. Without realtime there is no watch; the next request
  reports the change. A later direction: endpoint settings as a singleton object on the meta
  ontology, which clients sync like any other row.
- The partition catalog stores each partition's context and, for `upstream` routes, the
  parent's description, not definitions. `route.definition` is removed.
- An `upstream` route's definition is dynamic: read from the parent's `meta` resource through
  a meta replica, so it starts offline. It learns of a change through the parent's metadata
  watch (live replicas of a realtime parent) or because a request under the old contract fails
  with `SchemaMismatch`, which revalidates that metadata; with `onDefinitionChange: "reset"` the
  replica reopens under it. An action the parent rejected that way before committing it stays
  queued and is sent again after the reopen. With a bundled `ir`, the
  definition is static and a different contract stays an error.

## Delivery to children

- A stream's binding no longer includes the definition.
- A replica that follows its definition keeps its children's delivery state outside the engine,
  so it survives a reopen. On a new definition it blanks the delivered hashes of the changed
  types' rows; the next capture sends those rows again (and removes ones that are gone) while
  other types keep their delivered state.
- A frame captured under the old definition is never replayed: a child that installed it is
  promoted past it, and one that did not has that frame's rows sent again instead.
- A child fed by a protocol source resets only the changed types when it reopens under the new
  definition.
- Delivery state is in memory, so a parent restart still means a full resend.

## Next

- **Live ontologies follow too.** An in-app `LiveOntology` builds typed collections from one
  definition; it reports `stale` and `OntologyProvider` reopens it, which remounts the tree. A
  browser worker's replica still opens under one definition. Both could take a dynamic
  definition later.
- **One engine for definition and data.** See the system ontology spec: a replica stores its
  definition as meta rows beside its data and receives both on one stream, removing the
  separate meta replica.
- **Persist delivery state.** Children's delivered hashes are in memory per stream; a parent
  restart, or eviction, means a full resend. Storing them in the parent's tables (one row per
  delivered ref per stream, as Zero's CVR does) bounds memory and survives restarts.
- **A `definition` query function.** Return the whole definition in one read, for when a reader
  needs it transactionally. A provider can implement it with its whole-ontology metadata
  endpoint, which also gives per-type providers a consistent snapshot.
- **Value type references as links.** Object, action and query function types refer to value
  types by name inside their type definitions, which queries cannot follow, so `pull` reads
  every value type. Lifting those references into the meta ontology (a link from a definition
  to the value types it uses) would let a selected read follow them, once hierarchical queries
  can traverse list-valued properties.
- **Versioned rows.** Stamp each stored row with a version from a per-replica counter and keep
  tombstones. A child holds a cursor plus per-type reset epochs; delivery sends rows changed since
  the cursor, found by an index on the version instead of recapturing and hashing a selection,
  and the parent no longer loses delivery state on restart. A definition change bumps the epochs
  of changed types. Per-child membership is still needed for ordered, limited selections.
- **Index sweep.** Drop indexes that active demand, downloads and recent use no longer need.
