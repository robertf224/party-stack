# @party-stack/ontology-backend

Effect-native backend contracts, normalized errors and authoritative execution.
Adapters depend on this package for subset snapshots, action receipts, validation,
attachment/decrypt capabilities and optional journal/watch interfaces.

## Native adapter and operation identity

An adapter's scoped open(context) returns one OntologyBackendService. Validation,
attachment IO and other capabilities live on that service, not parallel Promise
hooks on the adapter. Scope owns cleanup. Source signatures use Effect.Effect and
Stream.Stream directly; there are no Run/Events aliases.

The execution hook is applyAction(ActionRequest), also named ApplyAction on RPC.
The caller's idempotencyKey is the stable ActionRequest.id. The returned receipt's
operationId identifies that same submission across retries. It is not the action
type's name. providerOperationId is optional upstream metadata, such as Foundry's
own execution identifier, and is not used for local retry identity or settlement.

```ts
interface ActionReceipt {
    operationId: string;
    providerOperationId?: string;
    outcome: "committed" | "accepted";
    cursor?: string;
    // Read-back targets and attachment ID mappings are additional receipt fields.
}
```

Action uploads contain only locally staged bytes. Reusing an existing remote handle
does not cause a download/re-upload. Provider applyAction owns its upload/encoding
pipeline and returns canonical ID mappings with the successful receipt. Those
mappings are not installed ahead of the receipt. Explicit eager staging uses the
native attachments.stage capability, where available.

loadSubset/watchSubset remain snapshot/invalidation operations. changes.pull returns
the source-wide journal; changes.watch is only its wake-up stream. A future
query-scoped data subscription is deferred; see the
[subscription design note](../../specs/2026-10-19-effect-tables-replica/subset-subscriptions.md).

## Failures and validation

`BackendError` is a Schema.TaggedError with a `kind` discriminator. Operation failures
include Unauthenticated, Forbidden, NotFound, ValidationFailed, Conflict,
NotImplemented, RateLimited, Unavailable and Internal. Recovery failures separately
identify HistoryExpired, SessionExpired, SessionReplaced, ViewReplaced, ResultExpired,
SourceMismatch and SchemaMismatch. Source/schema changes require explicit reset or
migration; a transient transport reconnect does not replace the runtime or outbox.

`retryable` controls automatic retry scheduling. `actionOutcome` separately says
`not-committed` or `unknown`: a rejected/throttled write can retry safely, while a lost
reply may have committed. Missing outcome on Unavailable/Internal is conservative.
An earlier unknown outcome remains unknown after a later rejected retry. A durable
receipt is saved before local mappings/read-back, so recovery never redispatches an
already successful write merely because local reconciliation failed.

`validateAction(name, parameters, {knownParameters?})` returns an Effect containing
the portable certain/uncertain report. `knownParameters` selects draft validation;
invalid input is a report, while provider/authentication failures use the error
channel. Authoritative apply raises ValidationFailed with structured field issues.
Schema-valid input is not proof that arbitrary mutator business logic will succeed:
the owned backend reports uncertainty rather than executing the mutator for preflight.

Issues carry a path, optional constraint code and input/reference/custom classification.
Servers select disclosure separately. Provider diagnostics are redacted; credential
plaintext is unwrapped only at SDK boundaries. Redacted prevents accidental printing,
not unauthorized access by trusted code or encryption at rest.

## Owned execution and retention

`makeOwnedBackend` commits object changes, action receipts and journal entries in one
ontology-storage transaction. Trusted library integrations can use `storage.read` /
`storage.transaction` to share that journaling implementation; application operations
normally remain actions.

Configuration:

```ts
const owned =
    yield *
    makeOwnedBackend({
        namespace,
        ir,
        tables,
        mutators,
        resultRetentionMs: 7 * 24 * 60 * 60 * 1_000,
        history: { maxCommits: 10_000, maxAgeMs: 24 * 60 * 60 * 1_000 },
        clients: {
            sessionIdleTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
            maxSessions: 256,
            maxUnacknowledgedActions: 1_024,
        },
    });
```

Result retention is measured from completion, independent of journal retention and
idle client-session expiry. Infinity is supported for results and journal bounds;
retaining an audit history intentionally consumes storage. Bounded indexed
`maintenance` expires results, journal history and session delivery bookkeeping.
The HTTP server scope schedules maintenance; other hosts must run it from their own
lifecycle/alarm. Pending outbox work is not expired by result cleanup.

Idempotency is finite when result retention is finite. Reusing an operation ID after
its result has expired may execute it again. Advertising/versioning a remote retry
window is deferred; `supportsIdempotency` does not promise eternal receipt retention.

A client session tracks ordered submissions, acknowledgments and delivered state.
Acknowledgment removes submission fingerprints; expiry removes session/delivery
records, not accepted unresolved actions. Limits are configurable admission bounds,
not a limit on stateless readers. SharedWorker hosts use a shorter ten-minute lease.

Journal expiry raises HistoryExpired. A replica rebuilds retained/active demand from
coordinated snapshots, atomically installs base/cursor, preserves its local outbox
and replays optimistic work. Expired parent sessions establish a new identity while
preserving queued work; an unresolved accepted result becomes blocked with an unknown outcome rather than
being submitted again silently.
