# Live definitions

## Status

Design, being built on the definition-change branch. Replaces the route-level swap that only
ran for replicas fed by another server.

## BLUF

A replica follows its definition instead of being opened with a fixed one. When the definition
changes, the replica reopens itself behind the same handle, clearing only the object types whose
contract changed, and its children receive only those types again. This works the same for every
replica: one fed by a backend (a cache in front of a provider, an app host), one fed by another
server, and a browser worker. Servers only describe whatever definition the replica has now.

## Replica construction

```ts
const replica = yield* makeReplica({
    // Was `ir: OntologyIR`. A fixed definition still works and never changes.
    definition: metaDefinition(meta, { objectTypes: ["Task", "Project"] }),
    // A fixed backend, or one built for each definition (provider adapters compile the IR).
    backend: (ir) => makeProviderBackend({ ...connection, ir, context }),
    context,
    onDefinitionChange: "reset", // later "migrate"
});

replica.definition.current; // Effect<OntologyIR>
replica.definition.changes; // Stream<OntologyIR>, current first
```

```ts
type ReplicaDefinitionOption = OntologyIR | ReplicaDefinition;

interface ReplicaDefinition {
    /** The current definition first, then each one whose contract differs. */
    readonly changes: Stream.Stream<OntologyIR, BackendError>;
    /** Called when an operation failed in a way that suggests the definition is stale. A change
     * still arrives through `changes`; this only asks the source to look again. */
    readonly revalidate?: (hint: {
        readonly objectTypes: readonly string[];
    }) => Effect.Effect<void, BackendError>;
}
```

Sources:

- `metaDefinition(meta, options)` reads the meta ontology's rows with live queries and compiles
  them with the same code as `pull`. `meta` is anything that answers queries, normally a replica
  of the provider's metadata backend, so an app opens offline from its cached metadata. Options
  scope the object types and transform the pulled definition. `revalidate` revalidates the meta
  rows for the named types.
- `upstreamDefinition(client)` follows another server's description. A replica fed by another
  server, including a browser worker, uses it automatically when no fixed definition is given.

### Reopening

When `changes` emits a definition with a different contract, the replica:

1. holds new calls,
2. closes its engine (background work, watches, delivery streams),
3. opens a new engine under the new definition; the startup transaction clears only object types
   whose contract changed or that were removed (see the system ontology spec),
4. builds the backend again when `backend` is a function,
5. releases held calls on the new engine.

The handle stays the same. Live queries switch to the new engine and emit again; demand held
across the reopen is acquired again; outbox entries, receipts and downloads are kept as they are
for a reset at open. A definition the replica cannot open under fails the replica's status and
keeps the old engine closed until the next definition, as a failed open does today.

### Errors that suggest a stale definition

A backend reports `SchemaMismatch` with the object types involved when the provider rejects a
request for referencing a type, property, link, action or parameter it does not know, or for
using a property in a way it no longer allows. The replica calls `revalidate` with those types.
If the definition changed, the reopen follows and the failed load runs again on the new engine;
if not, the original error is surfaced. Provider "not found" errors that can also mean "no
access" are classified this way too, since revalidation is cheap and the original error is kept.

## Server and route construction

```ts
makeOntologyServer({
    routes: {
        "accounts/:account/:ontology": (params) =>
            Effect.gen(function* () {
                const connection = yield* connectAccount(params.account);
                return {
                    kind: "replica",
                    context: connection.context,
                    definition: metaDefinition(yield* metaReplica(connection, params.ontology)),
                    backend: (ir) => makeProviderBackend({ ...connection, ir }),
                    onDefinitionChange: "reset",
                };
            }),
    },
});
```

- A route's replica follows `definition`; the server describes `replica.definition.current` and
  rebuilds its handlers for each new definition. Requests and connections stay open.
- Removed: `OntologyRouteContext.definition({ context, load })` (the retained definition is the
  replica's own, or the meta replica's cache) and the route catalog's rebuild-on-mismatch path.
- `upstream` routes keep their shape and use `upstreamDefinition` internally.
- `serveOntologyWorker` keeps its options. Its replica follows the parent server's definition
  unless the app bundles one.
- Clients notice a new definition through the definition hash on frames, as today, describe again
  and rerun their live queries. An app that bundles a definition keeps its contract and reports
  the mismatch.

## Delivery to children

Delivery keeps per-stream memory of what each child has, and that memory now outlives an engine
reopen:

- A stream's binding no longer includes the definition; the stream records the definition hash it
  was last delivered under.
- On resume after a definition change, the parent compares the stream's definition with its own.
  If it still has that definition, it forgets what the child has only for object types whose
  contract changed and resumes; the first frame names those types and the child clears them in the
  same transaction that applies the frame. Otherwise (the parent restarted, or the child was
  stored under an older definition) delivery starts fresh, as today.
- The child reopens under the new definition through `upstreamDefinition` and resets the same
  types at open, so it never reads rows in the old shape.

Delivery memory is still held in memory, so a parent restart still means a full resend. Versioned
rows (below) remove that.

## Later

- **Describe as a manifest.** Serve the definition as meta rows plus a `definition` query
  function that returns the whole definition in one read, for when a client needs it
  transactionally. A provider can implement it with its whole-ontology metadata endpoint.
  `Describe` shrinks to version, source id, definition hash and capabilities.
- **Versioned rows.** Stamp each stored row with a version from a per-replica counter and keep
  tombstones. A child holds a cursor plus per-type reset epochs; delivery sends rows changed since
  the cursor, found by an index on the version instead of recapturing and hashing a selection. A
  definition change bumps the epochs of changed types. Per-child membership is still needed for
  ordered, limited selections, as in other sync engines.
- **Index sweep.** Drop indexes that active demand, downloads and recent use no longer need.
