# Migration status — October 21, 2026

Current inventory. The [execution log](./implementation.md) records historical
checkpoints; this file describes the current implementation. The overall
migration remains incomplete. The native execution/construction checkpoint is
covered in [native-actions.md](./native-actions.md).

## Implemented foundations

- **Definitions:** ontology-spec owns portable definitions, values, lenses,
  inference and codegen. Optional generated Effect codecs/types and runtime
  IR-derived schemas coexist with non-Effect consumers. Internal runtime APIs
  use ordinary package exports; spec/codegen retains opt-in `/effect` exports.
- **Storage:** ontology-aware transactions, subset predicates, indexes, memory,
  IndexedDB user-space planning, SQLite/PostgreSQL database planning. SQL still
  uses a shared-row/JSON layout, not a native column per application property.
- **Owned execution:** atomic actions/receipts/journal, invocation identity and
  source-coordinated snapshots. SQLite and Durable Object paths use this backend.
  Authoritative attachments support inline SQL bytes and external byte stores.
- **Replica:** confirmed base, optimistic overlay, ordered durable outbox,
  persisted-only transactional replay and explicit uncertain outcomes. Successful
  receipts survive local mapping/read-back failure and restart without resubmission.
  Confirmed row publication and optimistic settlement are atomic.
- **Native action policy:** persisted retry deadlines/budgets, pause/discard-all,
  manual retry/reconciliation, and cancellable accepted/confirmed waits. Discard-all
  abandons local intent even for an unknown remote outcome, then refreshes base;
  it cannot undo a possibly committed remote write. Portable now/UUID inputs are
  frozen across rebase/forwarding. Arbitrary ambient effects in custom mutators
  are not automatically deterministic.
- **One execution path:** LiveOntology always composes Replica. Removed the second
  outbox executor, `makeAdapterBackend`, `backendAdapterFromEffect`, and collection-
  oriented backend methods. Bindings acquire a native service through scoped
  `open(context)`. Foundry and Salesforce metadata/query/attachment paths use native
  SDK snapshots/services rather than private runtime collections. Some standalone
  provider collection helper exports remain; runtime construction does not use them.
- **Collection integration:** scoped DbClient, demand-driven TanStack subsets,
  join/include forwarding, and persisted-only inspection. No explicit preloads or
  TanStack persistence coordinator. Initial demand attempts sync before its view
  is ready; offline replay still makes no network queries.
- **Retention:** precise subset/action dependencies and bounded automatic row GC
  using mark-and-sweep. Blob metadata, aliases, generation intents and reader/outbox
  roots compose transactionally through ontology-storage. Byte IO uses recovery
  and generation fencing rather than pretending external IO shares a SQL transaction.
- **Effect lifetimes:** removed Effection. Watcher, coordination, connectivity,
  refresh and maintenance use scopes/fibers. WebRuntime has a lazy Layer; its async
  facade builds the same acquired service. Failed acquisition and closure are tested.
- **Browser placement:** persisted SharedWorker owner, memory tab Replicas, Effect
  RPC transport and helper operations. Parent state/overlay/outbox handoff is atomic;
  scoped connections forward local work and recover lost replies. Selected snapshots,
  view-generation fencing, normalized imported tables, client sessions and bounded
  admission details are implemented. Unsupported worker startup has an in-process
  fallback protected by Web Locks. See [replica-state.md](./replica-state.md).
- **Providers:** Foundry snapshots/actions, shared scoped watcher, receipt-directed
  search reads, native Admin Users queries and metadata snapshots. Salesforce native
  snapshots/actions/query functions and synthetic CRUD receipts. Known identities
  are preserved without claiming all automation effects are known.
- **Browser credentials:** encrypted OAuth credential persistence with separate
  CryptoKey storage, callback fixes and persisted connection/installation demand.
  This is not yet the final per-purpose persistence-consent API.
- **Inspection:** persisted-only object/outbox views, structured query paths,
  coverage reasons and native pushdown diagnostics, component attribution, scoped
  Effect traces and parent tracing. Five tabs share shadow-root style isolation and
  theme tokens. Demand reference counts track consumer lifetimes; row GC is still
  mark-and-sweep. User-facing devtools refinement is complete for this checkpoint.

## What remains, in recommended order

1. **Remaining blob integration and private records.** Native object/outbox references,
   identity/alias GC, scoped reads and transactional receipt mappings are implemented;
   the standalone blobs package and metadata collection are removed. Next port the
   authoritative SQLite/R2 coordinator and streamed helper transfers onto this core.
   Public offline byte policy waits for offline query demand. Move connection and
   installation records to their own ontology definitions and finish explicit
   per-purpose browser key consent. See [attachments-gc.md](./attachments-gc.md).
2. **Platform ownership.** Finish scoped Node/Expo construction and credential/key
   composition. Private connection/installation services still use coordinated
   per-context ownership. SharedWorker application data ownership is already live;
   remaining coordinated services prevent deleting coordination wholesale.
3. **Protocol hardening.** Retained delta history, source/session reset recovery
   preserving local work, scoped returned-state authorization, completed receipt /
   journal-history compaction, and protocol-child row/blob retention. Current
   selected snapshots replace atomically; they are not a retained delta stream.
   Protocol children require `gc:false` and no blob service. The issue-tracker
   placement is a trusted same-origin use, not a generic untrusted deployment.
4. **Provider synchronization.** Foundry durable edits-history catch-up with honest
   cursor guarantees, Salesforce CDC health/reconnect support, deeper predicate
   pushdown and narrower receipt read-back. Foundry watch invalidations currently
   repair with snapshots; Salesforce uses polling. Neither is a completed durable
   streaming synchronization port.
5. **Recovery presentation and acceptance.** Engine retry/reconcile/wait APIs now
   exist; application UX for uncertain/blocked work and independently verified
   provider receipts remains. Verify cold offline app-shell reload, broader browser /
   private-mode coverage and multi-client reset recovery. Continue focused subsystem
   review in chat.

The first two tasks at the previous checkpoint—native outbox parity and native
backend construction/metadata ports—are implemented. The remaining list above
includes work deliberately left outside that checkpoint.

## Follow-up design

- Portable query IR/builder with correlated subqueries, relationship helpers,
  cross-ontology references, security/demand interpretation and deeper limit pushdown.
- Ontology-owned migration history and lens/cast semantics across rows, pending
  invocations, indexes and mirrors; inspectable native SQL column layouts.
- Bigint/long ontology kinds, CloudKit, SSR hydration and measured optimization.
  Existing provider endpoint choices should change in response to benchmarks.

## Verification and practical limits

Current targeted suites pass: Replica 67 tests, ontology 59, Foundry 212,
Salesforce 58, SQLite 15, ontology-server 42, and devtools 41. Full workspace CI
passed **141/141 tasks**. Chromium acceptance passed **4/4 cases** after updating
the example profile-seed invocation namespace for the native action contract.
That example change does not add a library migration or reset stored rows.

Regression coverage includes persisted retry deadlines and budget resets,
pre-submission versus ambiguous failures, discard-all with uncertain outcomes,
receipt reconciliation, interrupted waits, receipt-local mapping failure/restart,
seeded expression replay, native metadata filtering, native backend acquisition
and confirmation without optimistic action execution.

Demand-scoped polling is separate from watch/journal maintenance. Foundry Users
polls every 60 seconds; other unwatched subsets default to the Replica sync interval
(5 seconds). Backends can return `false` to disable automatic snapshot refresh;
Foundry metadata preserves its explicit/no-auto-refresh policy. Virtual-clock tests
verify intervals, cleanup and that disabled polling does not claim an active watcher.

Coverage reuse distinguishes a complete collection, a complete query and a present
primary key. A positive key hit does not require complete collection coverage;
absence requires a complete proof. Inspection does not itself acquire remote demand.

Browser acceptance covers offline edits, shared pending inspection,
initiating-tab closure, reconnect and persisted reload using SharedWorker/IndexedDB
with tab memory replicas; a worker-disabled case covers in-process fallback.
Component-attribution cases cover query replacement, portals, pooled collections,
highlight stacking and interruption status. These do not establish cold offline
app-shell navigation or production-safe untrusted remote access.

Historical full workspace checkpoint on October 20: 141/141 tasks passed. This is
not evidence that subsequent edits passed; the final checkpoint below supersedes it.

## Attachment storage checkpoint — October 22

Removed the legacy blobs package and unused TanStack metadata collection. Object
and Replica row writes maintain schema-derived attachment reverse references in
transaction, independently from outbox/reader byte pins. Indexed GC now removes
unreferenced metadata and staged uploads after the configurable orphan grace
(default one hour), while replica byte eviction preserves referenced identities.
Authoritative bindings only collect unreferenced orphans. Receipt mappings commit
with acknowledgement; a local binding conflict preserves the receipt for recovery
without redispatch. Scoped reads protect file-backed content through consumption.
Drafts remain ordinary application object types; no draft-specific API was added.

Verification: full workspace CI **138/138 tasks**, issue-tracker Chromium
acceptance **4/4 cases**. There are three fewer tasks because the standalone blobs
package was removed. Storage has 32 tests, Replica 69 and ontology 61. Shared blob
conformance now checks schema-derived draft references and transaction rollback on
Memory, SQL and IndexedDB drivers. Streaming helper transfers and authoritative
SQLite/R2 consolidation are still pending; this checkpoint does not claim those
ports are complete.
