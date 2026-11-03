# Backend contracts and adapters review — November 2, 2026

This review follows Runtime, storage/transactions, and Replica/demand. The latest
Replica checkpoint moved attachments and action admission/default resolution into
the native service, moved authoritative storage composition into ontology-backend,
and removed the server dependency on the application SDK.

## Checklist

- [x] Inventory the common backend contract, optional capabilities and actual callers
- [x] Inventory owned, Foundry, Salesforce and metadata implementations
- [x] Resolve public contract feedback before changing signatures
- [ ] Complete action/default/validation/receipt and error-channel audit
- [ ] Complete owned transaction, journal, idempotency and retention audit
- [ ] Complete provider pushdown, snapshot completeness and cancellation audit
- [ ] Complete watch/poll/reconnect/error supervision audit
- [ ] Verify bounded state and remove obsolete implementation paths
- [ ] Run regression/property tests for findings and workspace CI

Inventory is complete; the remaining checklist items are not claimed complete by
reading their implementations. Earlier subsystem tests remain useful evidence.

## Contract inventory

The current source of truth is packages/ontology-backend/src/index.ts:
OntologyBackendService, ObjectSelection, BackendSnapshot, ActionRequest,
ActionReceipt, BackendChangePage, BackendAttachments and BackendEncryptedValues.
The common service is already Effect-native. Closing an acquisition Scope owns
backend resources; returned watchers are Effect Streams.

| Area                     | Current contract                                     | Meaning                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                 | name, sourceId, supportsIdempotency                  | Stable source identity and durable keyed retry guarantee; not authentication or a live connection ID.                                                      |
| Reads                    | loadSubset(ObjectSubset)                             | Return rows exactly matching the requested filter/order/window. Complete means the requested window is complete, not the entire type.                      |
| Demand notifications     | watchSubset(subset)                                  | Optional per-subset invalidation hints. The function itself can return undefined for unsupported types.                                                    |
| Durable changes          | changes.pull, changes.watch                          | Pull committed change pages using opaque cursors; watch only wakes pull.                                                                                   |
| Selected delivery        | subscribeSelection, acknowledgeDelivery              | Optional retained snapshot/patch delivery with explicit ACKs and resume positions.                                                                         |
| Freshness recommendation | refresh(subset)                                      | Optional polling/coverage-age recommendation. Replica owns its scheduling and caller configuration wins.                                                   |
| Actions                  | resolveActionParameters, validateAction, applyAction | Read-only prefills, preflight certainty/issues, and durable remote execution receipts respectively.                                                        |
| Query functions          | queryFunction                                        | Named ontology function invocation, not arbitrary Query IR execution. Currently mandatory even for read-only metadata backends that return NotImplemented. |
| Attachments              | attachments.stage/read/metadata                      | Optional byte capability. Stage is optional within it; read may return Blob or byte streams, with optional range arguments.                                |
| Encrypted properties     | encrypted.decrypt                                    | Explicit portable plaintext response and optional ciphertext identity evidence; local caching belongs to Replica.                                          |
| Maintenance              | maintenance                                          | Optional bounded storage cleanup; its enclosing host schedules execution.                                                                                  |

Provider inputs now use spec `ObjectSubset`, including notifications, refresh
recommendations and ordinary committed selected delivery. `ObjectSelection` contains
only these subsets, without speculative action inspection fields. The internal
`CompiledSubset` execution form lives in the subset lowerer, alongside the adapter
from compact storage predicates. Native providers lower supported expressions and
windows once at their boundary. There is no native full-QueryDocument backend hook
today. Server finite queries use the shared executor over subset readers; owned
transactions can add exact grouped-window reads.

## Implementation inventory

| Implementation  | Read pushdown today                                                                                                                       | Freshness today                                                                    | Writes                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Owned/storage   | Native storage predicates, ordering/windows and optional grouped windows                                                                  | Atomic journal, change hints and retained committed selected delivery              | Transactional mutators, receipts, journal, attachment reference/mapping metadata                       |
| Foundry data    | Supported predicates, including safe broader candidates and primary-key batches; residual checks, ordering and windows run in the adapter | Scoped object-set watcher; admin-user type recommends 60-second polling            | Provider edits become affected targets; no keyed-idempotency guarantee                                 |
| Salesforce data | Primary-key equality/IN only; remaining predicates, ordering and windows run after all provider pages                                     | No CDC hook or recommended polling interval; explicit Replica polling is available | CRUD synthetic targets; incomplete target flag accounts for automation; no keyed-idempotency guarantee |
| Metadata        | Provider-specific name/type candidates followed by local evaluation                                                                       | Foundry can recommend configured polling; Salesforce has no watch hook             | Typed NotImplemented                                                                                   |

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

## Implementation cleanup candidates

- Native adapters still import SDK acquisition types and NonRetryableError.
  Their public native service is Effectful, but internal provider callbacks and
  the adapter/provider factory layer still use Promises. Move reusable acquisition
  contracts below ontology and keep SDK conveniences as wrappers; remove the old
  error class rather than adding another compatibility bridge.
- Hook-specific ApplyActionError/ValidateActionError/LoadSubsetError aliases exist,
  but OntologyBackendService still declares broad BackendError everywhere. Decide
  the intended allowable failures, then wire the narrower types to actual hooks.
- Unknown action names, missing provider metadata, provider validation failures,
  malformed provider responses and unsupported operations need distinct errors;
  NonRetryableError currently collapses some of these cases into ValidationFailed.
- Salesforce's comment refers to polling repair, but the adapter supplies neither
  a CDC watch nor a recommended polling interval. Do not describe it as automatic.
- Finish source-identity, malformed-row and exact completeness checks across data
  and metadata bindings before claiming this subsystem review complete.

## Asynchronous provider operations — future work

Ordinary provider receipts represent committed operations in v0. Intermediate-parent
acceptance remains in the speculative replication protocol and its native wait API.
A future asynchronous-provider capability should return a durable operation handle
and expose status polling, optionally a completion stream. Replica must persist the
handle before polling/watching, retain attachment dependencies, and reconcile a final
receipt or surface a terminal failure without resubmitting the initial request.
Provider operation IDs and caller idempotency IDs remain distinct. Define recovery,
status retention and refresh deadlines before reintroducing an accepted provider result.
