# Outbox errors and form recovery

LiveOntology.outbox.collection contains the engine's lifecycle status: queued,
sending, acknowledged (receipt saved; reconciling), or blocked. It does not flatten
all failures into a generic failed status. lastError is the shared BackendError,
including kind, message, issues, retryable and actionOutcome; raw causes are
not included. Example:

```ts
{
  id: "submission-1",
  status: "blocked",
  request: { actionTypeName: "createIssue", parameters: { project: "deleted-id" }, idempotencyKey: "submission-1" },
  attempts: 1,
  lastError: {
    _tag: "BackendError", kind: "ValidationFailed", operation: "invoke",
    message: "Submission failed validation.", retryable: false,
    actionOutcome: "not-committed",
    issues: [{ path: ["project"], code: "InvalidObjectReference", message: "Choose a valid value." }],
  },
}
```

An unknown invocation outcome is a fact about a remote attempt, not a separate
lifecycle state. It can coexist with queued automatic retries on an idempotent
source, or with blocked after the retry budget is exhausted. retryRequiresAcknowledgement
means the parent cannot safely deduplicate another attempt. It can also be true after
a session/result expires, even if the source normally supports idempotency. Uncertain
continues to mean the separate preflight validation report; it is not an outbox status.

The pending record retains the last unknown outcome across rejected retries until
there is a receipt or an explicit recovery decision. Paused work does not expire.

## An online form that keeps field errors visible

```ts
import { BackendError } from "@party-stack/ontology-backend";

try {
    // Both modes await confirmation. "direct" additionally requires connectivity.
    await ontology.actions.createIssue(parameters, { mode: "direct" });
    closeForm();
} catch (error) {
    if (error instanceof BackendError && error.kind === "ValidationFailed") {
        for (const issue of error.issues ?? []) {
            if (issue.path?.length) setFieldError(issue.path, issue.message);
            else setFormError(issue.message);
        }
    } else setFormError(error instanceof Error ? error.message : "Submission failed.");
}
```

The engine handles transient retries and Retry-After. The form should not run its
own HTTP retry loop. With failureStrategy:"discard-all", terminal rejection removes
pending intent and its optimistic projection; the caller still receives the structured
error. A bounded terminal result delivers it across SharedWorker/tab boundaries under
the existing resultRetentionMs policy. It is not an executable outbox entry. Corrected
form submissions use a new invocation. Issue-tracker uses this policy.

An offline form can use mode:"outbox" to allow offline admission. Its action Promise
stays pending until authoritative confirmation and local reconciliation, possibly much
later. Visibility does not change that waiting contract. For an optimistic UI:

```ts
void ontology.actions
    .createIssue(parameters, { visibility: "optimistic", mode: "outbox" })
    .catch(showActionErrorToast);
closeForm();
```

No manual enqueue is needed. Expected failures reject with BackendError; direct
admission while offline is Unavailable with actionOutcome:"not-committed" and
does not enqueue anything. A lost response after dispatch may instead have an unknown
outcome. Low-level outbox.enqueue still exposes accepted/completed observations for
administrative and recovery tools. The ordinary action API has one confirmation Promise.

For apps using failureStrategy:"pause", a definitely rejected action remains pending.
Update it without creating a second queued copy:

```ts
await ontology.outbox.edit(submission.entry.id, (request) => {
    request.parameters = correctedParameters;
});
await ontology.outbox.wait(submission.entry.id, { until: "confirmed", signal });
```

Editing is allowed only before dispatch or after a known not-committed rejection.
Sending, receipt reconciliation and unknown outcomes cannot be edited. Explicit retry
resets the retry budget, preserving total attempts. Unknown outcomes needing a human
decision require retry(id, {allowUnknownOutcome:true}); this can duplicate execution.
remove(id, {allowUnknownOutcome:true}) abandons local intent and does not undo a remote
write. A verified receipt can be supplied to reconcile instead. Ordinary remove/retry
calls refuse an unsafe unknown-outcome decision. In-flight/reconciling actions cannot
be discarded. Interrupting a wait does not cancel the action.

Issue-tracker closes its new-issue form optimistically and observes the normal
actions.createIssue Promise to show a failure toast. It uses discard-all; rejected intent
is removed and corrected input is a new action. The field-rendering example above is
available for forms that prefer awaiting confirmation. The owned backend checks
reference existence inside the commit transaction, even if an earlier preflight
succeeded. Devtools shows structured issues for paused work and asks for acknowledgment
before unsafe retry/discard.
