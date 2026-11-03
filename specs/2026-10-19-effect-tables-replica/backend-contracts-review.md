# Backend contracts and adapters review — November 2, 2026

This review follows Runtime, storage/transactions, and Replica/demand. The latest
Replica checkpoint moved attachments and action admission/default resolution into
the native service, moved authoritative storage composition into ontology-backend,
and removed the server dependency on the application SDK.

## Checklist

- [x] Inventory the common backend contract, optional capabilities and actual callers
- [x] Inventory owned, Foundry, Salesforce and metadata implementations
- [x] Resolve public contract feedback before changing signatures
- [x] Complete action/default/validation/receipt and error-channel audit
- [x] Complete owned transaction, journal, idempotency and retention audit
- [x] Complete provider pushdown, snapshot completeness and cancellation audit
- [x] Complete watch/poll/reconnect/error supervision audit
- [x] Verify bounded state and remove obsolete implementation paths
- [x] Run regression/property tests for findings and workspace CI

The functional review is complete through the checkpoints below. This combines
source review with targeted regressions and independent oracles; it does not claim
every possible provider response or resource interleaving has been proved correct.
The remaining type-precision and provider-capability follow-ups are explicit below.

## Contract inventory

The current source of truth is packages/ontology-backend/src/index.ts:
OntologyBackendService, ObjectSelection, BackendSnapshot, ActionRequest,
ActionReceipt, BackendChangePage, BackendAttachments and BackendEncryptedValues.
The common service is already Effect-native. Closing an acquisition Scope owns
backend resources; returned watchers are Effect Streams.

| Area                     | Current contract                                     | Meaning                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                 | name, sourceId, supportsIdempotency                  | Stable source identity and durable keyed retry guarantee; not authentication or a live connection ID.                                                               |
| Reads                    | loadSubset(ObjectSubset)                             | Return the requested result or explicitly report fulfilledSubset; shared normalization applies residual filtering/windows. Complete applies to the declared region. |
| Demand notifications     | watchSubset(subset)                                  | Optional per-subset invalidation hints. The function itself can return undefined for unsupported types.                                                             |
| Durable changes          | changes.pull, changes.watch                          | Pull committed change pages using opaque cursors; watch only wakes pull.                                                                                            |
| Selected delivery        | subscribeSelection, acknowledgeDelivery              | Optional retained snapshot/patch delivery with explicit ACKs and resume positions.                                                                                  |
| Freshness recommendation | refresh(subset)                                      | Optional polling/coverage-age recommendation. Replica owns its scheduling and caller configuration wins.                                                            |
| Actions                  | resolveActionParameters, validateAction, applyAction | Read-only prefills, preflight certainty/issues, and durable remote execution receipts respectively.                                                                 |
| Query functions          | queryFunction                                        | Named ontology function invocation, not arbitrary Query IR execution. Currently mandatory even for read-only metadata backends that return NotImplemented.          |
| Attachments              | attachments.stage/read/metadata                      | Optional byte capability. Stage is optional within it; read may return Blob or byte streams, with optional range arguments.                                         |
| Encrypted properties     | encrypted.decrypt                                    | Explicit portable plaintext response and optional ciphertext identity evidence; local caching belongs to Replica.                                                   |
| Maintenance              | maintenance                                          | Optional bounded storage cleanup; its enclosing host schedules execution.                                                                                           |

Provider inputs now use spec `ObjectSubset`, including notifications, refresh
recommendations and ordinary committed selected delivery. `ObjectSelection` contains
only these subsets, without speculative action inspection fields. The internal
`CompiledSubset` execution form lives in the subset lowerer, alongside the adapter
from compact storage predicates. Native providers lower supported expressions and
windows once at their boundary. There is no native full-QueryDocument backend hook
today. Server finite queries use the shared executor over subset readers; owned
transactions can add exact grouped-window reads.

## Implementation inventory

| Implementation  | Read pushdown today                                                                                                                                   | Freshness today                                                                    | Writes                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Owned/storage   | Native storage predicates, ordering/windows and optional grouped windows                                                                              | Atomic journal, change hints and retained committed selected delivery              | Transactional mutators, receipts, journal, attachment reference/mapping metadata                       |
| Foundry data    | Supported predicates, including safe broader candidates and primary-key batches; residual checks, ordering and windows run in the shared query engine | Scoped object-set watcher; admin-user type recommends 60-second polling            | Provider edits become affected targets; no keyed-idempotency guarantee                                 |
| Salesforce data | Primary-key equality/IN only; remaining predicates, ordering and windows run after all provider pages                                                 | No CDC hook or recommended polling interval; explicit Replica polling is available | CRUD synthetic targets; incomplete target flag accounts for automation; no keyed-idempotency guarantee |
| Metadata        | Provider-specific name/type candidates followed by local evaluation                                                                                   | Foundry can recommend configured polling; Salesforce has no watch hook             | Typed NotImplemented                                                                                   |

Both data adapters can fetch substantially more rows than the final requested
window. This is a performance finding, not evidence of correct arbitrary native
pagination: residual predicates and ordering must remain semantically correct
before reducing fetched rows. Foundry currently emits SourceQueryPlan diagnostics;
Salesforce does not.

## Confirmed implementation fix

Native Foundry and Salesforce loadSubset now validate query shape/scalars/windows
before any provider IO using the existing storage QuerySchema. A negative limit
previously went through Foundry's generic unavailable classifier; Salesforce could
fetch all matching provider pages and then fail as an Effect defect during local
query evaluation. Both now fail through the typed channel as nonretryable
InvalidRequest. Regression tests assert the Effect failure and zero provider calls;
Foundry's synthetic admin-user branch is covered too.

Targeted package builds/checks/tests passed: Foundry 178 tests and Salesforce 50.

## Approved contract changes

- Provider reads, watches, refresh recommendations and committed selected-delivery
  requests use spec `ObjectSubset`. Physical storage queries remain an internal
  lowering detail; unsupported expressions fail explicitly. Full query-result
  watching is separate future work.
- Ordinary `ActionReceipt` means committed. Intermediate parent acceptance remains
  in the speculative protocol. Async provider jobs need the capability described
  below before they can be introduced. Malformed receipts and mismatched operation
  identities follow normal failed-dispatch bookkeeping with an unknown outcome;
  they cannot strand an entry in `sending` or trigger blind resubmission.
- Removed the unused `OwnedBackendService.protocol` facade, its extra ordered
  submission/result tables and `collectClientGarbage`. Owned authorities retain
  their transactional receipts/journal and committed delivery. Intermediate
  fixtures use an actual Replica; ordinary authority fixtures use the committed
  backend contract. Delivery retention is configured with `delivery`, without an
  unrelated speculative-client policy on owned backend construction.

## Delivery regression and test ownership

Removing action-inspection fields from committed provider selections exposed a
local generation bug. Outbox inspection/admission changed the child's view generation
even when its requested rows stayed the same. The parent correctly replayed its
unacknowledged batch, but the child stamped it with the new local generation and
rejected its changed frame hash. Committed selections now derive their generation
from row demand only; speculative parents still include action interests. Actual
pending-action row dependencies still contribute demanded subsets in both modes.

A regression in ontology-replica replays the same unacknowledged batch after local
outbox admission and inspection, without depending on SQLite or the SDK. Existing
SDK integration checks still cover Promise actions, TanStack wiring, authoring
wrappers and value hydration. Detailed replication/storage behavior belongs in the
owning lower package rather than being tested only through LiveOntology.

## Remaining follow-ups

- Hook-specific ApplyActionError/ValidateActionError/LoadSubsetError aliases remain
  type-level guidance. Actual hooks deliberately retain the common BackendError
  channel, including storage/source incompatibilities; narrowing these signatures
  needs a complete allowable-kind design rather than unchecked casts.
- Salesforce CDC and opaque provider page continuation remain future capabilities.
  Polling is caller-configured today; this checkpoint does not imply a native feed.
- Full query watching/IVM, hard budgets for an individual provider response, and
  more native predicate/window pushdown remain separate performance work. Finite
  source loads can still collect broad candidate sets before residual evaluation.
- Pure-helper boundary cleanup agreed during the storage review remains deferred;
  SDK Promise callbacks stay inside Effect.tryPromise. Native adapter acquisition
  and lower-level codecs/metadata no longer import application SDK contracts.
- Installation/context assumptions discovered during the partition audit are
  recorded in subsystem-audit.md and deferred to the installation review.

## Asynchronous provider operations — future work

Ordinary provider receipts represent committed operations in v0. Intermediate-parent
acceptance remains in the speculative replication protocol and its native wait API.
A future asynchronous-provider capability should return a durable operation handle
and expose status polling, optionally a completion stream. Replica must persist the
handle before polling/watching, retain attachment dependencies, and reconcile a final
receipt or surface a terminal failure without resubmitting the initial request.
Provider operation IDs and caller idempotency IDs remain distinct. Define recovery,
status retention and refresh deadlines before reintroducing an accepted provider result.

## Explicit broader fulfilled subsets

`BackendSnapshot.fulfilledSubset?: ObjectSubset` describes the region fulfilled,
including any already-applied window. Omitted means the exact request, including
pagination. `complete` applies to that region. Raw candidates can require residual
filtering; consumers normalize through the shared query evaluator before exposing
requested results. Never infer completeness from candidate counts or returned IDs.

Replica `cache.objects.storeBroaderSubsets` defaults to false. Opting in stores the
fulfilled region's objects and coverage; otherwise only requested objects and the
normal pagination prefix are installed. Extra objects have ordinary age/budget GC,
not new demand roots. GC invalidates coverage when required objects are removed.
Explicit source windows must contain the requested window with the same predicate,
ordering and cursor; the normalizer subtracts the already-applied offset. Unwindowed
coverage uses structural predicate implication (including conjunction/disjunction and
key equality/IN containment), never data-dependent guesses.

Foundry, Salesforce, users and metadata return candidates plus their fulfilled
region; residual filter/order/window evaluation runs in the shared consumer path.
Finite server queries normalize too. Authorization normalizes upstream candidates
then returns only projected exact results, without forwarding a privileged broader
coverage claim. Direct trusted protocol loads preserve the declaration so each
receiving replica can choose its own cache policy.

A narrow watch cannot keep a broader claim fresh indefinitely. Known invalidations
and watch failures invalidate the type's coverage before demand can reuse it. A
broader claim otherwise ages normally unless maintained by its own live demand or
a committed journal. Watch-scope reporting remains future work: the current hook
must invalidate every change relevant to the requested subset or return undefined
so polling/coverage age can provide refresh. Watching more is safe; watching less is not.

Opaque provider pagination remains scoped to each finite load. A future pager could
reuse provider pages and continuation chains separately from replication cursors.
[TanStack's cursor pager](https://tanstack.com/db/latest/docs/collections/query-collection)
caches whole pages and fetches a missing tail. Any equivalent capability here needs
source/partition/filter/order identity, expiry and bounded storage, and cannot skip
necessary candidates when residual filtering or sorting remains local.

Broader-fulfillment verification: 100 generated filter/order/window comparisons
against an independent full-scan oracle; Replica regressions for default/explicit
opt-in storage, offset prefixes, coverage reuse, GC, and narrow-watch hints/failures;
server finite-query, authorization and RPC round-trip checks. Backend 65 tests,
Replica 186, server 71, Foundry 209, Salesforce 59, devtools 44. Full workspace CI:
133/133 successful. This completes the fulfillment slice, not the remaining owned
journal/lifecycle review above.

## Action/error and finite-load boundary checkpoint — November 2

Implemented and verified before the broader-fulfillment slice:

- Removed the SDK NonRetryableError class and both provider fallback classifiers.
  Unknown action/query names are InvalidRequest; missing Salesforce action metadata
  is InvalidConfiguration. Foundry rejects unknown actions before consuming uploads.
- Malformed Foundry edit/validation responses and Salesforce save/invocable responses
  fail through the typed channel as nonretryable InvalidResponse. A malformed write
  response retains an unknown outcome; preflight failures never imply a committed
  action. Receipt-key codec failures no longer escape as Effect defects.
- Salesforce result-level permission/throttling failures preserve those categories
  instead of becoming validation errors. Custom rejection text lives in categorized
  issues, with provider causes redacted. Successful Flow errors:null is accepted,
  matching the [provider example](https://help.salesforce.com/s/articleView?id=platform.flow_distribute_system_rest.htm&language=en_US&type=5).
- Foundry complete/draft validation requests propagate cancellation to SDK fetch.
  Attachment helpers and both metadata adapters use standard authentication/rate-limit
  classification rather than wrapping every failure as retryable Unavailable.
- Object and user pagination reject malformed pages/identities and repeated tokens.
  The seen-token sets belong only to one finite load. No provider pagination cursor
  is persisted or used as a replication cursor.
- Users and metadata still evaluate the full requested subset before returning.
  User profile-picture bodies now use the ordinary byte-stream path. Salesforce's
  Ontology descriptor is a local singleton rather than a link-type fetch.

Regression evidence: Foundry 208 tests; Salesforce 59 tests; full workspace CI
133/133 successful, including Worker bundle verification. These are targeted
boundary checks; the unchecked journal, lifecycle and contract items above remain.

## Owned execution, retention and acquisition checkpoint — November 2

The owned path commits object/reference changes, receipt and journal publication in
one storage transaction. PostgreSQL allocates its sequence under a short publication
lock held through COMMIT; source-scoped cursors do not use sequence allocation alone
as proof of commit order. Existing real-PostgreSQL tests verify overlapping independent
writers, late commits after snapshots, concurrent duplicate submissions, aborted
transactions, lost COMMIT replies, and journal-head preservation after compaction.

Changes and regression evidence in this checkpoint:

- A deterministic asynchronous-read test reproduced parallel patches overwriting
  separate fields of one object inside one transaction. A transaction-local write
  gate now includes the read/modify/write and its journal capture. Separate database
  transactions still use the driver's existing concurrency rules. A 100-case plain-map
  oracle verifies writes, deletes, caught rollback results, coalesced journal replay,
  and installed rows after every generated transaction.
- A separate read-back failure regression reproduced an object committing without
  a journal change when trusted code caught the wrapper's post-write read failure.
  Writes now track touched identities before mutation; publication reads each
  final canonical put once, outside the user callback. A publication read failure
  therefore rolls back the transaction. Repeated puts no longer read back every
  intermediate value.
- Lowering maxCommits no longer scans/deletes an entire old backlog during append.
  Publication and maintenance each reclaim at most 100 journal records per pass;
  maintenance also detects count-based backlog. Cursors below the logical floor
  require snapshots immediately, even while physical cleanup drains the backlog.
- Receipt retention remains independent: seven days by default, configurable to
  Infinity. Only successful commits get receipts; failed mutations roll back. Reuse
  inside the window returns the durable receipt or conflicts on changed input;
  reuse after expiry is a new action, as previously agreed. No new expiry-advertising
  or automatic unknown-outcome protocol was introduced.
- Fixed storage bindings use the declared context partition for receipt scope rather
  than hardcoded context.user. A tenant-only context regression verifies separate
  receipts for the same ID across partitions. Parameter defaults also honor the
  current execution context, falling back to the fixed binding, like action execution.
- Owned unknown action/query names use InvalidRequest; declared capabilities without
  implementations use NotImplemented. Storage composition preserves standard error
  classification instead of collapsing all storage failures to Unavailable. Owned
  private causes are redacted. Missing Foundry media sources are InvalidRequest;
  missing response bodies are nonretryable InvalidResponse.
- OntologyBackendAdapter and its authoring provider type now live in ontology-backend,
  with the SDK reexporting them. Foundry/Salesforce client creation occurs inside
  scoped open and acquisition failures use the typed channel. The provider factory
  itself performs no IO. Lower provider codecs, metadata and validators import spec,
  storage and backend contracts directly. Removed the unused deprecated Foundry
  decoder aliases. Installation behavior is unchanged.

Verification: backend 71 tests (including the new transaction oracle), Foundry 211,
Salesforce 60, and the real PostgreSQL project's nine tests. Full workspace CI: 133/133 successful for the final checkpoint. Existing Replica and server regressions exercise the consuming paths.
Server/protocol is the next subsystem review.
