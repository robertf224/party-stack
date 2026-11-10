# @party-stack/ontology-backend

Effect-native backend contracts, normalized errors and authoritative execution.
Adapters depend on this package for subset snapshots, action receipts, validation,
attachment/decrypt capabilities and optional journal/watch interfaces.

`/actions` owns portable IR action execution and parameter defaults. `executeAction`
reads and writes only its supplied transaction; callers own commit/rollback and
journaling. Replica replay and authoritative execution share it. Native custom
mutators receive an `ActionTransaction` with point/subset reads, writes and finite
QueryDocument execution. The `ontology` package separately adapts Promise/TanStack
mutators into this Effect-native contract.

`/subset` lowers object-bound spec subsets to provider/storage candidates. Replica
demand uses spec expressions; physical scans remain below that public boundary.
Exactness is required: unsupported demand computations return NotImplemented.

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
    outcome: "committed";
    cursor?: string;
    // Read-back targets and attachment ID mappings are additional receipt fields.
}
```

Action uploads contain only locally staged bytes. Reusing an existing remote handle
does not cause a download/re-upload. Provider applyAction owns its upload/encoding
pipeline and returns canonical ID mappings with the successful receipt. Those
mappings are not installed ahead of the receipt. Explicit eager staging uses the
native attachments.stage capability, where available.

`loadSubset` reads snapshots. `watchSubset` acquires invalidation notifications;
`changes.pull` reads the source-wide journal and `changes.watch` acquires its wake-up feed.
Both watch acquisitions are scoped Effects: they return only after the feed is
registered and buffering, even if the returned stream stays quiet indefinitely.
Closing the acquisition Scope releases the subscription.

```ts
// Inside the caller's Scope; undefined means this subset needs polling.
const acquire = backend.watchSubset?.(subset);
if (acquire) {
    const changes = yield * acquire;
    const snapshot = yield * backend.loadSubset(subset);
    // Process the snapshot, then consume changes to refresh it.
}
```

Changes between acquisition and snapshot consumption remain observable. Merely
returning a lazy `Stream.fromPubSub` inside `Effect.succeed` does not establish this
guarantee: acquire its subscription first. Parent acceptance is a separate replica
handoff operation; an ordinary action receipt reports authoritative commitment.
A future
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
        maintenance: { intervalMs: 60_000 },
    });
```

Result retention is measured from completion, independent of journal retention and
replication delivery expiry. Infinity is supported for results and journal bounds;
retaining an audit history intentionally consumes storage. Bounded indexed
`maintenance` expires results, journal history and retained delivery bookkeeping.
Acquisition requires an Effect Scope. The owned backend starts one periodic sweep
in that scope (every 60 seconds by default); HTTP and worker bindings add no timers.
Set `maintenance: false` when an external owner schedules cleanup, then call the
service's `maintenance` effect from that lifecycle/alarm. The Alchemy DO constructor
does this automatically through its alarm and composed `collectGarbage` operation.
`makeStorageBackend` schedules that composed operation, including orphan attachment
cleanup with the normal grace period; it does not start a second journal timer.
Pending outbox work is not expired by result cleanup.

Idempotency is finite when result retention is finite. Reusing an operation ID after
its result has expired may execute it again. Advertising/versioning a remote retry
window is deferred; `supportsIdempotency` does not promise eternal receipt retention.

Intermediate replicas additionally track client sessions for ordered submissions,
acknowledgments and delivered state. This is not owned-backend action bookkeeping.
Acknowledgment removes submission fingerprints; expiry removes session/delivery
records, not accepted unresolved actions. Replica clientSessions limits are configurable admission bounds,
not a limit on stateless readers. SharedWorker hosts use a shorter ten-minute lease.

Journal expiry raises HistoryExpired. A replica rebuilds retained/active demand from
coordinated snapshots, atomically installs base/cursor, preserves its local outbox
and replays optimistic work. Expired parent sessions establish a new identity while
preserving queued work; an unresolved accepted result becomes blocked with an unknown outcome rather than
being submitted again silently.
