---
"@party-stack/ontology-replica": patch
"@party-stack/ontology-backend": patch
---

Waiting for an action behind a blocked outbox entry now returns a `Conflict`. The action stays queued and can still complete after the blocker is resolved. `BackendError.blockedBy` identifies the blocking action when it is visible to the caller. Child replicas also receive the conflict when their selected view omits the blocker.

Backend action dispatches now time out after 30 seconds by default. Configure the deadline with `outbox.dispatchTimeoutMs`, or set it to `Infinity` to disable it. A timeout reports an unknown outcome. Only backends that support idempotent retries can retry it automatically. Once retries stop, the configured outbox failure strategy applies.
