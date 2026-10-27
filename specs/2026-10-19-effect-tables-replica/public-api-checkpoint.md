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

The lower-level contracts still contain ActionInvocation, invoke/Invoke,
invocationId/invocationOutcome, and low-level accepted/completed names. A coordinated
follow-up can rename these to ActionRequest, applyAction/ApplyAction, actionId/
actionOutcome and accepted/confirmed across adapters, protocol schemas, storage and
tests. Avoid aliases that leave two permanent public vocabularies. This checkpoint
does not claim those wire/storage names have already been changed.

The current direct/outbox mode labels also deserve review: both use the outbox and
wait for confirmation, so an explicit offline-admission option may be clearer. Do
not mix that future naming decision with optimistic visibility or a second executor.

## Query work and v0 gates

Context binding is available now through baseObjectTypeQueries callbacks receiving
{ctx, objectType}. Full Query IR would also need lexical/correlated scopes, exists,
joins, nested results and per-parent pagination; execution and authorization must
agree across memory, IndexedDB, SQL and adapted sources. Implementing a builder alone
does not provide safe policy execution. See query-ir.md for the existing direction.

Prefer a first relational slice (correlated exists + context bindings + related
lowering) over making server IVM/query watching a prerequisite. The immediate driver
is Gateway's existing context-path/join authorization, not live hierarchical query
subscription. A TanStack-based policy executor remains a possible parity bridge.

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
