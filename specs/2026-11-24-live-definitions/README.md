# Live definitions

## Status

Built for replicas the server manages. A replica follows its definition, whether it comes
from a backend's metadata or from a parent server (`upstream` routes); servers serve whatever
definition their replica is open under; schema errors trigger a recheck; a managed replica
starts offline under the definition it last had open; and children resume after a reopen
with only the changed types sent again. Reopening is the only way a replica changes
definition: the route-level swap and the catalog's `rebuild` are gone. An in-app
`LiveOntology` and a browser worker's replica still open under one definition; the app opens
them again, as it does today.

## BLUF

A replica follows its definition instead of being opened with a fixed one. When the definition
changes, the replica reopens itself behind the same handle, clearing only the object types whose
contract changed, and its children receive only those types again. Servers describe whatever
definition the replica has now.

## Replica construction

```ts
// Fixed. `ir` still works but is deprecated.
yield* makeReplica({ definition: ir, backend, context });

// Followed.
const replica = yield* makeReplica({
    definition: yield* metaDefinition(metadata, { objectTypeNames: ["Task", "Project"] }),
    // A fixed backend, or one built for each definition (adapters that compile the IR).
    backend: (ir) => makeProviderBackend({ ...connection, ir, context }),
    context,
    onDefinitionChange: "reset", // later "migrate"
});

replica.ir; // the definition it is open under now
replica.definition.current; // Effect<OntologyIR>
replica.definition.changes; // Stream<OntologyIR>, current first
```

```ts
`definition` is an `OntologyIR` or a source:

```ts
interface ReplicaDefinition {
    /** The current definition first, then each new one. */
    readonly changes: Stream.Stream<OntologyIR, BackendError>;
    /** Look again after an operation failed in a way that suggests the definition is stale. A
     * change still arrives through `changes`. */
    readonly revalidate?: (hint: {
        readonly objectTypes: readonly string[];
    }) => Effect.Effect<void, BackendError>;
}
```

`metaDefinition(meta, options)` (in `@party-stack/ontology-backend/meta`) reads the definition
with ordinary metadata queries, compiled by the same code as `pull`, and emits each one that
differs. `meta` is anything that answers queries: a metadata backend, or a cached proxy over a
meta replica so the definition is available offline. `options.changes` says when to read again
(a live query over the meta replica, a timer); `options.revalidate` refreshes the metadata itself
before a requested read.

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
one until the source supplies another.

### Errors that suggest a stale definition

A backend reports `SchemaMismatch` when the provider rejects a request for referencing a type,
property, link, action or parameter it does not know, or for using a property in a way it no
longer allows. The Foundry adapter maps those errors (`PropertiesNotFound`,
`ObjectTypeNotFound`, `LinkTypeNotFound`, `ActionTypeNotFound`, `ParametersNotFound`,
`ActionEditedPropertiesNotFound`, `InvalidPropertyType`, `PropertiesNotSearchable`,
`PropertiesNotSortable`); `OntologySyncing` becomes a retryable `Unavailable`. A followed replica
calls `revalidate` with the object type involved. If the definition changed, the reopen follows
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
                        definition: yield* metaDefinition(connection.metadata),
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
- Clients notice a new definition through the definition hash on frames, as today.
- A managed replica opens under the definition it last had open (recorded on each reopen),
  then follows its source, so it starts offline. `route.definition` is deprecated.
- An `upstream` route is a followed replica too. Its source is the parent's description: it
  starts from the retained one without a `Describe`, opens a protocol client per definition,
  and when the parent reports a mismatch the client describes it again; with
  `onDefinitionChange: "reset"` a different definition reopens the replica. With a bundled
  `ir`, a different contract stays an error.

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
  definition, so the app opens it again on a new one. A browser worker's replica is made the
  same way. Both could take a definition source later.
- **Persist delivery state.** Children's delivered hashes are in memory per stream; a parent
  restart, or eviction, means a full resend. Storing them in the parent's tables (one row per
  delivered ref per stream, as Zero's CVR does) bounds memory and survives restarts.
- **Describe as a manifest.** Serve the definition as meta rows plus a `definition` query
  function returning the whole definition in one read, for when a client needs it
  transactionally. A provider can implement it with its whole-ontology metadata endpoint.
  `Describe` shrinks to version, source id, definition hash and capabilities.
- **Versioned rows.** Stamp each stored row with a version from a per-replica counter and keep
  tombstones. A child holds a cursor plus per-type reset epochs; delivery sends rows changed since
  the cursor, found by an index on the version instead of recapturing and hashing a selection,
  and the parent no longer loses delivery state on restart. A definition change bumps the epochs
  of changed types. Per-child membership is still needed for ordered, limited selections.
- **Index sweep.** Drop indexes that active demand, downloads and recent use no longer need.
