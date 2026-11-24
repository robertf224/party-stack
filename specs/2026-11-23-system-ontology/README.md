# System ontologies and definition changes

## Status

Tracking note, not a design. It lists the control surfaces that should become ordinary
ontologies, what has already moved, and the direction for definition changes and migrations.
Items move from "Candidates" to "Done" as they land.

## BLUF

Prefer modelling control and definition state as ordinary ontologies (object types, actions,
queries) served through the same protocol as application data, instead of adding special RPCs
or side channels. Each special operation removed shrinks the protocol, the internal-access
allowlist and the client surface, and gives every tier (owned server, replica, client) the
same model.

## Done

- **Offline downloads (pins).** `pinOntology` (`packages/ontology-replica/src/pinModel.ts`)
  has a `Pin` object type and an `updatePins` action. It is served as an ordinary ontology
  through the `pins` resource header (`packages/ontology-server/src/rpc.ts`).
- **Account inventory.** Signed-in accounts are the Connect ontology, read with ordinary
  queries (`packages/ontology/src/authentication.ts`, `packages/connect`).
- **Ontology metadata.** The meta ontology (`@party-stack/ontology-spec/meta`) describes
  object, link, action and value types as rows. `pull` builds IR from any backend that
  answers its queries, including a replica of a metadata backend.

## Candidates, in rough order

1. **Retire the single-pin RPCs.** `ReadPin`, `WatchPin`, `SetPin` and `ClearPin`
   (`packages/ontology-server/src/operations.ts`) and `LiveOntology.pins.get/set/clear/subscribe`
   predate named pins. Remaining callers: the Notes app (clearing a legacy pin), a homepage
   code sample and a web-runtime e2e test. An app with one notion of downloaded data can use
   one named pin. `PinStatus` reports `previousGraphRetained`/`retainedGraph`, which the `Pin`
   row would need to gain.
2. **Outbox controls as objects.** A `PendingAction` object type with remove, retry and edit
   actions would replace `ControlOutbox` and `OntologySource.outbox`. Pending and completed
   actions already travel as delivery records. These control actions must not go through the
   outbox themselves, and need a privileged policy.
3. **Definitions from the meta ontology.** Serve a route's IR and context as meta rows on a
   `meta` resource and shrink `Describe` to a manifest (version, source id, definition hash,
   capabilities). Open questions: a definition read spans several queries, so it needs a hash
   or revision check to avoid mixing revisions; per-principal definition projection must apply
   to meta rows.
4. **Definition status.** Retained, current or incompatible becomes a subscription to the meta
   `Ontology` row's hash. The typed `SchemaMismatch` error on operations stays.
5. **Replica status.** Read-only `Replica`, `Demand` and `Load` objects for devtools. Load
   changes constantly, so watch the delivery traffic.

Generalizing the `pins` resource header to named system resources (`pins`, `meta`, `system`)
is the shared mechanism for 1, 3 and 5. Once those move, the internal-access RPC allowlist
becomes a policy on that resource.

**Keep as protocol:** delivery selection and the client handshake (results and actions travel
over them, so modelling them as actions would be circular), local data deletion (it destroys
the store that would record its receipt), attachment byte transfer. Traces are possible but
low value.

## Definition changes and migrations

**Today.** Replicas take `onDefinitionChange: "reset" | "error"`. `"reset"` clears cached rows,
coverage and delivery state when a replica opens under a different definition contract, and
keeps the outbox, receipts and every pin's desired query. Queued actions are replayed against
the new definition; a prediction that no longer applies is dropped and the action is still
sent, with failures handled by the outbox's `failureStrategy`.

**Next: `"migrate"`.** Compare definitions per object type instead of resetting everything:

| Change                                 | Cached data                                                                |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Object type added                      | New empty tables                                                           |
| Object type removed                    | Drop its tables                                                            |
| Property added                         | Keep rows; rewrite queries; mark the type's coverage stale so pins refetch |
| Property removed, cosmetic change      | Keep rows; ignore the old field                                            |
| Link, action or query function changed | Nothing cached                                                             |
| Property type or primary key changed   | Clear only that type                                                       |

Queued actions keep replaying as they do under `"reset"`. Store a schema
version per object type from the start, even while the only operations are "same" and
"reset".

**Changes as steps, delivered as data.** A definition change should travel as migration
steps (add type, add property, change type, rename, convert values), not as a whole new IR,
and should not need a special protocol message. The meta ontology can hold them as a change
log that replicas read with ordinary queries; the current definition is the base definition
plus its steps. Inferred steps (from comparing definitions) are the default; explicit steps
can be supplied with a definition and win for their type. Renames are the main case
inference cannot detect.

**Steps are lenses.** The steps should be [lenses](../2026-08-13-ontology-lenses/README.md),
so one mechanism provides both interface polymorphism and schema migration. A replica would
know which physical version each type's stored rows are at and serve reads and writes at the
logical version a client asked for, rewriting rows in the background. Overlapping migrations
compose as a chain, and a query against an interface backed by an object type with a pending
physical migration passes through several rewrites before reaching storage.

**Outbox migration.** Queued actions migrate too. For declarative logic the properties an
action writes are known statically, so a write to a deleted property can be removed
automatically; a richer action language can recover the same information by static analysis.
Opaque function-backed actions are paused for the user. Versioned action parameters, as
some public APIs version their requests, become another migration step on outbox entries.

**Scoping.** An app can replicate a subset of a large definition (for example the types its
workspaces use) and grow or shrink it. With `"migrate"`, adding a type is a cheap step rather
than a reset.
