# Public API review — October 26

## Action waiting

The normal action call returns one Promise for authoritative confirmation plus local
reconciliation. Optimistic visibility still publishes the projection before that
Promise resolves. mode controls offline admission only: direct requires connectivity,
outbox permits offline queueing. Both use the same executor and return the same result.
Queued/accepted/confirmed handles are not added to the ordinary API without evidence
that applications need those distinct observations. Recovery/admin tooling retains
outbox.wait and low-level enqueue observations. Awaiting an action offline can take
arbitrarily long; a blocked observation rejects even when a paused entry remains for
explicit repair. Interrupting a runtime does not roll back durable intent.

The issue-tracker form uses actions.createIssue(...).catch(showToast), closes
optimistically and keeps discard-all. No application-side enqueue/retry executor.

## Vocabulary

Use apply action for execution, action request for its identified inputs and action
receipt for committed evidence. The normal API remains actions.<name>(parameters).
Keep validate versus validateDraft and resolveParameters: preflight validity,
partial-draft validity and default/prefill evaluation are different operations.
Keep unknown execution outcome distinct from Uncertain preflight validation.

October 27 cleanup: the native API now uses ActionRequest, applyAction/ApplyAction,
operationId on receipts/journal correlation, and providerOperationId for optional
upstream metadata. The app-facing idempotencyKey supplies ActionRequest.id and the
receipt's operationId; it is stable across retries, not the action type's name.
BackendError.actionOutcome keeps unknown/not-committed execution evidence separate
from retry scheduling. No aliases retain the old method or receipt-field vocabulary.
Low-level outbox accepted/completed observations remain distinct from this naming.

Backend adapters now acquire one native service through scoped open(context).
Parallel adapter-level validation, Promise attachment hooks and cleanup callbacks
are removed. Host attachment preparation only gathers locally staged bytes. Native
provider action execution owns uploads/parameter encoding and returns mappings in
its receipt. Native attachment staging remains available for explicitly eager use.

The current direct/outbox mode labels also deserve review: both use the outbox and
wait for confirmation, so an explicit offline-admission option may be clearer. Do
not mix that future naming decision with optimistic visibility or a second executor.

## Query work and v0 gates

Context binding is available now through baseObjectTypeQueries callbacks receiving
{ctx, objectType}. Full Query IR also needs lexical/correlated scopes, relationships,
joins, nested results and per-parent pagination; execution and authorization must
agree across memory, IndexedDB, SQL and adapted sources. Implementing a builder alone
does not provide safe policy execution. See query-ir.md for the existing direction.

Pull hierarchical query/context-binding work into the final Gateway phase of v0.
Do not introduce an exists-first public policy API. Relationships and correlated
subqueries belong in the shared Query IR; existence checks can be an execution
lowering detail. Live query watching/IVM and subscribeSubset remain deferred. See
subset-subscriptions.md for the owned journal's support and remaining membership work.

Remaining Gateway gates are dynamic projected Describe/context discovery, relational
read policies and reference-input authorization through those same views, bounded
principal/form/revision-bound upload staging, and live end-to-end form/prefill/query/
attachment/action parity. The source-row/property read guard is now implemented.
General public replica-state projection remains deferred; finite Gateway operations
do not require exposing base/outbox/overlay protocol access.

Broader v0 closure still requires migration acceptance across examples/providers,
unknown-outcome recovery UI/coverage, cleanup of remaining deprecated transport after
Gateway parity, and pressure/lifecycle tests. Persistent protocol-child row/blob GC,
full query watching/IVM, schema migrations, idempotency-window negotiation, ranges,
durable resumable uploads and automatic cache byte budgets remain future work.
