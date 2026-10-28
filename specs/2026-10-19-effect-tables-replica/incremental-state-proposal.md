**Historical design proposal · October 27, 2026.** The implementation checkpoint is
now recorded in [incremental-delivery.md](./incremental-delivery.md). This file
retains the earlier proposal and tradeoffs; consult that implementation note and
[migration-status.md](./migration-status.md) for current behavior.

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

## Organizing model

**Base is the selected parent state; outbox tracks this replica's own outstanding
actions; overlay predicts actions not already included in base.** Parent pending
changes and selected parent action records are data in base. They are not another
local outbox. Keep the parent confirmed/predicted distinction where needed for
confirmed reads. Reads now compose those layers without a materialized
parent-visible row copy.

Acceptance/inclusion evidence prevents double application when a parent takes an
action. It is now stored on the local outbox entry, replacing the separate
forwarded table while preserving lost-reply recovery and final waits.

GC retains base records needed by active queries, outstanding-action dependencies
and pins; other cache data follows retention policy. Updating backing records,
derived indexes and completeness claims is one transaction. See
[the concrete GC rules](/docs/design/garbage-collection) before the implementation details.

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

Protocol sources now support ordinary row GC. They still reject an independent
blob service pending safe local byte staging and handoff. Replacing selected
snapshots removes old imported membership, while action/session cleanup remains
separate from row retention.

## Runtime composition

**Revised boundary:** do not introduce ontology-aware `web-runtime/tab` or
`web-runtime/shared-worker` exports. Runtime storage choice and process placement
are independent. The existing `WebRuntime.layer` already supports both
`storage: "memory"` and `storage: "indexeddb"`, in a window or a worker.

| Layer/package                | Responsibility                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `runtime`, `web-runtime`     | Scoped platform resources: tables, bytes, keys, connectivity, browser auth and ownership. |
| `ontology-replica`           | Replication state, demand, outbox, replay and retention.                                  |
| `ontology/tanstack`          | Local/replicated collection options, subset translation, and demand diagnostics.          |
| `ontology`                   | Domain execution and application collection/view composition.                             |
| `ontology-server/client`     | Scoped `connectLiveOntology` and framework `createConnectedLiveOntology` composition.     |
| `ontology-server/rpc/worker` | Worker transport and `serveOpenedOntologyWorker` readiness/lifecycle.                     |

TanStack integration now lives in `ontology/tanstack`. Connect's session manager
uses direct table transactions and read-only snapshots/monitors, so it no longer
requires TanStack or creates a cycle through ontology. Platform-plus-collection
tests live beside that adapter; Runtime remains independent of Replica and TanStack.
No second storage/schema abstraction was introduced.

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
- Updating confirmed rows and inherited overrides as the logical replay baseline.
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
3. Marks matching local outbox entries as included when the received parent state
   includes them. Persists results/receipts before clearing recoverable
   action state. Request identity checks prevent a same-ID/different-action handoff.
4. Updates row/blob retention and invalidates affected coverage.
5. Replays own actions not already included in the composed parent baseline.
6. Persists the installed stream position and derived local revision.

Notify observers and acknowledge the installed sequence only after commit. Any
failure rolls back position, handoff and objects together. Ack failure is safe:
redelivery is either recognized as already installed or resets to a snapshot.

Adapter journal installation uses the same object/retention primitives, updates
its own upstream cursor and receipt evidence, and replays once in its existing
transaction boundary. Do not reinterpret partial adapter snapshots as complete
replacements or treat omission from a filtered load as authoritative deletion.

Confirmed rows and sparse inherited overrides now compose directly below the
own-action overlay. The previous duplicate materialized parent baseline has been
removed. A recursive Replica for parent system tables is unnecessary.

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

Implemented independently of incremental delivery. Adapter and protocol replicas
use the same bounded age-based collector and the same three retention roots:
active queries, outstanding action dependencies, and explicit pins.

A protocol base consists of `parent-base:<type>` and sparse
`parent-overlay:<type>` records, composed directly by reads. Own actions remain in
`outbox` through parent inclusion, with an internal marker preventing duplicate
replay/submission. Their row/query dependency roots survive until reconciliation.
There is no duplicate materialized parent-visible table or forwarded-action table.

Installation populates ordinary retention candidates. A sweep deletes both base
components, retention metadata and affected coverage transactionally. It marks the
received head nonresident while preserving the original state digest. An identical
revision can then rehydrate data; a conflicting reuse of that revision still fails.
Selection generations and older-revision fencing remain in force. Active queries
are marked against confirmed, parent-published and final visible values; bounded
windows retain their offset prefix. Pins and action dependencies are included in
the requested parent selection. Local-only reads do not create backend fetch demand.

Selected snapshots can still discard deselected rows immediately; keeping extra
inactive rows is not required. Future incremental streams must preserve the same
invariant: never retain a complete stream baseline after discarding required data.
Recover a missing/gapped baseline through replacement rather than silently applying
later patches. The current snapshot residency flag is not a substitute for that
future stream sequence contract.

The existing policy remains `intervalMs`, `olderThanMs`, bounded `limit`. Byte/space
budgets and admission/backpressure remain future work; active roots must not be
silently evicted to meet a budget. See [concrete GC rules](/docs/design/garbage-collection).

## Protocol-child attachment modes

Target the same BlobStorage machinery in every replica, including memory tabs.
Its metadata/aliases/roots/intents share the replica's own table store; bytes use
the supplied memory, OPFS, file, SQL or R2 service. The parent supplies authorized
remote reads/uploads. Byte keys and physical intents are local and never replicated.

Implemented: connected clients compose normal local BlobStorage through the
common replica host. The protocol-child no-blob-service guard is removed.

An ordinary child lazily caches bytes it reads, stages bytes it creates,
and uses the same retention policy to release unpinned cached bytes. This does
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

The local path only promises offline
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
   collection integration into ontology/tanstack. Kept WebRuntime's existing storage modes.
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
4. **Protocol-child row retention — implemented for snapshots.** Tests cover
   selection/pin/window roots, inherited creations/deletions, accepted-action
   dependency retention, no rebase resurrection, same-revision refill and conflict
   fencing. Persistent byte ownership and incremental-stream reset tests remain
   in their respective steps.
5. **Protocol-child local attachments — implemented.** Normal BlobStorage in
   memory tabs and persistent protocol children. Tests cover multi-hop staging,
   transactional acceptance, failed alias reconciliation plus restart/result expiry,
   canceled IO, reader pins, independent byte GC and progressive cold RPC reads.
6. **Query IR and authorization.** Extend result records and policies. Server IVM
   can follow independently; it is not required for exact incremental transfer.

The compression is worthwhile if one installation primitive owns the same
row/blob/retention invariants in every path. It is not worthwhile if we force
provider adapters to fabricate parent sessions or encode every private engine
table as a public replicated ontology. Keep those boundaries and measure the
extra diff-state memory before enabling the stream broadly.
