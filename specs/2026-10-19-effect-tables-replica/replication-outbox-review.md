# Replication and outbox review — 2026-10-30

Working review record. Checked inventory items below do not claim that all state
transitions or failure schedules have been verified. This review follows the
runtime and storage/transaction reviews.

## Checklist

- [x] Inventory public API, construction and actual consumers
- [x] Inventory row layers and persisted bookkeeping
- [x] Remove parent-control bridge sync and verify ordinary delivery
- [x] Wire finite server queries and batch simple child correlations
- [x] Add exact SQL grouped windows and authorization/reference/domain oracle tests
- [ ] Trace enqueue, optimistic replay and action dependencies
- [ ] Trace dispatch, durable receipts, read-back and reconciliation
- [ ] Check speculative-parent acceptance versus upstream confirmation
- [ ] Check sync/demand/watch lifetimes, cancellation and publication gates
- [ ] Check lost replies, restart, reconnect and expired-history recovery
- [ ] Check row/blob GC, result/session/delivery expiry and capacity bounds
- [ ] Implement persistent multi-root hierarchical offline query demand (explicit v0 scope)
- [ ] Audit errors, diagnostics and actionable recovery controls
- [ ] Run targeted regressions/property tests for findings and required checks

## 1. Public interface and responsibility

`makeReplica` acquires a scoped engine. Both construction paths receive the same
ontology IR, Tables service, optional local blob storage and local replay
implementation. Exactly one upstream is supplied:

- `backend: OntologyBackendService`: committed provider/owned-backend reads,
  action application, optional journals and selected delivery.
- `source: OntologySource`: a speculative server's selected base/override/action
  state, ordered client submissions and acceptance bookkeeping.

The returned `ReplicaService` is shared by both paths. Application-facing groups:

| Group              | Current API                                                                      | Meaning                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Local reads        | `get`, `loadSubset`, `confirmed`, `observeRows`, `snapshotSubset`                | Read installed rows; do not acquire remote demand merely by reading. `confirmed` excludes both inherited and own predictions. |
| Interest/retention | `demand`, `retainLocal`, `retainActions`, `pin`                                  | Scoped upstream interest, local reader retention, privileged action inspection and explicit durable row pins.                 |
| Actions            | `enqueue`, `actionStatus`, `awaitAction`, `edit`, `retry`, `remove`, `reconcile` | Persist intent and predictions, observe acceptance/confirmation, or explicitly recover failed work.                           |
| Sync/maintenance   | `syncSubset`, `invalidate`, `syncOnce`, `collectGarbage`, `ensureIndex`          | Explicit refresh/maintenance. `syncSubset` never dispatches actions; `syncOnce` explicitly includes outbox work.              |
| Diagnostics        | `status`, `statuses`, `changes`                                                  | Read-only status and change observation.                                                                                      |

The same interface also exposes server/client session and delivery machinery:
`openClient`, `acceptClient`, `submitClient`, `subscribeClient`, acknowledgments,
selected snapshots, delivery reception and parent connection operations. Those
are infrastructure capabilities, not ordinary application operations.

Actual consumers:

- `ontology/runtime/host.ts` constructs the engine and supplies persisted-only
  mutator execution, attachment preparation and connectivity.
- `ontology/runtime/view.ts` creates the TanStack collections and maps action
  submission/waits into the public UI API.
- `ontology/tanstack` observes installed rows and acquires scoped demand.
- `ontology-server` composes cached proxies and speculative replica servers.
- `ontology-replica/parent.ts` connects delivery and exposes a replica as a source.

## 2. Row model and stored state

For each object type, the same Tables store holds:

1. **Base rows**: installed upstream-confirmed data.
2. **Inherited overrides**, speculative sources only: the immediate parent's
   published predictions, including deletion markers.
3. **Local overrides**: this replica's computed pending-action predictions.

Visible reads resolve local override, then inherited override, then base.
Confirmed reads use base only. Overrides contain complete replacement rows or a
deletion marker, not field provenance flags. They can be recomputed from actions;
they are persisted together with the state that makes them meaningful.

Concrete example: base `Issue/42.status = "open"`; the worker publishes an
unconfirmed `"in-progress"` override; the tab predicts `"closed"`. The tab's
visible read is `"closed"`, the received baseline is `"in-progress"`, and its
confirmed read remains `"open"`.

Additional tables have distinct responsibilities:

| State                                               | Purpose                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outbox`                                            | Ordered local action intent, replay inputs, dispatch/retry state, durable remote receipt and failure information.                                                         |
| `completed`                                         | Retained success/rejection results after executable intent is removed; default result retention is seven days.                                                            |
| `parent-pending`, `parent-completed`, `parent-head` | Selected parent action state and compact imported revision/definition/digest metadata. No second imported object-row store.                                               |
| `position`, `state-head`                            | Upstream cursor/binding, local sequence, parent session/view position and this replica's published revisions. These counters have different roles.                        |
| `coverage`                                          | Which installed subsets/snapshots can satisfy demand, and associated freshness/reconciliation information. Row presence alone does not establish a complete query result. |
| `roots`, `pins`, `retention`, `sweep`               | Scoped reader/demand retention, explicit row pins, row age and bounded sweep position. Startup clears prior incarnation's volatile roots.                                 |
| `action-rows`, `action-queries`                     | Read/write keys and query dependencies needed to retain data for pending action replay.                                                                                   |
| `journal-receipts`                                  | Bounded observed-commit evidence, including commits observed before their matching local receipt; active outbox dependencies protect relevant hints.                      |
| Client/delivery tables                              | Session admission/idempotency watermarks, selection witnesses, outgoing changes and transactional incoming batches. Detailed bounds/recovery remain review items.         |

Blob metadata/retention uses the supplied local blob service in the same Tables
transaction. Bytes may have their own storage and write/delete-intent lifecycle;
they are not implied to be part of an SQL/IndexedDB metadata commit.

The outbox's private `includedInBase` marker means an action has appeared in the
parent's received state. Its local record remains as handoff/recovery evidence,
but is excluded from local replay and the ordinary pending tail. This prevents
applying a prediction twice. It is not proof of upstream confirmation.

## Initial organization observations

- The logical row model is shared; the speculative path adds inherited overrides
  and acceptance/session state rather than another row-replication database.
- `ReplicaService` combines application, maintenance, parent-connection and server
  delivery capabilities. Its main implementation is nearly 3,900 lines. Review
  transitions before deciding how to extract cohesive internal modules/facets;
  do not create another public engine abstraction merely to reduce file size.
- `acknowledged` is used for receipt-bearing action progress and retained success
  records. It must not be explained as synonymous with parent acceptance. Review
  that distinction explicitly in the next state-transition pass.
- Tables/storage now support full finite query documents, while the engine's
  `OwnedReadTransaction` still exposes `loadSubset` as its primitive. Query lowering
  and action execution remain separate review topics; inventorying the primitive
  is not a claim that the full Query IR is absent elsewhere.

No engine behavior changed in this inventory pass. The PostgreSQL fixture
checkpoint preceding it passed workspace CI (133/133) and is saved separately as
`19bb0654`.

## Review discussion: demand, observation and offline queries

Current `observeRows` is a local subset observer: an initial reset followed by row
patches, with local snapshot repair for window changes or missed notifications.
It does not acquire upstream interest or a row-retention lease. `demand` owns that
scoped interest. TanStack currently composes `demand` and `syncSubset` explicitly.
Full QueryDocument execution exists in storage and the finite server Query
operation as well as authorization; it is not yet the replica demand/delivery unit.

API simplification direction under discussion (not implemented):

- Name local subset observation explicitly, and combine demand acquisition with
  coordinated initial readiness so consumers need not remember a second call.
  Offline initialization must still expose persisted data; readiness cannot mean
  an unconditional successful network refresh or complete offline query coverage.
- Group action operations under `outbox`; keep parent/session/delivery plumbing
  in a separate implementation facet. Use cohesive internal modules while
  preserving shared transaction ownership.
- Keep the full state-plus-outbox checkpoint internal. `syncOnce` is currently
  also called by the parent action worker and after parent outbox controls in the
  UI bridge; it is not merely a test/manual helper. Audit these callers before
  removing or renaming it.

The single-row `pin` primitive has no production callers found in packages/apps;
its uses are tests. It does not implement offline hierarchical demand.

Offline query pinning is now an explicit v0 item, rather than an implication of
the existing design notes. Proposed semantics to settle and implement:

- One replaceable, persisted multi-root QueryDocument plus bound inputs per
  replica partition; empty selection removes this offline demand. Validate in
  entity mode so selected data preserves source identity rather than storing
  arbitrary UI projection results as object rows.
- Restore desired demand on reopen. Acquire through normal upstream subsets and
  evaluate with the existing finite query machinery; do not require new full-query
  watching/IVM from providers or the protocol.
- Track graph membership and dependencies, including correlated child regions,
  filters, per-parent windows and parents entering/leaving the result. Merely
  pinning the initially returned keys is insufficient.
- Make desired-query replacement and installed retention-generation changes
  transactional. Define interruption/offline replacement semantics explicitly;
  avoid a release gap or unbounded historical retention generations.
- Expose whether required coverage is acquired versus incomplete/offline. Existing
  cached rows alone cannot establish an offline-complete graph.
- Set an explicit attachment-byte policy (initial candidate: none/all); row and
  attachment metadata retention do not imply that bytes were downloaded. Reuse
  normal blob retention/streaming and bound maintenance work.
- Test replacement/removal, restart, offline recovery, changing relationships,
  filtered/windowed membership, speculative-parent updates and row/blob GC with
  a finite recomputation oracle. Authorization remains enforced upstream.

No public API shape for this extension is committed by this note. Lower-level
adapter/provider acquisition remains subset-based; hierarchical query demand
coordinates those primitives rather than requiring every adapter to execute full
queries.

### Follow-up: unify scoped and persistent demand

Offline query retention should be persistent ownership of the same demand, not
another query language or replication engine. API candidate (not implemented):

```ts
yield * replica.demand.acquire(queryOrSubset); // released with its Effect scope
yield * replica.demand.setPin(queryDocument, { inputs, attachments: "all" });
yield * replica.demand.clearPin();
// setPin replaces the partition's one persisted demand document; clearPin removes it.
```

The persistent owner survives the submitting UI scope/restart and holds the same
membership/dependency/byte roots as equivalent scoped demand. Its desired state
must be saved even when upstream acquisition is offline or fails. Status must
separate saved intent from acquired complete coverage. Replacement/removal needs
the generation/transaction semantics listed above. Attachment selection is a
demand policy; it does not make offline retention a second engine.

Proposed local names are `readSubset` and `observeSubset`, alongside point `get`.
Backend adapter `loadSubset` retains its source-acquisition meaning. The local
observer emits row batches; acquiring demand is a separate ownership operation,
even if an application helper combines the common acquisition/observation path.

`syncSubset` currently returns only `Effect<void, BackendError>` (not rows or a
coverage proof). Folding its initial coordination into demand acquisition can
remove it from ordinary callers; it does not require the offline extension.
Existing offline/publication-gate early returns mean successful completion alone
must not be documented as proof of completeness.

`syncOnce` is not a required semantic coupling of dispatch and replication. Adapter
mode composes recovery/state refresh/outbox processing, while speculative mode
delegates to `syncParent`. Parent connection workers and the public outbox-to-engine
bridge are real current consumers. Refactor those by intent before removing the
combined helper: forwarding/dispatch for action work, state refresh/delivery for
observing parent control changes. Keep receipt reconciliation/publication ordering
without making read acquisition submit actions.

Finite server queries are supported when the Query handler is bound (automatic
for the policy projection, otherwise explicitly supplied). Owned storage uses one
read transaction; adapted upstream reads do not promise a cross-request atomic
provider snapshot. The projected reader rejects incomplete source subsets rather
than silently returning a partial authorized result.

The unused single-row `pin` surface is a candidate for removal when persistent
query demand covers its purpose. A row pin can be expressed as a primary-key
predicate without another public retention concept.

Further clarifications from the review:

- The adapter contract has no native full-QueryDocument execution hook. The
  server's optional `query` handler is an operation binding, not an advertised
  provider capability. Storage's finite executor still handles hierarchy and
  correlations in TypeScript, lowering supported single-source filters/order/
  windows to the storage driver. Full SQL hierarchy compilation remains future
  work; adding a method name alone would not implement native query pushdown.
- Parent retry/edit operations notify the ordinary replication mechanism. A child
  selecting the affected action should receive its changed state through delivery
  (or notification/snapshot fallback), without a UI-triggered combined sync pass.
  Command completion and installed child state are separate asynchronous events;
  any explicit wait should observe state, not dispatch more work.
- A scheduled mobile/background worker is a legitimate consumer of an explicit
  bounded sync pass. Such a helper may coordinate independently owned state and
  outbox workers; it must not make read acquisition responsible for dispatch or
  imply that blocked/offline work can always drain. Specify budget/interruption
  and partial-progress semantics when reviewing lifecycle/recovery.

### Targeted change: outbox controls use ordinary replication

Removed the LiveOntology bridge's explicit `replica.syncOnce` after parent outbox
controls. The parent publishes its normal change notification; selected action
delivery updates the child. Removal still explicitly acknowledges removal of a
locally retained handoff record, which has a different recovery purpose.

The public `outbox.edit` command now resolves `void`, like retry/remove. Previously
it immediately reread the child and could return a stale action record. Callers
observe the outbox collection for installed state; current repo consumers did not
use the returned record. Tests exercise retry/edit/remove with both incremental
delivery and snapshot fallback and prohibit the bridge from invoking `syncOnce`.

The regression exposed an action-state bug: editing a previously rejected action
cleared its known not-committed outcome while retaining the attempt count. A later
remove then incorrectly required unknown-outcome acknowledgment. Editing now
retains not-committed evidence; beginning a new dispatch clears that old evidence,
while preserving any genuinely unresolved unknown outcome. Both adapter and
speculative forwarding claims follow that rule. Focused view regressions pass
(5/5), including automatic propagation in both delivery modes.

### Query batching review

The server Query RPC is always declared. `makeOntologyServer` now automatically
installs finite execution whenever its ontology definition is available. Owned
execution uses one storage read transaction; proxy/cache/replica committed facets
use their final backend reader, rejecting incomplete subsets. Policy-projected
execution stays on the authorized path. Schema-less low-level RPC bindings can
still omit Query. This does not make full query execution an adapter capability.

Implemented batching for simple unwindowed equality correlations: deduplicate
parent values, acquire at most 256 distinct keys per child IN request, then group
candidates and preserve ordinary per-parent filter/order/projection evaluation.
Duplicate keys and empty groups are handled explicitly. State is local to the
finite execution. The reference executor bypasses batching for oracle comparison.
Tests assert 12 child reads become one, 600 distinct keys split into three reads,
and generated results match both reference execution and a domain oracle. The
shared storage contract exercises the path on raw and ontology stores.

Start with provably compatible unwindowed correlations and retain the existing
path otherwise. Per-parent limits/cursors cannot become one global child LIMIT;
fetching every matching child to implement local top-k can also be a regression.
Composite/ancestor-dependent predicates, property authorization and parent-specific
windows need explicit eligibility rules or native partitioned execution. Full
SQL hierarchy compilation and server IVM are separate optimizations.

TanStack comparison: installed `@tanstack/db` uses `subset-demand-controller.ts`
to collect equality keys into IN segments. `compiler/order-by.ts` explicitly
disables global limit-prefix loading for grouped ordering, and applies grouped
top-K locally. That can acquire all matching children for selected parents. Our
initial windowed fallback retains per-parent bounded source reads; native SQL
partitioned windows/lateral execution are future alternatives to the round trips.

Effect audit: non-test sources in ontology-replica and ontology-backend expose no
Promise/async/runPromise APIs. Service commands are Effects and observations are
Streams. LiveOntology converts those at the application boundary; Fetch handlers
return platform-required Promises. Some server attachment/helper adapters still
bridge the application facade back into Effect and are candidates for direct
native-service composition in the organization review, rather than a reason to
introduce duplicate public `/effect` exports.

### Native grouped-window checkpoint

SQL transactional readers now offer an optional exact grouped scan. The finite
executor uses it for simple equality correlations with limits/offsets, grouping
at most 256 distinct parent keys per request. The driver compiles partitioned
ROW_NUMBER only when all filters and ordering have native projections. Missing
indexes, residual predicates, keyset child cursors and parent-dependent extra
filters preserve the previous path. Memory/IndexedDB/provider readers require no
new implementation. This is a physical execution capability, not a new logical
Query IR operator or a new provider/RPC contract.

Owned read transactions carry the capability into trusted policy graph execution.
The masked policy reader deliberately does not forward it: storage's ability to
rank rows does not establish that ranking precedes no outstanding permission
filter. Public queries with arbitrary policies can still use the existing
per-parent fallback. This checkpoint does not compile a caller query and its
complete authorization graph into one SQL statement.

SQLite and PostgreSQL/PGlite property tests compare generated grouped queries with
the reference executor and an independent grouped/sorted/windowed domain oracle.
Generated authorization cases vary project access and child visibility; masked
results are checked with and without grouped execution against the same domain
oracle. Coverage includes ties, undefined rank values, explicit null ordering,
zero limits, offsets, empty groups, native refusal for a missing projection, and
closed transaction handles. A real PostgreSQL test checks partition windows,
and adversarial SQL tests exercise hostile partition/index/table names.

LIKE/ILIKE translation also gained exact static-pattern evaluation over encoded
UTF-16 projections. PostgreSQL uses a generated fixed-code-unit regex; SQLite uses
native LIKE when zero/one percent segment guarantees code-unit alignment. Other
SQLite patterns and dynamic patterns preserve residual execution. Prefix bounds
remain planner hints. A separate property oracle covers Unicode, astral and lone
surrogates, JS lowercase behavior, wildcard/escape punctuation, nonstring values,
negation and pagination. The former `urgent%done` fallback example is now exact
on both engines when its projection exists. Native columns remain future work;
these semantic tests should survive a later physical representation change.

### API review status

The actual ReplicaOptions/ReplicaService definitions remain in
`packages/ontology-replica/src/index.ts`. They have not yet been reorganized into
the proposed outbox/demand facets. `observeRows`/`loadSubset` names still exist;
scoped acquire-with-readiness, setPin/clearPin and persisted hierarchical query
demand remain implementation items. Do not describe the proposed interface as
already final. The action dispatch/reconciliation, lifecycle/recovery and bounded
GC bookkeeping passes in this checklist remain to be reviewed explicitly.

### Constructor follow-up: services, configuration and scheduling

Review direction, not yet implemented:

- Keep network connectivity and provider connection/authentication independently
  observable. Each capability groups its own snapshot and stream. The host
  currently computes online as network AND active provider connection, but merges
  the two raw boolean streams. Derive dispatch eligibility internally from both
  current states; do not publish that derived boolean as network connectivity.
- Express acquired dependencies through Effect requirements/Layers. Prefer the
  Tables, BlobStorage, connectivity, upstream and local action-execution services
  actually needed by the engine; the ontology host can supply them from Runtime
  and its existing connection/mutator configuration. Keep config distinct from
  acquired service values. No second runtime/adapter-provider abstraction.
- `execute` is local transactional replay/default resolution at enqueue and
  rebase, not remote action dispatch. Its implementation currently lives in
  ontology above replica and uses the transaction collection bridge, preventing
  replica from importing it directly. Making the runner internal requires moving
  shared action execution below that dependency boundary. Renaming the callback or
  wrapping it in a service alone does not remove the architectural split. Apps
  should configure their custom mutators, not supply the replay algorithm.
- Preserve application write admission/visibility defaults: direct versus outbox,
  and confirmed versus optimistic. Both action call modes await confirmation by
  default. Use outbox.retryPolicy for grouped retry bounds/delay; keep terminal
  failureStrategy and completed result retention distinct from retry scheduling.
- Group completed action result retention under outbox/action configuration.
  Pending/blocked intent does not expire under that retention window.
- Current `startSync:false` disables top-level state/outbox workers, parent
  connection startup and automatic row GC. Per-demand watches are acquired
  independently. Replace that ambiguous switch with explicit continuous/manual
  lifecycle semantics; define scheduled sync passes separately from read readiness.
- The global five-second `pollIntervalMs` currently controls source fallback
  polling, main-loop wakeups and some retry delays. Adapters already expose
  per-subset polling configuration. Put source refresh choices with the source;
  use explicit retry/maintenance deadlines for engine work rather than a shared
  provider-poll knob. Journal catch-up/repair scheduling still needs a deliberate
  policy, even when watch hints exist.
- `onReceipt` runs local post-receipt work only after receipt persistence and is
  retried without redispatch. `publish` runs an external effect after normal local
  notification. Current repo uses are test instrumentation/failure injection,
  not production composition. Remove public hooks after migrating those tests to
  appropriate storage failures and ordinary observations, preserving the durability
  and no-transient-double-application assertions they currently exercise.

Remaining passes mean invariant/transaction/lifetime audits of implemented code,
targeted oracle/failure tests and fixes for findings, plus the explicitly pending
API/Effect composition changes and persisted hierarchical demand feature. They
are not a claim that those remaining features have already been implemented.

### Naming and platform-bundle follow-up

Implemented in the initial naming pass:

- `demand.idleRetentionMs` replaces `idleMs`.
- `objectCacheGc` replaces the replica's ambiguous `gc` option. Its policy uses
  `sweepIntervalMs`, `minUnusedAgeMs` and `maxCandidates`. Explicit
  `collectGarbage` sweeps use the same age/candidate names. The candidate bound
  includes protected rows examined, not only rows deleted. Blob GC is unchanged.
- Client policy fields are `sessionIdleTimeoutMs`, `maxSessions` and
  `maxUnacknowledgedActions`. The last bounds accepted submissions not yet
  acknowledged by that child, not all pending actions in a replica. Session expiry
  renews on validated activity and never discards accepted pending actions.

Still proposed: platform Layers should supply the individual capabilities together,
like Effect's NodeServices bundle. Narrow engine requirements do not require apps
to assemble a platform capability by capability. BlobStorage construction stays in
the ontology/storage composition; the platform supplies raw bytes and Tables.

Prefer `syncMode: "automatic" | "manual"` when replacing startSync, with explicitly
defined behavior for demand watches and maintenance. Group session configuration
under clientSessions when reorganizing construction. Distinguish committed versus
speculative upstream state from adapter versus protocol transport; a cached proxy
can publish committed state without itself being the authority.

A local finite query API should use the shared Query IR executor in one local read
transaction. One-shot remote demand should share hierarchical demand acquisition
with persisted pins. Native provider whole-query pushdown is not an advertised
backend capability today; projected remote results alone cannot establish entity
coverage or replace installing raw rows. A Promise-based custom-mutator authoring
bridge can remain in ontology while shared execution/rebase stays Effect-native
below it. It must not duplicate action execution or own sync lifecycles.

Replica one-shot query APIs are now explicitly deferred; applications can use
TanStack queryOnce in the meantime. The shared finite executor remains available
to storage, authorization and server query handling.

### Separate connectivity and connection checkpoint

Implemented: replica accepts Runtime's existing NetworkConnectivity capability and
the read-only state/changes portion of Connect's ConnectionMonitor. It exposes
both without merging their states. The old online Effect / connectivity Stream
pair is removed. Diagnostics carry networkOnline and the complete connection state
separately, using Connect's shared schema across RPC. Devtools distinguishes
offline, sign-in required and connection failures. Eligibility for adapter IO is
derived from both snapshots internally; events only wake/reinspect those states.
Network reconnect alone no longer clears an authentication failure. Connection
activation clears that failure and wakes processing. A regression test covers both
online/unauthenticated and offline/authenticated, plus action dispatch gating and
auth recovery independently of network events.

Connection reactivation also clears cached Unauthenticated demand-load failures
and resumes watches suspended for authentication. Watch attempts record the
activation generation before opening, so activation racing with an error is not
lost. Initial connection state and network notifications are not new credential
activations. Forbidden and other unrelated terminal failures stay stopped. The
previous watch attempt closes before waiting, and all waits/subscriptions belong
to the existing engine/demand Scope.

Snapshot loads also record the activation generation: an old-credential failure
arriving after reauthentication cannot reinstall a permanent load failure. The
failed call still reports its own error, while ordinary sync can repair using the
new credentials. The regression holds a real load in flight across activation and
verifies the subsequent repair. The automatic object-cache GC scope test now uses
TestClock so zero-age collection cannot run before its retention lease is acquired.

Still outstanding: scoped demand currently takes BackendSubset, whose query is a
physical StorageQuery. The TanStack bridge lowers too early. The public boundary
should use an object-bound spec Subset and perform physical translation below
that boundary; merely renaming BackendSubset would not address the leak.

Cached proxy invalidation marks coverage stale before ordinary sync repairs it;
it does not delete rows or bypass the engine. Forwarded actions are outside the
cache's outbox, and a provider without a journal or with delayed watch hints
otherwise permits coverage reuse before that write becomes visible locally.

The current Alchemy DO resource is an owned server. Its alarm runs owned-backend
maintenance (including retained history/session/results) and blob GC, not replica
object-cache eviction. An intermediate replica DO must additionally schedule its
replica object-cache collector; the current owned resource does not create an
intermediate replica or implicitly wire that alarm for one.
