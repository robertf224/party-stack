# Replica scheduling and recovery audit

Source audit, 2026-11-09, with verified fixes called out below. This inventories
the implementation without introducing a new scheduler. Source line numbers are
a review snapshot and will move. Test runs and timing measurements are stated
where available; an unmeasured timer is not evidence of load latency.

## Findings to act on

### 1. Fixed: selected delivery stopped permanently after authentication expired

`deliveryRecovery` maps an ordinary non-retryable `Unauthenticated` error to
`stop` ([recovery.ts](../../packages/ontology-replica/src/recovery.ts#L7)).
`connectReplicaDelivery` then returns from its background fiber
([parent.ts:175](../../packages/ontology-replica/src/parent.ts#L175)). Later
credential activation clears `replicationError` and wakes state/outbox queues,
but does not restart that fiber
([engine.ts:5125](../../packages/ontology-replica/src/engine.ts#L5125)).

This was a concrete control-flow gap, independent of local cached-query latency.
The watch supervisor already handles the same condition by awaiting a newer
credential activation, without polling
([watch.ts:65](../../packages/ontology-replica/src/watch.ts#L65)). The pre-fix audit found no equivalent
selected-delivery authentication-reactivation regression.

Selected delivery now receives the existing authentication generation/activation
capability. It records the generation before acquisition, reports a rejected
credential, and waits for a newer activation before reopening. There is no timer
while signed out and no device-network gate added to local worker transport.
Tests cover acquisition and stream failures, activation before or after the
failure is observed, cleanup while signed out, and terminal schema/source errors.
The replica suite passes 296 tests. The trace labels this wait `authentication`;
the existing failed-demand/outbox error visibility is preserved.

### 2. Some reconnection waits are still blind timers

- `superviseWatch` checks `canRun` every **1 second** while offline or inactive
  ([watch.ts:18](../../packages/ontology-replica/src/watch.ts#L18)). The engine
  already subscribes to connectivity and authentication changes, but those
  notifications do not wake this sleep. This introduces up to one second before
  the watch is acquired after connectivity returns. Finite reads and the outbox
  have separate wake paths, so this is not a universal one-second delay.
- Selected delivery retries after a fixed **1 second**
  ([parent.ts:72](../../packages/ontology-replica/src/parent.ts#L72),
  [parent.ts:177](../../packages/ontology-replica/src/parent.ts#L177)). It does not
  honor `error.retryAfterMs`, and selection/connectivity/authentication events do
  not interrupt that sleep. Unlike watch retry, it has no exponential backoff.
- The legacy snapshot-parent refresh loop sleeps for its retry interval before
  reoffering its queue ([parent.ts:345](../../packages/ontology-replica/src/parent.ts#L345));
  an event arriving during that sleep is queued but cannot expedite recovery.

**Recommendation, medium priority:** replace the offline availability check with
a subscribe-before-check event wait. Race recoverable connection delays with
appropriate recovery signals, while preserving a provider's explicit Retry-After
deadline. Separate a local backoff from a mandatory provider deadline; waking on
an event must not accidentally bypass rate limiting. Add TestClock tests for
online recovery and selected-delivery Retry-After. Do not remove retries: EOF,
lost transport, and unavailable servers may provide no later event.

### 3. Simplify misleading fallback code; do not infer a hidden five-second loop

In demand acquisition, `configuredInterval` already ends in `?? false`, so the
later `configuredInterval ?? options.pollIntervalMs ?? 5_000` fallback was
unreachable for a valid typed value and has been removed
([engine.ts:3363](../../packages/ontology-replica/src/engine.ts#L3363)). Polling is
opt-in or adapter-recommended. The separate state scheduler's default `5000`
also does **not** mean it wakes every five seconds: without explicit polling or
a pending journal retry, it waits on `Queue.take`
([engine.ts:5014](../../packages/ontology-replica/src/engine.ts#L5014)).

**Remaining recommendation, low priority:** name the state scheduler's recovery
interval separately from explicit data polling.
This is clarity work, not an explanation of the measured cold import cost.

## Timer and expiration inventory

| Mechanism                                    | Current value / trigger                                                                                                                                                                                                                                                                                                        | Purpose, event path, and removal risk                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox dispatch retry                        | Initial **1 s**, exponential, capped at **60 s**, default **3 additional attempts**; only after a retryable action failure. [engine.ts:1142](../../packages/ontology-replica/src/engine.ts#L1142)                                                                                                                              | Persisted `nextAttemptAt`; honors Retry-After. The loop races its deadline with `outboxWake`. First dispatch has no retry delay. Removing this can busy-loop or repeat an ambiguous non-idempotent action; unknown outcomes deliberately pause unless safe to retry.                                                                                                                                |
| Journal recovery                             | **5 s minimum**, or longer Retry-After, after a retryable pull failure. [engine.ts:1713](../../packages/ontology-replica/src/engine.ts#L1713)                                                                                                                                                                                  | `syncRetry` is volatile and shared by state/receipt catch-up, preventing independent paths from bypassing the same deadline. State wakes are immediate, but the recorded deadline still fences the request. Keep a fallback when no new watch event arrives; consider making the local backoff configurable rather than deleting it.                                                                |
| Receipt read-back / missing journal evidence | **5 s**, or longer Retry-After; after read-back failure or a committed receipt whose cursor has not yet been observed. [engine.ts:5044](../../packages/ontology-replica/src/engine.ts#L5044)                                                                                                                                   | A successful remote receipt is persisted before read-back, so recovery never resubmits it. Journal ingestion wakes the outbox immediately ([engine.ts:1648](../../packages/ontology-replica/src/engine.ts#L1648)); the timer is the no-event fallback. This can delay confirmation after a genuine failed read. It is not a delay before accepting or initially forwarding an action.               |
| Native watch recovery                        | **1 s** initial, exponential to **30 s**, honors Retry-After. [watch.ts:18](../../packages/ontology-replica/src/watch.ts#L18)                                                                                                                                                                                                  | Each attempt has a new scope. EOF also reconnects. Authentication uses activation events instead of the timer. Removing retry can leave a dead watch forever. Successful values reset backoff; mere successful quiet acquisition does not, so backoff reset semantics merit a separate test.                                                                                                        |
| Watch unavailable-state check                | **1 s** polling `canRun`. [watch.ts:21](../../packages/ontology-replica/src/watch.ts#L21)                                                                                                                                                                                                                                      | Replaceable by connectivity/authentication event wait; see finding 2.                                                                                                                                                                                                                                                                                                                               |
| Selected-delivery recovery                   | **1 s** after transport/repeated history/renewed-session recovery. [parent.ts:151](../../packages/ontology-replica/src/parent.ts#L151)                                                                                                                                                                                         | First lost baseline gets one immediate rebuild; repeated failure backs off. Current sleep ignores Retry-After/events; see finding 2.                                                                                                                                                                                                                                                                |
| Legacy parent heartbeat                      | **60 s**, raced with its change queue. [parent.ts:340](../../packages/ontology-replica/src/parent.ts#L340)                                                                                                                                                                                                                     | Calls `refreshParent`, so this is periodic snapshot/session work, not just a lease write. Used only when the source has no selected-delivery `subscribe`. Could narrow to renewal once session renewal and watch recovery are separately guaranteed. Removing it today can expire a quiet legacy client. Not the normal selected-delivery Notes path.                                               |
| Demand polling                               | Explicit/adapter interval, minimum **100 ms**; absent by default. [engine.ts:3363](../../packages/ontology-replica/src/engine.ts#L3363)                                                                                                                                                                                        | Poll only when there is no native watch or journal. Required for backends that cannot signal changes. Healthy native watches take precedence.                                                                                                                                                                                                                                                       |
| Coverage reuse age                           | **60 s** default; caller/adapter override, including Infinity. [engine.ts:2113](../../packages/ontology-replica/src/engine.ts#L2113)                                                                                                                                                                                           | A proof reuse rule checked during sync, not a periodic timer. Healthy watches/journal maintenance supersede age. Cached availability is separately usable while fresh coverage is being established. Removing age without a feed can claim stale data is current forever.                                                                                                                           |
| Pin retry                                    | **5 s minimum**, or longer Retry-After, only after retryable acquisition/installation failure. [pins.ts:393](../../packages/ontology-replica/src/pins.ts#L393)                                                                                                                                                                 | New intent, visible changes, online transition, and active credentials wake reconciliation; starting refresh cancels the old retry fiber. A pending graph is not failed merely because five seconds elapse. Needed when an external byte/read failure produces no data event. Could share retry policy rather than hard-code five seconds.                                                          |
| Replica maintenance                          | **60 s**, first pass immediate. [engine.ts:5094](../../packages/ontology-replica/src/engine.ts#L5094)                                                                                                                                                                                                                          | Client/result/coverage/delivery garbage collection. Results default **7 days**. Completed results capped at **100/pass**; journal/coverage scans add protected counts to avoid starvation. Time expiration needs a scheduler even without application writes. No measured evidence this pass explains current cold import latency.                                                                  |
| Object cache GC                              | Every **60 s** or cache-pressure event; unused age **24 h**, default **100 candidates**, maximum **10,000**. [engine.ts:568](../../packages/ontology-replica/src/engine.ts#L568), [engine.ts:4830](../../packages/ontology-replica/src/engine.ts#L4830), [engine.ts:5134](../../packages/ontology-replica/src/engine.ts#L5134) | Bounded cleanup with continuation cursor; pressure can ignore age but not active/pending/pinned roots. Keep bounded maintenance. It runs outside the publication gate, with transactional roots protecting correctness.                                                                                                                                                                             |
| Attachment maintenance                       | Default unused age **5 min**; default sweep follows that age, or **60 s** for a budget with infinite age. [service.ts:241](../../packages/ontology-replica/src/service.ts#L241), [manager.ts:118](../../packages/ontology-replica/src/attachments/manager.ts#L118)                                                             | Races byte-cache pressure. Performs one recovery pass, then **does not schedule a loop** if age is Infinity and no budget exists. Thus disabling byte GC does not leave a useless 60 s loop.                                                                                                                                                                                                        |
| Native demand lease TTL                      | **0 ms** default, capacity **1,024**; idle entries evicted before refusing active overload. [demandCache.ts:25](../../packages/ontology-replica/src/demandCache.ts#L25)                                                                                                                                                        | Upstream ownership retention, not another row/result cache. TTL can avoid reacquisition but is not a readiness delay. Preserve capacity bounds; all-active overflow is an explicit retryable RateLimited error.                                                                                                                                                                                     |
| Replica registry idle TTL                    | **60 s**. [registry.ts:187](../../packages/ontology-replica/src/registry.ts#L187)                                                                                                                                                                                                                                              | Keeps an unused acquired owner briefly reusable; closes its scope afterward. Not an artificial wait before serving an active owner.                                                                                                                                                                                                                                                                 |
| Client session expiry                        | Replica `make` default **10 min**; low-level client registry default **7 days**. [make.ts:45](../../packages/ontology-replica/src/make.ts#L45), [clients.ts:71](../../packages/ontology-backend/src/clients.ts#L71)                                                                                                            | Requests renew the lease. Expiry releases client bookkeeping/results, never accepted pending application actions. Defaults differ by layer and should be documented together.                                                                                                                                                                                                                       |
| Delivery heartbeat / retention               | **15 s** heartbeat, **60 s** disconnected retention; active retention is max(retention, ACK timeout + 3 heartbeats), normally **75 s**. [delivery.ts:348](../../packages/ontology-backend/src/delivery.ts#L348)                                                                                                                | Heartbeat is required to keep quiet leases alive. The measured full selected-state recapture on each heartbeat has been replaced by renewal-only work, verified in the idle browser probe; current source has `waitForChange`/`renew` ([delivery.ts:562](../../packages/ontology-backend/src/delivery.ts#L562)). Do not remove renewal itself.                                                      |
| Delivery ACK observation                     | In-process ACK queue, plus durable polling every **250 ms**. [delivery.ts:848](../../packages/ontology-backend/src/delivery.ts#L848)                                                                                                                                                                                           | Another HTTP handler/process can update the durable ACK without access to the producer's heap queue. Required with the present cross-process notification contract. Normal same-manager ACK wakes immediately. Replace only if storage supplies a cross-owner change signal.                                                                                                                        |
| Delivery ACK deadline                        | **30 s**. [delivery.ts:354](../../packages/ontology-backend/src/delivery.ts#L354), [delivery.ts:859](../../packages/ontology-backend/src/delivery.ts#L859)                                                                                                                                                                     | This is a real finite wait converted into delivery expiration, to bound unacknowledged buffers. It must not discard accepted writes. Policy-controlled; too short for a very slow receiver causes resumable reconnect, not a transaction rollback.                                                                                                                                                  |
| Owned/backend maintenance                    | **60 s** default; configurable/disableable. [maintenance.ts:7](../../packages/ontology-backend/src/maintenance.ts#L7)                                                                                                                                                                                                          | Bounded receipt/journal/session/delivery/blob expiration. Storage-backed owned backend disables its inner owner's scheduler and schedules one composed pass ([storage.ts:83](../../packages/ontology-backend/src/storage.ts#L83)); no duplicate inner timer. Empty owned GC probes read-only before taking a write transaction ([owned.ts:632](../../packages/ontology-backend/src/owned.ts#L632)). |

Two adjacent platform/UI timers are distinct from replica scheduling:

- `NavigatorNetworkConnectivity` samples `navigator.onLine` every second only in
  worker environments, because those can expose a changed flag without dispatching
  the native online/offline event. It publishes only an actual transition, not a
  periodic replica refresh. This is a platform fallback to review against real
  browser support; removing it requires another reliable worker connectivity signal.
- The Tracing panel updates its displayed clock every 250 ms for ongoing spans.
  It does not issue a query, status read, or RPC on that interval. The isolated
  idle probe observed no tab RPCs in either its open or closed measurement window.

## Safeguards that should stay

- **Readiness is event-driven, without a hidden five/ten-second budget.**
  `waitForDelivery` and `syncReady` subscribe before checking, then wait for
  installation, watch acquisition, release, or status events
  ([engine.ts:3539](../../packages/ontology-replica/src/engine.ts#L3539)). Pin
  acquisition likewise keeps incomplete coverage pending, rather than persisting
  a timeout failure ([pins.ts:171](../../packages/ontology-replica/src/pins.ts#L171)).
- **One immediate history rebuild, then backoff until genuine progress.**
  The immediate budget is reset only after installation **and both ACKs** succeed.
  Resetting it on installation alone can create an immediate ACK-failure loop.
  This is a bounded recovery rule, not a cache or an ordinary-path delay.
- **Generation, owner, and residency fences prevent stale async writes.** Demand
  identity/revision plus object-type generation fence late snapshots; delivery
  membership/residency checks force a real snapshot after owner loss or GC.
  Removing them resurrects deleted rows or grants completeness over evicted data.
- **Identity repair below a fresh limited window is necessary today.** A cached
  lower-ranked row absent upstream can become visible after a later optimistic
  deletion of a top row. Rank-based repair pruning was rejected for this reason.
  Unchanged repair rows now avoid retention-age writes, without skipping repair.
- **Receipt persistence before read-back is intentional.** Attachment-alias
  application failure falls back to persisting the remote receipt evidence, then
  returns the error; it does not retry the remote action
  ([engine.ts:2030](../../packages/ontology-replica/src/engine.ts#L2030)). Missing or
  explicitly incomplete affected IDs conservatively read back whole object types
  ([engine.ts:1745](../../packages/ontology-replica/src/engine.ts#L1745)). This can be
  expensive, but dropping the fallback loses reconciliation correctness.
- **Pin acquisition's 16-pass cap is an explicit work bound, not a timer.** Each
  pass discovers dependencies, then checks/install them atomically. Concurrent
  graph changes can require another pass ([pins.ts:209](../../packages/ontology-replica/src/pins.ts#L209)).
  Exhaustion becomes a retryable error with the previous installed graph retained.
  No evidence yet that ordinary Notes reaches this cap. Add a cap-exhaustion
  regression/diagnostic before redesigning or deleting it; an unbounded busy graph
  traversal would be worse.
- **Delivery limits bound memory and partial transfers.** Producer defaults are
  10,000 records / 16 MiB, 128 records / 256 KiB per frame, and 32 subscriptions;
  receiver defaults are 20,000 records / 32 MiB. These reject oversized input and
  malformed partial frames rather than silently truncating it. They are not
  performance delays; APIs must expose useful errors when a real selection exceeds
  them.

## Tests supporting the classification

- `scheduling.test.ts:46`: consecutive offline actions forward without waiting for
  row delivery. `:92`, `:189`, `:303`, and `:590`: receipt, journal, and queued
  retries use their deadlines independently of data polling, with Retry-After
  shared rather than bypassed. `:484` and `:534`: new actions and network/auth
  recovery wake queued work without waiting for polling. `:667`: journal watch
  reconnect catches missed changes without a polling heartbeat.
- `watch.test.ts:7`, `:63`, `:97`, `:150`: Retry-After/scope cleanup, terminal
  failure, event-driven authentication reactivation, and EOF reconnect. Missing:
  offline-to-online watch acquisition without clock advance, and long-lived quiet
  watch backoff reset semantics.
- `watchAcquisition.test.ts:85`, `:118`, `:150`, `:182`, `:210`, `:262`: real
  acquisition precedes fresh fetch; no missed buffered mutation; warm/offline
  reads remain usable; release cancels acquisition; failed acquisition allows
  independent finite reads; a quiet acquired watch needs no synthetic first event.
- `parentRecovery.test.ts:40` and `:177`: first HistoryExpired is immediate,
  repeated expiry backs off, a successful ACKed transfer rearms the budget, and
  semantic/delivery ACK failures do not rearm it. Authentication reactivation now has acquisition/stream and activation-race
  coverage. Selected-delivery Retry-After remains untested.
- `pins.test.ts:320` and `:371`: incomplete coverage remains pending beyond five
  seconds and resumes on notification; newer commands are accepted while obsolete
  cleanup is held. `pinReconciliation.test.ts:89`, `:108`, `:136`: queued self-events
  do not repeat graph evaluation; coverage/data changes do; a saved failure does
  retry even with unchanged revision. These support the revision/demand witness,
  not a separate retained graph-result cache.
- `retention.test.ts:257`: bounded automatic GC is scoped and protects demand;
  `scheduling.test.ts:156`: expired results are collected while data/outbox loops
  sleep. `clients.test.ts:94`: session expiry preserves accepted application state.
- `deliveryOwnerLoss.test.ts:36`, `deliveryMembership.test.ts`, and
  `snapshotRepair.test.ts:40`: owner loss preserves accepted actions/watermarks;
  selection changes/GC do not restore stale rows; future optimistic changes still
  require correct identity repair.
- `ontology-backend/src/delivery.test.ts:210`, `:278`, `:319`, `:372`, `:427`:
  renewal-only quiet heartbeats, durable producer fencing, missed-change capture
  after reconnect, client lease renewal, and real ACK expiration. `:560` verifies
  an ACK from a different handler advances the original producer via durable
  state; `:1351`/`:1353` verify owner close wakes quiet/ACK-waiting streams without
  waiting for heartbeat.

The selected-delivery authentication recovery bug is fixed. Event-aware reconnect
scheduling remains a useful follow-up. The remaining fixed values mostly bound
retries, garbage collection, or transport resources. They should not be presented
as the cause of the measured row import cost without a trace placing a wait on
that critical path.
