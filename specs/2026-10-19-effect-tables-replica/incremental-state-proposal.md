**Replication proposal · October 27, 2026.** Scoped composition and the runtime
boundary cleanup below are implemented in this checkpoint. Incremental transfer,
shared incoming-state installation and protocol-child GC/blobs remain proposals. This document proposes the next
replication and browser-composition checkpoint. Existing selected snapshots,
atomic parent handoff, streaming attachments, and adapter-backed GC remain the
working baseline. This is not a promise that every item belongs in the initial v0.

## Goals and boundaries

1. Remove replica/transport/attachment/lifecycle assembly from browser applications.
2. Apply incoming objects through common transactional bookkeeping, while keeping
   provider confirmation and protocol acceptance semantics explicit.
3. Deliver incremental selected state, including inherited predictions and action
   progress, with bounded server memory and snapshot recovery.
4. Support protocol replicas with ordinary row retention and local blob storage.
   Memory tabs should use the same machinery, backed by memory and their parent.
5. Leave a stable receiving contract for hierarchical queries and eventual server IVM.

We should not build another nested Replica engine for the parent's system tables.
The existing imported base/overlay/actions already represent parent state. We can
share its installation mechanics without recursively instantiating more engines.

## What already exists

`makeReplica` accepts either a provider backend or a protocol source. Both use the
same local outbox, transactional optimistic replay, action controls, and waits.

| Input                      | Current path         | Responsibility unique to that path                                                     |
| -------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| Adapter subset snapshot    | `prepareSnapshot`    | Completeness, coverage, repair of rows that left a filter/window.                      |
| Adapter committed journal  | `pullJournal`        | Upstream cursor order, authoritative puts/deletes, receipt correlation.                |
| Protocol selected snapshot | `receiveParentState` | Parent revision/view checks, imported base/overrides/actions, local-to-parent handoff. |

Protocol `Changes` currently carries notifications. The child responds with a
`Read` and atomically installs a replacement selected snapshot. Selection is
evaluated on composed visible state, and includes local-action dependencies and
explicitly retained action IDs. Normal object demand does not import all parent
actions. An outbox inspector can explicitly request broader action inspection.

Today a protocol source requires `gc: false` and no blob service. The row sweeper
does not coordinate imported records and the materialized parent projection.
It does not mean all cleanup is disabled: replacing selected snapshots removes
old imported membership, action/session cleanup is separate, and memory scopes
are released. The worker's own adapter-backed GC still runs.

## Runtime composition

**Revised boundary:** do not introduce ontology-aware `web-runtime/tab` or
`web-runtime/shared-worker` exports. Runtime storage choice and process placement
are independent. The existing `WebRuntime.layer` already supports both
`storage: "memory"` and `storage: "indexeddb"`, in a window or a worker.

| Layer/package                | Responsibility                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `runtime`, `web-runtime`     | Scoped platform resources: tables, bytes, keys, connectivity, browser auth and ownership. |
| `ontology-replica`           | Replication state, demand, outbox, replay and retention.                                  |
| `ontology-tanstack`          | Local/replicated collection options, subset translation, and demand diagnostics.          |
| `ontology`                   | Domain execution and application collection/view composition.                             |
| `ontology-server/client`     | Scoped `connectLiveOntology` and framework `createConnectedLiveOntology` composition.     |
| `ontology-server/rpc/worker` | Worker transport and `serveOpenedOntologyWorker` readiness/lifecycle.                     |

The collection bridge is separate because Connect also consumes generic local
collections; putting them in ontology itself would create a cycle through
ontology -> Connect -> ontology. Runtime no longer imports ReplicaService or
TanStack DB. Platform-plus-collection tests moved into ontology-tanstack so platform
packages do not gain dependencies on their application consumers. No second
storage/schema abstraction was introduced.

Applications choose definitions, authenticated identity partition, domain
mutators, worker URL/transport and platform resources. The ontology client
composer constructs the Replica/view, delegates operations and installs tracing.
It acquires the connection inside its own scope. The worker composer starts
serving before acquisition finishes, awaits readiness, propagates typed startup
failures and cleans up the opened facade and partial resources on failure.

```ts
const open = createConnectedLiveOntology({
    ir,
    connection, // Effect from connectOntologyWorker/HTTP, with transport supplied.
    runtime: WebRuntime.layer({ owner: userId, namespace, storage: "memory" }),
    writes: { defaultMode: "outbox", defaultVisibility: "optimistic", mutators },
});

const serve = serveOpenedOntologyWorker({
    open: openTrackerOntology, // Scoped Effect; application validates its partition.
    errors: "forward", // Trusted identity-isolated same-origin deployment only.
    authorize: () => Effect.void,
});
```

The first constructor is a Promise boundary backed by a ManagedRuntime. Native
Effect applications instead construct `connectLiveOntology` in a service Layer
and supply Runtime there. The worker function is a long-running scoped Effect,
provided with the platform WorkerRunner. It does not choose browser persistence.
See the website's installation guide for complete composition examples.

The client helper acquires transport, local replica and collection view in that
order; scope cleanup releases them in reverse order. Existing delayed TanStack
observer disposal remains a documented separate upstream lifecycle issue; this
helper alone does not fix that warning.

Worker fallback is configured, not guessed from every error. A fallback may run
an in-process persistent owner after a definite unsupported/startup failure,
before this client accepts writes, acquiring the same partition's host lock.
Authentication/schema errors must propagate. A timeout alone does not prove that
another host stopped. Never silently downgrade durable acceptance to memory-only.
The worker partition name routes a trusted same-origin client; it is not an
authorization proof for an untrusted iframe.

## Logical state and record identity

Reuse the current concepts: confirmed rows, inherited overrides, pending actions,
and retained completed results. Separate these from the child's own outbox and
overlay. Do not expose arbitrary internal table names on the wire.

These illustrative types omit Effect Schema definitions and existing details of
ActionRequest/ActionReceipt. They describe the intended record shapes:

```ts
type ObjectRef = { objectType: string; key: string | number };
type Override = { deleted: true } | { deleted: false; value: ObjectValue };

type StateRecord =
    | { kind: "base"; ref: ObjectRef; value: ObjectValue }
    | { kind: "override"; ref: ObjectRef; value: Override }
    | { kind: "pending-action"; id: string; value: PendingAction }
    | { kind: "action-result"; id: string; value: ActionResult };

type RecordRef =
    | { kind: "base" | "override"; ref: ObjectRef }
    | { kind: "pending-action" | "action-result"; id: string };

type RecordChange = { kind: "put"; record: StateRecord } | { kind: "remove"; record: RecordRef };
```

An adapter supplies confirmed object changes and result evidence; it does not
invent parent pending actions or sessions. A protocol parent can supply all four
record kinds. A server backed by owned authoritative storage normally has no
speculative override/pending projection to send.

Removing a record from a selected view means that the child should no longer
mirror that record. It does not prove global object deletion. Provider journal
deletion is separate authoritative evidence and invalidates relevant cached rows
and coverage. An optimistic delete is an override tombstone and can be rolled back.
For selections evaluated on visible rows, disappearance may simply be a membership
removal rather than a transmitted deletion override.

## Shared installation and transaction boundary

Extract a small internal incoming-state module inside ontology-replica. It owns:

- Base/override installation and removal, schema/key checks and preservation of
  matching device-encrypted cached copies.
- Refreshing the existing materialized baseline used by local replay.
- Row retention records and blob reverse-reference changes for affected records.
- Coverage invalidation when a deletion/eviction makes previous proofs unusable.

Keep provider acquisition and protocol envelope validation in source-specific
code. Provider receipt recovery and parent acceptance/handoff remain explicit
steps in their transaction; the shared object applier must not hide those policies.

For a protocol update, one table transaction:

1. Checks source ID, definition signature, stream epoch, selection generation,
   and expected previous sequence.
2. Applies imported objects and action records. A snapshot replaces the current
   mirror; a patch modifies the existing mirror.
3. Moves matching locally owned actions into forwarded tracking when the imported
   parent state includes them. Persists results/receipts before clearing recoverable
   action state. Request identity checks prevent a same-ID/different-action handoff.
4. Updates row/blob retention and invalidates affected coverage.
5. Recomputes the parent's visible baseline and replays the still-local outbox.
6. Persists the installed stream position and derived local revision.

Notify observers and acknowledge the installed sequence only after commit. Any
failure rolls back position, handoff and objects together. Ack failure is safe:
redelivery is either recognized as already installed or resets to a snapshot.

Adapter journal installation uses the same object/retention primitives, updates
its own upstream cursor and receipt evidence, and replays once in its existing
transaction boundary. Do not reinterpret partial adapter snapshots as complete
replacements or treat omission from a filtered load as authoritative deletion.

Initially keep imported base/overrides and the materialized replay baseline
separate, as today. Removing that duplicated materialization is an independent
optimization requiring query/performance evidence; this proposal does not depend
on it. A second recursive engine would add lifecycle and replay coordination.

## Incremental delivery contract

Add a selected-state stream to the protocol, alongside the existing finite
read/submit operations. Preserve finite operation support for stateless callers.
This is a replacement for notification-plus-repeated-Read on connected replica
clients, not a requirement for every backend adapter or request/response proxy.

```ts
interface StreamPosition {
    epoch: string;
    sequence: number;
}

type StateUpdate = {
    sourceId: string;
    definition: string;
    selectionGeneration: number;
    parentRevision: number;
    position: StreamPosition;
} & (
    | {
          kind: "snapshot";
          records: readonly StateRecord[];
          coverage: readonly SelectionCoverage[];
      }
    | {
          kind: "patch";
          previous: StreamPosition;
          changes: readonly RecordChange[];
          coverageChanges: readonly CoverageChange[];
      }
);
```

`parentRevision` orders parent state. `position` orders this stream's deliveries
and identifies its diff baseline. Neither is a provider's opaque change cursor.
Different selections of the same parent revision need not have identical records.
Action idempotency/submission sequence remains separate from delivery sequence.

While a selected-state stream is active, use it as the only installer of parent
state. A Submit reply reports acceptance/result evidence, but must not also install
an independently captured, unsequenced replacement snapshot. Keep the child's own
prediction until a stream update includes that action, then transfer ownership
atomically. Persist acceptance evidence for recovery; observing acceptance alone
does not remove the local prediction before the corresponding parent projection
arrives. Finite snapshot callers retain their existing snapshot flow. Switching
between these modes starts a fresh stream epoch. Fence snapshots from superseded
connections as well as old selection generations.

`SelectionCoverage` identifies a requested subset/query and whether the parent
can prove its full result at that revision, or is serving a partial/offline local
result. It describes coverage of the parent's visible view and its freshness
mechanism; it must not imply authoritative freshness the parent cannot prove.
Use explicit full/partial evidence rather than equating successful transfer with
complete data. Snapshot replacement includes explicit absence for requested
action IDs; an ordinary patch omission does not expire an action result.

### First producer: evaluate and diff

1. Acquire parent change notifications before taking the initial snapshot.
2. Materialize the selected records from a consistent parent transaction and send
   the initial snapshot. All modeled types can be represented, including empty ones.
3. Coalesce notifications, reevaluate the current selected state, and diff keyed
   records. Send only changes with their parent revision. Include overlay rollback,
   action handoff and result changes, not just committed base rows.
4. A limit/order query may require removing an old row and inserting the new row
   that enters its window. Diff the actual result; do not infer this from the
   changed source row alone.

The first producer can reuse `snapshotStateIn`. It reduces wire traffic while
still reevaluating the selection. Exact result membership does not require IVM.
Unsupported source pushdown can still cause broader upstream fetches; full query
IR may also let us express narrower demand. Those are distinct costs.

Bound state to one acknowledged selected baseline and one in-flight update per
connection/view. While awaiting ack, coalesce new notifications into one dirty
flag; evaluate again after ack instead of accumulating updates. Enforce configurable
serialized-byte/record limits and acknowledgement timeout. Large snapshots can
arrive in bounded transport frames and be assembled in staging tables, then
atomically activated; partial frames are never visible. Count and expire orphaned
staging generations. Configured view-size rejection must be explicit, not silent
truncation. These bounds are application protocol policy, not Effect RPC defaults.

### Selection changes and reconnect

Initially a new selection generation starts a replacement snapshot. Fence late
messages from old generations. On disconnect, discard the producer's diff state
and start a new stream epoch plus snapshot. The child preserves its own outbox
and performs existing accepted-action recovery; a read-stream reset does not
authorize resubmitting a possibly committed action.

This first version needs no durable per-client diff log. Existing bounded client
submission/session bookkeeping continues to protect action acceptance. Later,
retained stream history could enable resume from an acknowledged position with
an explicit expiry/reset result. That must have its own byte/age retention limits.
Never keep every historical selected result for every child indefinitely.

## Example: Issue 42 and two tabs

Initial confirmed row: `Issue 42 { title: "Fix login", status: "Open" }`.

1. Tab A applies Complete. The persistent worker accepts it into its outbox.
2. Its state update adds a pending action and a Completed override. Importing that
   update removes Tab A's duplicate own prediction in the same transaction.
   Tab B needs only its selected effective object state, not all action records.
3. Tab A also applies a still-local Rename to `"Fix sign-in"`.
4. If upstream rejects Complete, a parent update removes the Completed override
   and records its failure. Tab A replays Rename and shows `"Fix sign-in", Open`.
   Tab B shows `"Fix login", Open`.
5. If upstream confirms Complete, the batch changes confirmed status to Completed,
   removes the now-redundant override and settles the action. Neither tab flashes
   the old status while those changes install.

Under a selected `status = Completed` query, rollback can instead remove Issue 42
from the view. The protocol sends a membership removal; the issue still exists.
The same operation works through a cloud replica, device worker, and tab because
each receiver applies imported state and then its own remaining outbox.

## Protocol-child row GC

This work is not dependent on incremental delivery. Shared installation and
coherent retention can enable protocol-child GC while snapshots are still the
transport. Conversely, adding diffs alone does not make GC safe.

The current guard disables the automatic age-based row-cache sweep for protocol
sources and rejects an independent blob service. Protocol installation does not
populate the ordinary row-retention records, and the sweeper only deletes the
materialized `base:<type>` copy. It would not remove/update imported base,
inherited overrides and the imported-head claims together. That could leave
orphaned state or recreate an evicted row on later projection. This is unfinished
source-specific bookkeeping, not a rule that protocol replicas cannot collect.
Replacement snapshots already remove deselected imported rows; bounded action
and session cleanup continue independently. Delegated bytes remain parent-owned.

Keep two concepts explicit: the **active imported mirror** and the **reusable
confirmed cache**. The mirror represents the installed selected view exactly.
Cache rows may outlive their selection, but cannot claim current coverage forever.

| Stored state                         | Location and retention                                                   |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Imported head/records                | Child tables, one current mirror and installed position per source/view. |
| Materialized parent projection       | Child tables, maintained transactionally with imported records.          |
| Reusable confirmed rows              | Child tables, existing accessed-at retention and invalidatable coverage. |
| Own outbox/overlay/forwarded actions | Child tables; retained until settled/discarded/recovered under policy.   |
| Active query/action/pin roots        | Same child tables and transaction as row/blob retention.                 |
| Parent producer baseline             | Parent memory, bounded per live connection, disposed on disconnect.      |

Concretely, keep `parent-base:<type>`, `parent-overlay:<type>`, `parent-pending`,
`parent-completed`, and the materialized `base:<type>`/local overlay tables. Extend
`parent-head` with the installed stream epoch/sequence and selection generation.
Reuse `outbox`, `forwarded`, `completed`, `retention`, `coverage`, `roots`,
`action-rows`, `action-queries`, and `pins`. Any retained confirmed cache separated
from the active materialization needs an explicit table/provenance record; do not
overload `parent-base` with inactive rows that a replacement snapshot claims absent.
The initial implementation can simply discard deselected objects, avoiding that
extra cache until it is useful. Blob tables remain in the same child database.

The first implementation protects all currently selected mirror records, exact
pending-action reads/writes, explicit row pins and action dependencies. This is
per-row/result protection, not protection of an entire object type. A selection
change drops unneeded mirror records; optionally retain their confirmed values
as ordinary cache rows. Do not retain a detached inherited prediction as confirmed
data. If exact separation is awkward initially, discard deselected rows rather
than caching a potentially stale speculative projection.

Reuse the existing age-based sweeper for inactive cache rows. It updates rows,
retention metadata, affected coverage and blob references in one transaction.
The child can keep reading cached rows while offline without treating their
presence as proof of a complete/fresh query.

Crucially, never evict an active mirrored record while retaining its current
stream baseline: an unchanged parent record would never be resent. To release
that data, first change selection with a new generation; to recover a corrupted
or deliberately dropped mirror, request a replacement snapshot/new epoch. Local
GC and selection changes serialize with state installation in the same tables.
Active roots win races with a sweep. A pinned inactive query becomes an active
selection, not just a claim that old coverage stays valid.

Initially retain the current policy shape (`intervalMs`, `olderThanMs`, bounded
`limit`). Age/space pressure budgets, measured retained row/byte size, and DO cache
limits need a separate explicit budget policy; existing adapters do not already
offer a complete space-budget collector. Live active demand can exceed a cache
budget, so admission/backpressure needs a defined failure, not silent row eviction.

## Protocol-child attachment modes

Target the same BlobStorage machinery in every replica, including memory tabs.
Its metadata/aliases/roots/intents share the replica's own table store; bytes use
the supplied memory, OPFS, file, SQL or R2 service. The parent supplies authorized
remote reads/uploads. Byte keys and physical intents are local and never replicated.

Current connected clients delegate attachment operations directly to their parent.
That is the temporary implementation gap guarded by no independent blob service,
not the intended permanent meaning of a tab replica. Merely constructing a
memory Runtime does not connect its bytes to protocol-child BlobStorage yet.

An ordinary child should lazily cache bytes it reads, stage bytes it creates,
and use the same retention policy to release unpinned cached bytes. This does
not imply downloading every referenced attachment or keeping duplicate bytes
forever. No tab-only blob manager or additional attachment-mode API is needed
before the normal local path is working. Parent delegation can remain a deliberate
future optimization if there is a demonstrated need.

For outgoing attachments, persist local staging and the owning action's attachment
dependencies before forwarding. Parent staging/materialization produces alias
mappings. Save returned receipt/mappings as durable evidence before applying them;
apply aliases, row/outbox changes and retention roots transactionally in the
child. Cross-process uploads and acceptance cannot be made one database
transaction: repeatable transfer identity, durable evidence and existing intents
provide recovery. Keep bytes needed by forwarded actions until confirmation or
an explicit safe discard. Read-stream pins last through EOF/cancellation.

Base, inherited override, own overlay, and pending/forwarded-action references
need distinct root owners so replacing one layer does not release another's
attachment. Row identity roots need not pin cached remote bytes; offline pins and
unsent staged dependencies do. Import, action handoff, row eviction and reset
update these roots using `blobs.in(tx)` in the same table transaction. Byte deletion
still happens through generation-fenced external intents after commit.

The current delegated path cannot promise independent offline attachment access
if the parent becomes unreachable. The normal local path only promises offline
reads for complete locally retained bytes. Range caching, resumability, direct object-store
grants and automatic query attachment-download policies remain future additions.

## Future query IVM

The initial selection language remains subsets. Hierarchical query IR can later
replace or extend selected query definitions while keeping stable query IDs and
selection generations. Its results need explicit root/nested result membership,
ordering/window identity and link edges; an object row alone cannot describe
which nested result it belongs to. Add those as result records alongside normalized
objects, without changing their identity or duplicating object storage per result.

Initially evaluate those queries normally and diff result records. Then replace
the parent producer with an incremental view maintained from committed row changes
**and** optimistic overlay/outbox changes. It emits the same transactional state
updates. Children keep their applier, handoff, retention and recovery behavior.
If TanStack DB powers the producer, establish a revision-consistent input batch
and capture the settled query result at that revision before emitting; arbitrary
collection callbacks do not automatically make a consistent replication batch.

Authorization and context bind before query evaluation and result publication.
Projection must also cover actions/errors/receipts; supporting an incremental
stream does not make raw replica-state access safe for untrusted clients. Query
result records become retention roots for their object identities. An IVM index
is parent-owned derived state with scope/size bounds, not an unbounded new journal.

## Implementation sequence and acceptance

1. **Implemented: untangle runtime and scoped composition.** Moved replica/TanStack
   collection integration into ontology-tanstack. Kept WebRuntime's existing storage modes.
   Replaced application `sharedOntology.ts` and
   worker readiness/cleanup assembly with common helpers. Verified identity isolation,
   startup failure, in-process fallback, diagnostics, and teardown. No sync rewrite.
2. **Extract incoming object installation.** Keep snapshot transport. Test identical
   adapter/protocol visible outcomes, encrypted-copy preservation, action handoff,
   atomic rollback, coverage and blob roots.
3. **Incremental selected-state stream.** Start with reevaluate/diff. Test two-tab
   updates, own-action handoff, rollback plus later local actions, limit-window
   changes, membership-vs-deletion, source/schema fencing, duplicate/gapped messages,
   disconnect-before-ack, slow consumers, bounds and replacement recovery.
4. **Protocol-child row retention.** Exercise a persistent child against an owned
   server and an intermediate. Test selection release, inactive cache eviction,
   pending dependency protection, concurrent sweep/install, and rehydration after
   reset. Remove the GC restriction only when these invariants hold.
5. **Protocol-child local attachments.** Use the normal BlobStorage machinery in
   memory tabs and persistent protocol children.
   Verify locally staged bytes through multi-hop acceptance, alias mapping, restart,
   reset with pending actions, interrupted IO, reader pins, and independent byte GC.
   Remove the no-blob-service guard only after these tests pass.
6. **Query IR and authorization.** Extend result records and policies. Server IVM
   can follow independently; it is not required for exact incremental transfer.

The compression is worthwhile if one installation primitive owns the same
row/blob/retention invariants in every path. It is not worthwhile if we force
provider adapters to fabricate parent sessions or encode every private engine
table as a public replicated ontology. Keep those boundaries and measure the
extra diff-state memory before enabling the stream broadly.
