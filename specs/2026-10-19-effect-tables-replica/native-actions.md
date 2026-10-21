# Native actions and backend construction

October 21 checkpoint. Live ontologies now run through Replica; there is no
second collection-based outbox executor or compatibility backend constructor.

## Construction and lifetime

`OntologyBackendAdapter` supplies a scoped `open(context)` Effect returning an
`OntologyBackendService`. That service loads subset snapshots, invokes actions,
runs query functions and optionally supplies attachment reads, watch hints or a
durable journal. Provider bindings no longer construct private TanStack
collections to implement those operations. Metadata bindings also load snapshots
directly from their SDKs, then apply residual predicates and pagination.

`makeReplicaHost` composes the backend, storage, attachment facade and Replica in
an Effect Scope. Closing that Scope releases subscriptions and owned resources.
TanStack collections are demand/materialization facades over the resulting
Replica, with a separate persisted-only facade for inspection and replay. The
first demand attempts synchronization before declaring its initial view ready;
offline synchronization still reads persisted state without network loads.

The issue tracker uses an IndexedDB-owning SharedWorker and memory tab Replicas.
Worker-unavailable startup has an in-process fallback. This placement does not
mean private connection/installation ownership or all platform acquisition has
finished migrating.

## Action lifetime and waits

The durable queue distinguishes queued, sending, acknowledged, blocked and
uncertain work. Forwarding to a parent and executing against an upstream adapter
are separate stages; their attempts are not interchangeable.

- **Accepted** means the immediate parent accepted responsibility. Its storage
  determines whether that acceptance survives a crash. For an adapter-backed
  Replica without a protocol parent, acceptance means local queue admission.
- **Confirmed** means upstream commitment has been observed and local receipt
  read-back/journal settlement has completed. An accepted-only receipt cannot
  satisfy this wait.

The collection-facing outbox exposes both observations:

```ts
const action = await ontology.outbox.enqueue({
    actionTypeName: "updateIssue",
    parameters: { id, status: "done" },
});
await action.accepted;
await action.completed;

// A separate, cancellable observer of an existing action:
await ontology.outbox.wait(action.entry.id, {
    until: "confirmed",
    signal: AbortSignal.timeout(10_000),
});
```

Aborting a wait only stops that observation. It does not cancel the durable
action or undo a remote write. Internally, `replica.awaitAction` is an Effect;
interrupting its fiber releases the scoped change subscription.

## Retries and failure strategy

`writes.outbox` configures `maxRetries` (additional attempts, default 3),
`retryDelayMs` (default 1,000; exponential delay capped at 60,000 ms), and
`failureStrategy` (`pause` by default). Deadlines and total attempt counts are
persisted. A manual retry renews the automatic retry budget without resetting
the historical attempt count.

Failures known to precede remote submission can retry safely. An unavailable
response after possible submission is ambiguous. A backend's
`supportsIdempotency` guarantee must be durable and reject conflicting reuse of
an invocation ID; simply receiving an ID is insufficient.

- **pause:** preserve terminal failures as blocked or uncertain, retaining their
  optimistic intent and dependencies for explicit recovery.
- **discard-all:** abandon the whole local pending queue on terminal failure,
  including unknown remote outcomes. Remove its predictions/dependencies,
  invalidate coverage, and refresh active demand. This is appropriate when the
  application prefers to return to observed server state. It cannot cancel a
  write that may already have committed remotely; that write can appear on refresh.

Under pause, known failed work can be edited/retried or removed. Uncertain work
requires either a verified receipt or an explicit retry decision:

```ts
await ontology.outbox.reconcile(id, independentlyVerifiedReceipt);
// Or, after explicitly accepting possible duplicate execution:
await ontology.outbox.retry(id, { allowAmbiguous: true });
```

Reconciliation verifies the invocation identity and persists the receipt; normal
read-back still runs. It does not itself query a provider to discover an outcome.
There is no general Foundry invocation lookup for a lost response in this checkpoint.

## Receipt and attachment ordering

Dispatch persists the successful receipt before local attachment ID bindings or
confirmation reads. The receipt carries canonical attachment ID mappings. An
idempotent `onReceipt` hook applies them after persistence and retries them on
restart. If mapping application or read-back fails, the acknowledged action and
receipt remain available; neither failure resubmits the action.

This fixes an ordering bug in which a post-submit mapping failure could escape
before Replica received the receipt. It was not a requirement imposed by external
blob storage. Blob metadata/roots already have transactional storage operations;
the remaining facade consolidation can put receipt and mapping metadata changes
in one transaction. External byte IO still needs generation/fencing recovery
rather than pretending it shares a database transaction.

## Replay inputs and limits

Admission freezes portable `replay.now` and `replay.seed` values and forwards them
through parent/proxy calls. Ontology expression `now` and UUID generation use
those values; structural locations keep nested/map-generated IDs distinct and
stable. Rebase runs against persisted transactional data without remote demand.
An explicit UI `resolveParameters` call can acquire normal demand before submission.

Confirmed-only execution resolves parameters without requiring a speculative
execution of action logic. Authoritative execution still runs the action normally.

Custom mutators that call ambient `Date.now()`, `crypto.randomUUID()` or other
external effects directly are not automatically made deterministic. Completed
receipt/history compaction, general protocol reset recovery and uncertainty UX
remain separate work; this checkpoint does not establish production-ready
untrusted remote replication.
