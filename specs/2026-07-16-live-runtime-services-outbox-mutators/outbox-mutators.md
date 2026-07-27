# Durable outbox and replayable mutators

The [standalone coordination specification](../2026-07-26-coordination/README.md)
defines the client/host service and leadership contracts used by this design.

## Status

Design specification. This document is authoritative for the outbox,
authoritative-sync reconciliation, and async mutator work. It supersedes the
outbox and mutator sections in the directory README where they conflict.

### Current vertical slice

Implemented:

- Structured persisted ontology outbox collection.
- Coordinator-owned FIFO drain task, connectivity wake-ups, and cleanup.
- Serialized cross-context enqueue/edit/remove/retry commands.
- Execution claim IDs that reject stale completion and invalid removal.
- Restart restoration with isolated optimistic-projection failures.
- Public `NonRetriableError` support for permanent adapter failures.
- `direct` versus `outbox` write modes with optional optimistic prediction.
- Async custom mutators with local `queryOnce` reads and one live manual
  TanStack transaction.
- Declarative action logic compiled into the same edit plan.
- Stable idempotency-key propagation through remote-ontology transport.
- TanStack Devtools outbox panel.

Still required before production automatic retry:

- Server-side idempotency storage and authoritative mutation receipts.
- A complete cross-collection `defer-until-empty` sync barrier.
- Durable receipt/base persistence ordering.
- Blob transfer prerequisite jobs.
- Mutator versioning and replay-safe context serialization.

Automatic retry is intentionally disabled until server idempotency exists;
failed/interrupted entries require explicit retry.

Adapters throw `NonRetriableError` for validation, authorization, or other
permanent failures. The outbox marks those rows non-retriable, rolls back their
prediction, rejects the current completion handle, and keeps the row for
inspection/edit/removal.

## Goal

Build a durable, serial action outbox with Zero-shaped optimistic prediction:

```text
authoritative client-side base
+ predictions produced by pending semantic mutations
= visible ontology state
```

The system must:

- Persist user intent before remote dispatch.
- Never lose an accepted local write across refresh or process failure.
- Execute remote actions at least once with stable idempotency keys.
- Replay predictions in FIFO order whenever authoritative state changes.
- Support arbitrary async client mutators that query only locally available
  data through `queryOnce`.
- Run declarative ontology action logic through the same mutator API.
- Keep server execution separate from client prediction.
- Support blob uploads as parallel prerequisites without forcing file
  transfers into the serial action lane.

Exactly-once remote effects require server-side idempotency. A client cannot
distinguish “request never arrived” from “server committed but response was
lost” without a stable idempotency key and durable server receipt.

## TanStack DB current behavior

### Core sync queuing

As described in [TanStack DB RFC #1625][tanstack-rfc], a collection keeps
committed sync transactions in `pendingSyncedTransactions` while any user
transaction registered with that collection is in `persisting` state:

```text
if no persisting transaction OR truncate sync OR immediate sync:
    apply all committed sync transactions
else:
    leave committed sync queued
```

Important details:

- A merely `pending` `autoCommit: false` transaction does not trigger this
  guard.
- The guard is collection-local. A transaction that reads collection B but
  mutates only collection A does not prevent B's sync from applying.
- `begin({ immediate: true })` applies all committed queued sync transactions,
  not just the immediate transaction, to preserve ordering.
- Current core reprojects `PendingMutation.modified` snapshots after sync. It
  does not rerun application mutator intent.
- Core's queued sync transactions are in-memory collection state.

The guard is useful but is not a complete rebase substrate for arbitrary async
mutators. In particular, code cannot query the would-be authoritative state
represented by the queued sync without first exposing it or reading TanStack
internals.

### Persistence of queued sync

With `persistedCollectionOptions` wrapping a synced collection, visibility and
durability are separate:

1. The wrapper buffers each upstream `begin/write/commit` transaction.
2. On commit it calls core `params.commit()`. Core may leave that transaction
   queued because a user transaction is persisting.
3. Independently, the wrapper calls
   `persistAndBroadcastExternalSyncTransaction()`.
4. That method calls `PersistenceAdapter.applyCommittedTx()` with the captured
   operations and then broadcasts a commit notification.

Therefore, under normal operation, an authoritative sync transaction may
already be durable while remaining absent from `syncedData` and visible
collection state.

On restart:

- Core's old `pendingSyncedTransactions` queue is not restored.
- The persistence wrapper loads durable rows from the adapter.
- Hydration writes use `begin({ immediate: true })`.
- The collection reconstructs authoritative base state from persisted rows.
- Optimistic user transactions are not restored by this process. The outbox
  must restore semantic mutations and replay predictions.

There is a crash window: wrapped sync commit starts persistence
fire-and-forget. The sync `commit()` API is void and does not await
`applyCommittedTx()`. A process can terminate after core commit but before the
authoritative transaction reaches local persistence. The remote sync source
should eventually redeliver it, but production outbox acknowledgement cannot
use core commit alone as a local durability barrier.

Related sources:

- [Collection state manager][tanstack-state]
- [SQLite persistence wrapper][tanstack-persistence]
- [Load-subset applied-barrier issue #1657][tanstack-load-subset]
- [Optimistic mutation-log RFC #1625][tanstack-rfc]

## Assessment of `@tanstack/offline-transactions`

The package contains useful reference implementations for:

- Persist-before-execute ordering.
- Strict FIFO scheduling.
- Retry timestamps and backoff.
- Online notifications.
- Web Lock executor serialization.
- Restoration of optimistic TanStack mutations after restart.

A custom `StorageAdapter` backed by a local-only persisted collection would be
straightforward:

```ts
interface OfflineStorageRow {
    key: string;
    value: string;
}
```

`get`, `set`, `delete`, `keys`, and `clear` could map to collection operations
and `queryOnce`. This would make the raw storage durable through Party Stack's
runtime persistence.

However, using the package as the ontology outbox would lock us into semantics
that conflict with this design:

1. **It persists captured `PendingMutation` snapshots.**
   `TransactionSerializer` stores `original`, `modified`, `changes`,
   `globalKey`, and collection ID. It does not persist semantic mutator
   name/arguments as the prediction source of truth.

2. **Restoration depends on TanStack internals.**
   It reconstructs partial `PendingMutation` objects, inserts restoration
   transactions into `collection._state.transactions`, and calls
   `recomputeOptimisticState()` directly.

3. **Successful execution completes before authoritative reconciliation.**
   `TransactionExecutor` removes the outbox row as soon as `mutationFn`
   succeeds. `OfflineExecutor` then marks the restoration transaction completed
   with the comment that sync will provide authoritative data, but it does not
   await a receipt/read-path barrier.

4. **Public removal is storage removal, not semantic cancellation.**
   `removeFromOutbox(id)` deletes the storage row but does not remove the
   scheduled transaction or roll back the original/restoration optimistic
   transaction. `clearOutbox()` clears storage and the scheduler but likewise
   does not reconcile every projection transaction.

5. **Editing is not a supported lifecycle.**
   `OutboxManager.update()` exists internally as a shallow transaction-record
   replacement, but there is no public edit API and no automatic rollback and
   replay of that entry plus every later prediction.

6. **Non-leader contexts bypass durability.**
   `createOfflineTransaction()` falls back to a normal online TanStack
   transaction when the context is not leader. Party Stack wants every context
   to enqueue into shared durable state while only one context drains it.

7. **The storage schema is opaque to product queries.**
   A collection-backed key/value adapter would expose rows, but each value
   would still be a serialized transaction blob. An outbox UI needs structured,
   queryable fields such as action type, status, parameters, attempts, errors,
   and timestamps.

### Decision

Do not use `@tanstack/offline-transactions` as the ontology outbox
implementation.

Reuse its algorithms and tests as references, especially FIFO scheduling,
retry handling, connectivity wake-ups, and leader behavior. Implement the
smaller Party Stack outbox directly as a structured local-only persisted
collection under `packages/ontology/src/live/outbox`.

This is less adaptation work than wrapping and then overriding transaction
serialization, restoration, cancellation, editing, receipts, non-leader
behavior, and optimistic reconciliation.

### Outbox editing and removal semantics

The outbox collection should expose explicit operations:

```ts
interface OntologyOutbox {
    enqueue(request: OntologyActionRequest): Promise<OutboxEntry>;
    edit(
        id: string,
        update: (draft: EditableActionRequest) => void
    ): Promise<OutboxEntry>;
    remove(id: string): Promise<void>;
    retry(id: string): Promise<void>;
}
```

Rules:

- `edit` and `remove` are allowed for records that have not started remote
  execution, and for locally/permanently failed records.
- Editing updates the durable semantic request, then replays that entry and
  every later prediction.
- Removing rolls back/rebuilds the aggregate prediction without the removed
  entry.
- Once dispatch may have reached the server, ordinary edit/remove is unsafe.
  Use `cancelRequested`, wait for the authoritative receipt, or enqueue a
  compensating action.
- Editing a never-dispatched entry may preserve its queue position, but should
  issue a new idempotency key/revision if any prior version could have escaped.
- The outbox view is a normal live query over structured outbox rows.

### Structured concurrency

The outbox executor is implemented as an Effection resource layered on the
runtime Coordinator:

- A buffered queue receives enqueue, collection-change, connectivity, and retry
  wake-ups.
- Followers submit commands to the Coordinator leader.
- The leader validates and applies commands one at a time.
- Only the leader's spawned drain task claims and executes entries.
- Retry sleeps are cancellable operations.
- Coordinator channels, subscriptions, and task handlers have deterministic
  cleanup.
- Halting the outbox task stops retries, unregisters handlers, unsubscribes
  listeners, and closes its collection.

The ordinary Promise-facing `OntologyOutbox` API is a host wrapper around this
scoped operation.

## What Zero actually does

Zero does not reconcile directly against one mutable live store and does not
rely only on delaying incoming sync.

The [Replicache architecture documentation][replicache-how-it-works] describes
the same model directly: rewind to the last server version, apply the new
server patch, replay pending mutations, and atomically reveal the completed
branch to subscriptions.

Replicache, which supplies Zero's client mutation substrate, represents state
as immutable B-tree commits:

- The current visible state is the main head.
- A pull creates a separate sync snapshot at `SYNC_HEAD_NAME`.
- The sync snapshot includes server `lastMutationID` values.
- Local mutation commits whose IDs are newer than the server watermark are
  selected for replay in ascending mutation-ID order.
- Each pending mutator is rerun asynchronously against the sync head.
- Each replay produces a new commit on the sync branch.
- Only after all replay is complete does Replicache move the main head to the
  completed sync head.
- Subscription diffs are withheld while replay remains and are emitted after
  the final head change.

Relevant implementation:

- [`maybeEndPull()`][zero-pull] builds the sync head, identifies acknowledged
  mutations, and delays the main-head switch until no mutations remain.
- [`rebaseMutation()`][zero-rebase] reruns the named async mutator from stored
  JSON arguments against the current sync-branch basis.
- [`IVMSourceBranch`][zero-ivm-branch] forks query sources using copy-on-write
  structures, patches them to the desired commit, and provides the query view
  used during rebase.
- [`TransactionImpl`][zero-client-tx] exposes `reason: "optimistic" | "rebase"`
  and routes mutator queries and writes to the correct branch.
- Zero keeps desired queries registered while mutations are pending so rebase
  does not lose client-side data that was available to the original mutator.

The branch is cheap because immutable B-tree nodes and IVM sources are
structurally shared until modified. It is not a full eager copy of the client
database, but it is still a distinct queryable state branch.

### Lessons from Zero

1. **Persist mutator identity and arguments, not predicted row snapshots.**
   Rebase reruns the mutator by stable name with stored JSON arguments.
2. **Use stable monotonic mutation IDs.** Server mutation watermarks determine
   which local mutations have become authoritative.
3. **Keep a separate authoritative candidate branch during replay.** This lets
   async mutators query the next base without exposing it prematurely.
4. **Publish one final visible transition.** Rebase commits are built offscreen;
   subscribers are notified after the final head switch.
5. **Mutator code must remain replayable.** Removing a mutator under the same
   schema version breaks rebase. Zero falls back to a no-op visible prediction
   while still retaining the queued server mutation.
6. **Async mutators are transactional because they run against a stable branch.**
   Queries do not observe concurrent authoritative movement during one run.
7. **Query retention is part of correctness.** Locally available data needed by
   pending mutators cannot be discarded before those mutations settle.

Sources:

- [Zero mutator documentation][zero-mutators]
- [Replicache pull/replay][zero-pull]
- [Replicache mutation rebase][zero-rebase]
- [Zero IVM query branch][zero-ivm-branch]

## Do we need a snapshot or workspace?

### Initial decision: defer sync until the outbox drains

The first optimistic implementation will not build an invisible rebase branch.
It will lean into TanStack's existing behavior:

1. Persist an outbox entry.
2. Run async mutators serially against current visible client data.
3. Apply optimistic edits in TanStack user transactions whose mutation
   functions remain pending while their outbox records execute.
4. Let incoming authoritative sync reach persistence while core queues visible
   sync application behind persisting optimistic transactions.
5. Execute remote actions FIFO.
6. When no optimistic outbox work remains, settle the transactions and let
   TanStack apply queued authoritative sync.

A narrow planning mutex/wrapper must prevent sync from changing collection
state while a newly invoked async mutator is between `queryOnce` calls but has
not yet entered `persisting` state.

The initial implementation does not create snapshot collections. One manual
`autoCommit: false` transaction is kept pending while the async mutator runs:

- Each write calls `transaction.mutate()` synchronously.
- Later `queryOnce` calls read the live collections and observe those writes.
- A thrown mutator rolls back the transaction.
- After planning succeeds, commit enters `persisting` and waits for the outbox
  entry to settle.

This strategy intentionally delays remote visibility. It does not rerun later
predictions after each head action settles. Server execution remains
authoritative and serial, so clients eventually converge when the queue drains.

Use it for the first version because it provides durable async optimistic
writes with much less machinery. Add telemetry for oldest-entry age and sync
deferral duration. Long-lived offline/retrying queues and highly collaborative
applications are the primary cases that may justify advanced rebase.

### Queue-only, snapshot-free reconciliation

A correct but visibly non-atomic first implementation can avoid a hidden
workspace:

1. Persist the semantic outbox record.
2. Run the async mutator against live collections.
3. Apply each write to a manual TanStack transaction as the mutator progresses.
4. Keep sync stable with an ontology-wide sync gate while the mutator is
   awaiting.
5. When sync arrives, roll back predictions, expose queued authoritative sync,
   and rerun pending mutators FIFO against live state.

This avoids copying data but has observable intermediate states:

- Async mutator writes may become visible incrementally.
- During rebase, UI may briefly show unpredicted authoritative state.
- Live queries can process rollback, sync, and replay as separate event waves.

TanStack's built-in queue alone is insufficient because:

- Async planning starts while a new manual transaction is still `pending`, not
  `persisting`.
- The queue is collection-local and does not track read dependencies.
- A mutator can read B and write A; sync on B can advance while A's prediction
  remains based on old B.
- Queued sync is not exposed as a queryable next-base branch.

### Invisible async reconciliation

If reconciliation must remain invisible, some distinct next-state workspace is
required. It does not need to be a full clone.

Options:

1. **Lazy copy-on-write mutator workspace**
   - Maintain authoritative base separately from visible projection.
   - Fork only queried object types/subsets.
   - Overlay mutator edits in memory.
   - Run pending mutators FIFO against the evolving workspace.
   - Atomically or synchronously replace the visible projection when complete.

2. **Hidden authoritative collections plus public projection collections**
   - Server sync and persistence update hidden base collections.
   - Async replay queries hidden base plus an edit overlay.
   - Public ontology collections receive one reconciled snapshot transaction.
   - Strongest semantics without modifying TanStack core, but doubles the
     collection layer.

3. **TanStack core reconciliation primitive**
   - Add a mutation-log/base projection API aligned with RFC #1625.
   - Replace authoritative base plus pending mutation program in one batched
     materialized transition.
   - Best long-term design, but requires an upstream change or maintained fork.

4. **Synchronous aggregate-transaction swap**
   - Plan asynchronously in a hidden workspace while the old prediction stays
     visible.
   - Roll back one aggregate projection transaction.
   - Apply authoritative sync as immediate.
   - Apply the new aggregate projection transaction synchronously.
   - React may batch this, but TanStack subscriptions are not guaranteed to
     avoid intermediate rollback/sync/replay events.

These remain advanced options. Implement them only after the
`defer-until-empty` strategy is working and measurements show that delayed
authoritative visibility is unacceptable.

## Why one long-running TanStack transaction is not sufficient

One aggregate transaction is useful for representing visible prediction, but
it does not provide a hidden next-state branch:

- Mutations added to a TanStack transaction are optimistic and visible
  immediately.
- A `pending` aggregate transaction can accept additional `mutate()` calls but
  does not make core queue sync.
- A committed `persisting` transaction makes core queue sync but can no longer
  accept new mutations.
- Rolling back the transaction recomputes collection state and emits changes
  immediately.
- Applying a new transaction after rollback emits another optimistic change
  wave.
- The new transaction cannot be prepared invisibly on top of a different
  authoritative base.

An aggregate projection transaction still has benefits:

- One rollback instead of one rollback per outbox entry.
- No cross-entry TanStack rollback cascade.
- Outbox entries remain the per-mutation status source of truth.
- Final replay edits can be applied synchronously in FIFO order.

### Rollback cascade behavior

TanStack `Transaction.rollback()` scans other global pending transactions. If
another pending transaction has a mutation with the same `globalKey`, it is
rolled back as a secondary conflict rollback.

Consequences for one transaction per outbox entry:

- Rolling back an older entry can implicitly roll back later conflicting
  entries.
- Their `isPersisted` promises reject.
- Collection state recomputation and events occur as each transaction changes
  state.
- Tail-to-head rollback or `isSecondaryRollback` can avoid repeated cascade,
  but does not make the visible transition atomic.

Using one aggregate projection transaction avoids cross-entry cascade, but the
transaction still must be replaced on every reconciliation.

## Proposed Party Stack architecture

### Durable semantic record

```ts
interface OntologyOutboxEntry {
    version: 1;
    id: string;
    sequence: number;
    ontologyId: string;
    actionTypeName: string;
    parameters: SerializedValue;
    replayContext?: SerializedValue;
    mutatorVersion: number;
    idempotencyKey: string;
    createdAt: number;
    status:
        | "queued"
        | "executing"
        | "awaitingReceipt"
        | "failed";
    attempts: number;
    nextAttemptAt?: number;
    lastError?: SerializedError;
    attachmentJobs: BlobTransferDescriptor[];
}
```

Persist generated IDs, timestamps, random seeds, and every other
nondeterministic input required by prediction. Do not let replay call ambient
`Date.now()` or `crypto.randomUUID()` and expect identical intent.

### Mutator contract

```ts
interface OntologyReadTx {
    query<T>(
        build: (
            query: InitialQueryBuilder,
            objects: OntologyMutatorQueryObjects
        ) => QueryBuilder
    ): Promise<T>;
}

interface OntologyMutatorTx extends OntologyReadTx {
    mutate: Record<
        string,
        {
            create(object: Record<string, unknown>): Promise<void>;
            update(
                key: string | number,
                changes:
                    | Record<string, unknown>
                    | OntologyPropertyChange[]
            ): Promise<void>;
            delete(key: string | number): Promise<void>;
        }
    >;

    readonly now: number;
    createId(label: string): string;
}

type OntologyMutator = (options: {
    tx: OntologyMutatorTx;
    args: Record<string, unknown>;
    replayContext: Record<string, unknown>;
}) => void | Promise<void>;
```

Expression evaluation and action-parameter default resolution receive an
`OntologyReadTx`. Object-reference paths resolve through `queryOnce`; they do
not call `collection.get`. Writable mutators extend the same read transaction
with `mutate`.

The same async interpreter runs:

- Declarative `applyActionLogicToMutatorTx`.
- Explicit named custom mutator steps.
- Client prediction.
- Replay after authoritative sync.

Server execution may use a different implementation under the same semantic
action name.

### Foundry staged-write execution

`@party-stack/foundry-ontology` exposes:

```ts
createFoundryStagedWriteMutatorTx(...)
runFoundryOntologyMutator(...)
```

The adapter maps the common `OntologyMutatorTx` write API to Foundry's ambient
TypeScript v2 `WriteableClient`:

- `create` uses the generated object type token supplied by the function.
- `update` and `delete` use `$apiName` plus `$primaryKey` references.
- Nested property changes are converted into Foundry update records.
- An optional query adapter routes `tx.query` into the ambient staged-write
  query context.

Foundry then supplies read-after-write, nested staged function composition,
atomic commit on success, and rollback on throw. A Foundry function can call
the same semantic mutator used for client prediction:

```ts
await runFoundryOntologyMutator({
    ir,
    client,
    mutator,
    args,
    objectTypes: { Task },
});
```

This keeps client prediction and Foundry authoritative execution on one
mutator contract without requiring the same transaction implementation.

### Reconciliation components

1. **Outbox collection**
   - Durable source of semantic mutation order and retry state.
   - Persist-before-dispatch.

2. **Mutator registry**
   - Stable name plus version to async replay implementation.
   - Missing or incompatible versions become explicit blocked entries.

3. **Authoritative base branch**
   - Queryable state containing only server/persistence data.
   - Must not include current optimistic projection.

4. **Mutator workspace**
   - Cheap branch/fork over authoritative base.
   - Supports `queryOnce`.
   - Applies buffered edits immediately so reads observe previous writes and
     previous pending mutators.

5. **Projection manager**
   - Holds one aggregate manual TanStack transaction representing all currently
     visible predictions.
   - Replaces it after a replay generation.

6. **Executor**
   - One Coordinator-leader online worker.
   - Claims entries with a unique `executionId`.
   - Executes action requests FIFO with stable idempotency keys.
   - Accepts completion/failure only from the current execution claim.
   - Runs blob transfer prerequisites with separate bounded concurrency.

7. **Receipt reconciler**
   - Reads stable client mutation IDs from authoritative sync.
   - Excludes acknowledged outbox entries before replay.
   - Deletes/archive entries only after receipt/base durability is established.

## Initial action flow

1. Resolve and serialize action parameters.
2. Generate mutation ID, deterministic replay inputs, and idempotency key.
3. Persist the outbox entry.
4. Fork the current authoritative/predicted workspace.
5. Run the async mutator.
6. If prediction succeeds, derive edits and update the visible aggregate
   projection.
7. If prediction fails, retain a failed/blocked outbox entry and expose no
   partial prediction.
8. Wake the executor.

The branch sketch in `rf/runtimes` has a useful edit-buffer API, but its query
runner rebuilds all temporary collections for every query. Improve it by
creating one workspace per replay generation and applying each edit to that
workspace as it is recorded.

## Authoritative reconciliation flow

1. Receive a complete authoritative sync batch and mutation receipts.
2. Keep the current visible projection unchanged.
3. Fork a workspace from the next authoritative base.
4. Exclude every outbox entry acknowledged by receipts.
5. Replay remaining mutators FIFO against the same evolving workspace.
6. If another authoritative batch arrives, invalidate or advance the workspace
   generation and replay again.
7. Once replay completes:
   - Roll back the old aggregate projection.
   - Apply authoritative base changes.
   - Create the new aggregate projection transaction.
   - Apply all derived edits synchronously.
8. Emit/observe one final visible transition if the chosen TanStack integration
   supports batching; otherwise measure the intermediate event behavior.
9. After authoritative persistence is confirmed, delete or archive acknowledged
   outbox entries.

## Persistence and crash safety

### Required ordering

For a new mutation:

```text
persist outbox intent
then expose prediction
then dispatch remote work
```

For acknowledgement:

```text
persist authoritative rows + mutation receipt
then suppress/remove prediction
then delete/archive outbox intent
```

The current TanStack sync wrapper does not expose an awaitable persistence
barrier. Add one of:

- An observer around `PersistenceAdapter.applyCommittedTx`.
- A Party Stack sync wrapper that returns a durable batch promise.
- Collection metadata receipts persisted in the same authoritative transaction
  and checked during outbox restoration.

The receipt is important because persistence and outbox records are separate
collections and cannot be updated atomically through the current
collection-scoped `PersistenceAdapter`.

### Restart

Startup is an explicit state machine:

```text
opening
  -> loadingOutbox
  -> hydratingBase
  -> restoringPredictions
  -> ready
  -> draining
```

Required ordering:

1. Open runtime persistence, locks, and coordination.
2. Load durable outbox rows and mutation receipts.
3. Create object collections with remote sync temporarily gated.
4. Hydrate locally persisted authoritative object state.
5. Remove/suppress outbox entries already covered by durable receipts.
6. Rerun remaining semantic mutators FIFO and create fresh optimistic TanStack
   transactions. Do not restore serialized `PendingMutation` snapshots.
7. Mark LiveOntology ready and allow application queries.
8. Resume upstream remote sync.
9. Only then allow the Coordinator leader to begin remote outbox execution.

Outbox loading and base hydration may run concurrently, but prediction replay
waits for both. Remote execution always starts after prediction restoration so
receipts cannot race startup reconstruction.

Every context restores its own in-memory optimistic projection from shared
durable outbox rows. Only the runtime Coordinator leader performs remote
execution. Projection installs are serialized per entry so collection-change
and command-response paths cannot apply one prediction twice.

`persistObjects` belongs to `CreateLiveOntologyOpts`, because object
persistence is a live ontology composition choice rather than a capability of
`RuntimeAdapter`. Platform `RuntimeAdapterProvider` values supply collection
persistence but do not choose whether ontology object collections use it. The option is currently
forwarded without implementing object persistence behavior.

When object persistence is implemented, `persistObjects: true` means local
persistence supplies the startup base before remote sync resumes.
`persistObjects: false` means one initial remote bootstrap makes object
collections ready before prediction restoration and normal operation.

If a live ontology does not persist ontology object data, a restart while offline can
restore the outbox but cannot correctly answer arbitrary mutator queries until
authoritative client data is available again. No write is lost, but prediction
must wait. Compositions that promise immediate offline replay must persist the
required object data.

## Blob uploads

Blob transfer work is a prerequisite graph, not the serial action lane:

- Outbox action entries reference immutable local blob IDs.
- Transfer jobs persist destination, progress, resumable token, and remote ID.
- Transfers can run with bounded parallelism across multiple actions.
- Action submission remains FIFO and waits until its required transfers are
  materialized.
- Completed remote mappings become stable blob resource facts.
- Outbox and transfer records retain referenced local blobs against GC.

## Devtools

`@party-stack/ontology-devtools` contributes an `Ontology Outbox` plugin to
TanStack Devtools. The initial panel is a live query over structured outbox
rows and exposes:

- Queue order and action type.
- Queued/executing/failed status.
- Attempt count and last error.
- Retry and safe remove controls.

Later panels can add mutation replay generations, network/lock state,
blob prerequisites, and authoritative receipts.

## Implementation passes

### Initial file layout

Implement the first ontology-specific version inside
`packages/ontology/src/live` rather than prematurely extracting a generic
package:

```text
packages/ontology/src/live/
  outbox/
    types.ts
    createOntologyOutbox.ts
    executor.ts
    receipts.ts
    retry.ts
    tests/

  mutators/
    types.ts
    forkedCollectionOptions.ts
    createOntologyFork.ts
    createMutatorTx.ts
    runMutator.ts
    reconcilePredictions.ts
    projection.ts
    tests/
```

Responsibilities:

- `outbox/` owns durable semantic action records, FIFO remote execution,
  idempotency, retry, online/lock integration, receipts, and attachment
  prerequisites.
- `mutators/` owns local query/write APIs, async declarative/custom execution,
  forks/workspaces, edit derivation, replay, and publication to visible
  collections.
- Declarative action logic lives in the mutator subsystem and uses the same
  `OntologyMutatorTx` as custom mutators.
- `LiveOntology.ts` composes the two subsystems but does not expose runtime
  locks, persistence adapters, or internal projection transactions.

Live actions expose one callable async operation:

```ts
await ontology.actions.createTask(parameters, {
    idempotencyKey,
});
```

`LiveOntologyActionExecution`, public `mutationFn`, and public `mutator`
closures are removed. Direct transactions, prediction, and outbox enqueue are
implementation details selected by the write configuration.

If a later non-ontology consumer appears, extract the generic queue executor
from `live/outbox` after its durable semantics are proven.

### Pass A: confirmed-only ontology outbox

- Create a structured local-only persisted outbox collection.
- Persist-before-dispatch semantic action records.
- FIFO executor, locks, connectivity, retry policy.
- Stable idempotency keys.
- Live outbox queries and explicit edit/remove/retry APIs.
- Editing/removal restricted to records that have not possibly reached the
  server.
- No optimistic ontology behavior.

### Pass B: async mutator API

- Port `OntologyMutatorTx` and `OntologyEdit` from `rf/runtimes`.
- Run async declarative and custom mutators.
- Serialize async planning so `queryOnce` reads stable client-side state.
- Apply optimistic edits through TanStack user transactions that remain
  persisting while their outbox entries execute.
- Verify local queries, read-your-writes, FIFO execution, deterministic inputs,
  and restart restoration.

### Pass C: deferred-sync optimistic execution

- Defer visible authoritative sync while optimistic outbox work remains.
- Keep authoritative sync persistence active.
- Settle optimistic transactions as their records complete.
- Flush queued sync when the optimistic queue empties.
- Measure queue age, sync deferral, final event behavior, and collaborative-app
  staleness.

### Pass D: advanced invisible reconciliation decision

Based on production measurements:

- Keep `defer-until-empty` if queue durations remain short.
- Otherwise introduce `forkedCollectionOptions` and a replay workspace.
- Consider hidden base/public projection collections for guaranteed invisible
  publication.
- Or contribute the required mutation-log/batched-reconciliation primitive to
  TanStack DB.

### Pass E: receipts and crash barriers

- Add server mutation IDs/receipts.
- Observe authoritative persistence completion.
- Add every crash-point test before enabling automatic retry.

### Pass F: blob prerequisites

- Add durable parallel transfer jobs.
- Integrate blob retention and remote ID mappings.
- Remove temporary blob upload orchestration from the blob package.

## Required tests

### Mutator semantics

- Async query followed by create/update/delete.
- Query after an earlier write in the same mutator.
- Later mutator reads an earlier pending mutator's result.
- Declarative and custom mutator steps share one interpreter.
- Mutator throw exposes no partial final prediction.
- Stable IDs/time/random inputs survive replay.
- Missing and version-mismatched mutator handling.

### Reconciliation

- Authoritative result exactly matches prediction.
- Authoritative result differs and every later mutator is rerun.
- Unrelated authoritative change affects a row read by a pending mutator.
- Acknowledged prefix is removed by mutation watermark.
- Another sync batch arrives during replay.
- Subscription and derived-query event sequence during aggregate swap.
- Server-generated ID mapping uses explicit receipt metadata.

### Crash safety

- Crash after outbox persistence before prediction.
- Crash during async prediction.
- Crash after prediction before dispatch.
- Crash after server commit before client response.
- Crash after authoritative persistence before outbox deletion.
- Restart suppresses entries covered by durable receipts.
- Duplicate dispatch returns prior server result.

### Multi-context

- One context executes while all contexts project.
- Coordinator propagates outbox and authoritative changes.
- Cross-context remove/edit commands are serialized with execution claims.
- Removal of an executing entry is rejected.
- Coordinator leader closes during request.
- Follower restarts and replays from shared durable state.

## Decisions

- Persist semantic mutator name/args, not TanStack pending mutations.
- Require server idempotency before automatic retry.
- Require explicit mutation receipts or stable client identity.
- Keep prediction and remote execution separate.
- Support async local-only queries.
- Start with `defer-until-empty` reconciliation.
- Preserve replayable semantic APIs so invisible fork/rebase can be added
  without changing application mutators.
- Use Zero's branch-and-final-head-swap model as the semantic reference.
- Treat TanStack's current queued sync as useful buffering, not as a complete
  queryable rebase branch.
- Prototype one aggregate projection transaction, but do not assume it makes
  rollback/sync/replay atomic to subscribers.
- Do not base the ontology outbox on `@tanstack/offline-transactions`; reuse its
  scheduling/retry ideas while storing structured semantic records directly.

## References

[tanstack-rfc]: https://github.com/TanStack/db/issues/1625
[tanstack-state]: https://github.com/TanStack/db/blob/main/packages/db/src/collection/state.ts
[tanstack-persistence]: https://github.com/TanStack/db/blob/main/packages/db-sqlite-persistence-core/src/persisted.ts
[tanstack-load-subset]: https://github.com/TanStack/db/issues/1657
[replicache-how-it-works]: https://doc.replicache.dev/concepts/how-it-works#mutations
[zero-mutators]: https://zero.rocicorp.dev/docs/mutators
[zero-pull]: https://github.com/rocicorp/mono/blob/main/packages/replicache/src/sync/pull.ts
[zero-rebase]: https://github.com/rocicorp/mono/blob/main/packages/replicache/src/db/rebase.ts
[zero-ivm-branch]: https://github.com/rocicorp/mono/blob/main/packages/zero-client/src/client/ivm-branch.ts
[zero-client-tx]: https://github.com/rocicorp/mono/blob/main/packages/zero-client/src/client/custom.ts
