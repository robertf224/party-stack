# Migration status — October 22, 2026

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
- **Foundry encrypted properties:** CipherText metadata imports as `Encrypted<string>`;
  snapshots/edit loads preserve opaque handles and property sources. The native
  backend exposes explicit, cancellable CipherText property decryption, with typed
  errors and plaintext schema validation. Ordinary loads never decrypt. The unused
  public backend encrypt hook was removed: actions continue to accept plaintext,
  and their authoritative implementation handles encrypted property writes. Local
  encryption remains available internally. This is the adapter boundary, not yet
  the public decrypt/cache API or protocol transport. Foundry decrypt reads the
  property's current value, so later caching must respect that source semantics.
- **Browser credentials:** encrypted OAuth credential persistence with separate
  CryptoKey storage, callback fixes and persisted connection/installation demand.
  This is not yet the final per-purpose persistence-consent API.
- **Inspection:** persisted-only object/outbox views, structured query paths,
  coverage reasons and native pushdown diagnostics, component attribution, scoped
  Effect traces and parent tracing. Five tabs share shadow-root style isolation and
  theme tokens. Demand reference counts track consumer lifetimes; row GC is still
  mark-and-sweep. User-facing devtools refinement is complete for this checkpoint.

## What remains, in recommended order

1. **Auth, connections and installations (next).** Move private records onto their
   own ontology definitions/native storage. Finish explicit per-purpose browser
   credential/key-persistence consent and key-access composition. Preserve working
   OAuth callbacks, token refresh, installation selection and scoped cleanup.
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

Native outbox parity, native backend construction/metadata ports, and the current
blob consolidation/streaming checkpoint are implemented. Attachment follow-ups are
tracked in [blob-future-work.md](./blob-future-work.md).

## Follow-up design

- **Postgres concurrency (deferred):** keep the current Tables-prefix transaction
  advisory lock for correctness. Later evaluate serializable transactions with
  safe whole-transaction retries and real multi-connection tests. Revisit the
  owned backend's shared journal-head row before claiming concurrent action
  throughput. A plain sequence is not a safe publication cursor: allocation
  order can differ from commit order. Keep changes in the SQL driver and journal
  module, rather than adding platform branches throughout the runtime.

- Portable query IR/builder with correlated subqueries, relationship helpers,
  cross-ontology references, security/demand interpretation and deeper limit pushdown.
- Ontology-owned migration history and lens/cast semantics across rows, pending
  invocations, indexes and mirrors; inspectable native SQL column layouts.
- Bigint/long ontology kinds, CloudKit, SSR hydration and measured optimization.
  Existing provider endpoint choices should change in response to benchmarks.
- **Outbox input encryption (deferred by request):** no outbox persistence changes
  in this checkpoint. Revisit local encryption of persisted invocation payloads,
  offline replay/key availability and consent, and all other durable payload copies.
  Distinguish device encryption at rest from action contracts accepting pre-encrypted
  values. A public remote encrypt hook is not required for the first case.

## Verification and practical limits

The October 22 native attachment checkpoint passes full workspace CI. Focused
suites include ontology-storage (33), ontology-backend (17), and real workerd
Durable Object tests (14). The Alchemy client tests cover shared references,
immutable upload IDs, empty uploads, sliced reads, failure rollback and orphan GC.
The shared attachment contract runs against Memory, IndexedDB and SQL and checks
that missing authoritative uploads cannot commit dangling object references.
No Cloudflare resources were provisioned or deployed for these tests.

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

## Native SQLite/DO consolidation and streamed transfers — October 22

Removed `sqlite-ontology` and its attachment coordinator. The shared
`makeStorageOntologyBackend` executes actions/queries over native Tables and
BlobStorage. SQLite supplies inline byte IO; custom byte services remain composable.
Both example apps use this composition. Existing conformance cases moved with the
shared implementation, without production-specific database migrations.

Renamed the Cloudflare package to `durable-object-ontology-storage`. Its SQL bridge
and Alchemy R2 byte adapter serve the same storage composition. `/alchemy` acquires
the owned backend inside an Alchemy DO; the resource example declares the bucket,
DO class, authenticated RPC endpoint, forwarding Worker and GC alarm. There is no
parallel raw-binding R2 coordinator. Actual workerd resets verify interrupted R2
publication and stale reader-root recovery after reopening the same DO.

Attachment helper uploads use scoped response streams plus acknowledged ordered
64 KiB request chunks. Downloads stream metadata and bounded chunks. Cancellation
releases incomplete transfers, and size/sequence validation prevents partial
publication. HTTP and MessagePort round trips are covered. Blob boundaries still
materialize complete content; this is not durable resumability or range caching.
Owned servers can bind helpers directly to their backend. No temporary upload lease
or additional GC mutex was introduced.

Verification: full workspace CI **136/136 tasks**, issue-tracker Chromium acceptance
**4/4 cases**; ontology **75**, RPC server **48**, and local workerd **15** tests pass.
No Cloudflare resources were deployed. Deferred blob features live in
[blob-future-work.md](./blob-future-work.md); auth/connections/installations is next.

## Alchemy resource convenience

`OntologyDurableObject(name, { ir, bucket, authorize, ... })` now declares the owned
DO resource without an application subclass. The factory registers Alchemy's
namespace/export and supplies the same storage, RPC and bounded GC alarm wiring.
Options may be an initialization Effect; custom construction can still use
`makeAlchemyOntology`. The example Worker yields the resource and routes requests
to a named instance. This does not change auth/connection migration scope.

Local workerd coverage exercises the actual Alchemy namespace/export registration,
deferred schema initialization, authenticated HTTP RPC, row persistence across
reconstruction, retained versus orphan attachments, alarm preservation/rescheduling
and disabled GC. The package has 17 local workerd tests; the example is type-checked
and the compiled Worker dependency guard remains enabled. No cloud deployment was
performed for this convenience helper.

## Connect implementation checkpoint (2026-10-22)

The agreed names are Installation (service instance), OAuthConnector (one OAuth
app/flow configuration), OAuthConnection (saved authorization), and scoped live
sessions. Personal and shared connectors can use separate records even when they
share a provider app registration. Applications can extend the standard definitions
with project/org properties and links; no new ontology inheritance or schema lens
mechanism is required.

`@party-stack/connect` now consolidates the former connections and OAuth packages:

- `/spec` exports portable definitions and inferred types. Tokens and timestamp
  expiries remain flat because Foundry struct fields do not support Cipher text.
- The Effect `Connect` service implements PKCE attempts, single-use exchanges,
  durable refresh claims, token rotation, explicit disconnect and bounded indexed
  expiry cleanup. Native ciphertext and metadata commits share a Tables transaction.
- `/server` supplies authenticated begin/callback/result/status handlers. Attempts
  bind to an application session, callback permissions are checked again, return
  URLs stay on the app origin, and the browser receives completion references.
- The browser client supports runtime popup/redirect presentation. The existing
  provider-facing public OAuth facade now uses Connect/native storage rather than
  TanStack OAuth metadata collections or coordinated refresh RPC. Client-credentials
  requests also have Effect scope ownership and cancellation.
- Provider packages, Better Auth integration and issue-tracker import the new
  package. Promise methods remain at existing UI/SDK boundaries.

This is the foundation checkpoint, not completion of the entire auth migration.
The native authority store is implemented; a Foundry-hosted Connect record store
still needs trusted actions/Cipher writes for atomic claims and commits. Independent
SDK reads/writes cannot implement the transaction contract. Connection-manager
status projections, scoped installation acquisition/consolidation, the Better Auth
server storage adapter, and the public decrypt/cache API remain. The existing
browser credential persistence consent continues through the configured runtime
key service; general encrypted-value caching will start with an opt-in boolean,
without cache timestamps/TTL. Outbox input encryption remains explicitly deferred.

See [the Connect package](../../packages/connect/README.md) for concrete setup,
extension and hosting examples.
