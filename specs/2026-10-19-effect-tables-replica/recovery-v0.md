# Recovery and bookkeeping — v0 scope

Agreed October 26. Keep selected snapshots and current subset demand; full query
IR, server IVM, and retained replica-state deltas are not v0 prerequisites.

## Vocabulary and lifetime

- **Connection:** Connect's authenticated installation access, credentials, and
  refresh lifecycle. Make its monitor Effect-native; keep optional UI facades at
  application boundaries.
- **RPC transport:** HTTP or MessagePort. Retry failed operations or streams in the
  existing sync lifecycle. Replace a dead transport without replacing the Replica,
  runtime, collections, or outbox.
- **Client session:** parent-side child identity and submission/acknowledgment
  bookkeeping, independent from a Connect login.
- **Action receipt:** accepted/committed evidence used for action recovery.
- **Change journal:** committed object changes and positions used for base catch-up.

State synchronization and outbox draining may be separate scoped tasks. Coordinate
base publication, confirmation, and rebase transactionally. Preserve existing
ordering while adapted actions are in flight; coalesce invalidations and refresh
afterward rather than persisting an unbounded queue of watch messages. Pausing an
outbox is not by itself a reason to prevent all independent reads indefinitely.

Subscribe to invalidation/watch hints before reading a snapshot. For journal
sources, hints wake cursor-based pull; they are not the journal itself.

## Recovery and errors

Preserve local outbox work and attachment dependencies when rebuilding base from
snapshots. Differentiate expired history, expired client sessions, replaced
connections/views, unavailable accepted results, and incompatible source/schema
from generic transport failure. Preserve typed errors across both server paths.

Connect owns authentication recovery. Use a shared authentication error and
provider-specific error classification. Share retry scheduling and Retry-After
parsing, but do not introduce multiple independently retrying write executors.
Backend implementations in this repository use the native Effect interface.

Existing outbox pause/uncertain behavior concerns possible remote execution after
a crash or lost reply. Saved receipts continue reconciliation without resubmitting.
Explicit retry/discard/reconciliation remains available. Pending work under pause
does not expire merely because it is old.

## Retention

Completed action-result retention should be configurable, initially seven days
for owned backends and intermediate replicas. Change journal retention is separate
and can be shorter: a missed read cursor can recover from a snapshot. Session idle
expiry is separate again; completed-result age is measured from completion, not
from when a potentially long-pending invocation was created.

Bound completed records, journal receipt hints, obsolete query coverage, inactive
session bookkeeping, forwarded recovery records, and attachment transfer buffers.
Authoritative application data, explicit pins, and unresolved outboxes intentionally
scale with retained user data. Enforce optional capacity through admission/backpressure,
not by silently deleting pending work.

## Deferred idempotency-window negotiation

A finite backend idempotency window is an acceptable contract. Reusing an invocation
outside that window may execute again; retaining only IDs forever would still grow
with lifetime operation count and could not reproduce full receipts.

Defer advertising/versioning idempotency windows, server-issued per-request retry
deadlines, and automatic expiry-aware uncertainty classification. Do not add this
protocol negotiation merely to complete v0. Existing supportsIdempotency behavior
must not be silently weakened by a receipt cleanup change; document any finite
contract before changing retention or retry behavior.

## Provider collection API retirement

Remove standalone Foundry/Salesforce object, metadata, and user collection-option
helpers. Keep useful SDK loading/conversion functions behind native backend services.
The watcher callback facade remains available only through its explicit /callback
export and delegates to the same scoped Effect watcher as the native backend.
