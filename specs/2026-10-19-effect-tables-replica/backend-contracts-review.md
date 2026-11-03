# Backend contracts and adapters review — November 2, 2026

This review follows Runtime, storage/transactions, and Replica/demand. The latest
Replica checkpoint moved attachments and action admission/default resolution into
the native service, moved authoritative storage composition into ontology-backend,
and removed the server dependency on the application SDK.

## Checklist

- [x] Inventory the common backend contract, optional capabilities and actual callers
- [x] Inventory owned, Foundry, Salesforce and metadata implementations
- [ ] Resolve public contract feedback before changing signatures
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
OntologyBackendService, BackendSubset, BackendSnapshot, ActionRequest,
ActionReceipt, BackendChangePage, BackendAttachments and BackendEncryptedValues.
The common service is already Effect-native. Closing an acquisition Scope owns
backend resources; returned watchers are Effect Streams.

| Area                     | Current contract                                     | Meaning                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                 | name, sourceId, supportsIdempotency                  | Stable source identity and durable keyed retry guarantee; not authentication or a live connection ID.                                                      |
| Reads                    | loadSubset(BackendSubset)                            | Return rows exactly matching the requested filter/order/window. Complete means the requested window is complete, not the entire type.                      |
| Demand notifications     | watchSubset(subset)                                  | Optional per-subset invalidation hints. The function itself can return undefined for unsupported types.                                                    |
| Durable changes          | changes.pull, changes.watch                          | Pull committed change pages using opaque cursors; watch only wakes pull.                                                                                   |
| Selected delivery        | subscribeSelection, acknowledgeDelivery              | Optional retained snapshot/patch delivery with explicit ACKs and resume positions.                                                                         |
| Freshness recommendation | refresh(subset)                                      | Optional polling/coverage-age recommendation. Replica owns its scheduling and caller configuration wins.                                                   |
| Actions                  | resolveActionParameters, validateAction, applyAction | Read-only prefills, preflight certainty/issues, and durable remote execution receipts respectively.                                                        |
| Query functions          | queryFunction                                        | Named ontology function invocation, not arbitrary Query IR execution. Currently mandatory even for read-only metadata backends that return NotImplemented. |
| Attachments              | attachments.stage/read/metadata                      | Optional byte capability. Stage is optional within it; read may return Blob or byte streams, with optional range arguments.                                |
| Encrypted properties     | encrypted.decrypt                                    | Explicit portable plaintext response and optional ciphertext identity evidence; local caching belongs to Replica.                                          |
| Maintenance              | maintenance                                          | Optional bounded storage cleanup; its enclosing host schedules execution.                                                                                  |

BackendSubset currently contains objectType plus ontology-storage's compact Query.
It is not the spec ObjectSubset accepted by public replica demand. The backend
subset helpers lower supported logical expressions and windows to this execution
form. There is no optional native full-QueryDocument backend hook today. Server
finite queries use the shared executor over subset readers; owned transactions can
add exact grouped-window reads.

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

## Open contract feedback

1. **Subset representation.** Keep the compact execution request at the adapter
   boundary, or move public adapter inputs to spec ObjectSubset and lower supported
   forms in native provider implementations? This is independent of adding full
   query-result watching or provider QueryDocument execution. Unsupported plans
   must remain explicit rather than silently widening the requested result.
2. **Accepted provider receipts.** ActionReceipt.outcome currently permits both
   committed and accepted. Repository providers only emit committed. An accepted
   receipt with a matching future journal cursor can settle, but there is no
   general asynchronous-provider completion/status hook; an accepted receipt with
   no confirmation path stays pending. Parent acceptance already has its own
   speculative protocol. Decide whether to narrow ordinary receipts for v0 or
   explicitly model asynchronous provider operations.
3. **Owned speculative facade.** OwnedBackendService.protocol and
   collectClientGarbage expose ordered client-submission bookkeeping in addition
   to the ordinary committed backend/delivery path. No non-test repository caller
   uses .protocol. Removing this public facade and porting authority fixtures to
   ordinary committed delivery would simplify the distinction between authority
   and intermediate Replica servers. Independent snapshot/reference oracles
   should remain tests rather than production compatibility paths.

## Implementation cleanup candidates

- Native adapters still import SDK acquisition types and NonRetryableError.
  Their public native service is Effectful, but internal provider callbacks and
  the adapter/provider factory layer still use Promises. Move reusable acquisition
  contracts below ontology and keep SDK conveniences as wrappers; remove the old
  error class rather than adding another compatibility bridge.
- Hook-specific ApplyActionError/ValidateActionError/LoadSubsetError aliases exist,
  but OntologyBackendService still declares broad BackendError everywhere. Decide
  the intended allowable failures, then wire the narrower types to actual hooks.
- The committed selected-delivery hook currently takes StateSelection, including
  action-inspection fields that belong to speculative state. Audit and narrow the
  ordinary row-selection contract while reviewing the owned speculative facade.
- Unknown action names, missing provider metadata, provider validation failures,
  malformed provider responses and unsupported operations need distinct errors;
  NonRetryableError currently collapses some of these cases into ValidationFailed.
- Salesforce's comment refers to polling repair, but the adapter supplies neither
  a CDC watch nor a recommended polling interval. Do not describe it as automatic.
- Finish source-identity, malformed-row and exact completeness checks across data
  and metadata bindings before claiming this subsystem review complete.
