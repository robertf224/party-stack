# Migration status — October 29, 2026

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
  persisted-only transactional replay and explicit unknown outcomes. Successful
  receipts survive local mapping/read-back failure and restart without resubmission.
  Confirmed row publication and optimistic settlement are atomic.
  State refresh and outbox processing have separate scoped workers; subset readiness
  never submits actions. Per-demand terminal load failures are isolated, and watches
  have shared retry supervision and visible failure diagnostics.
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
  SDK snapshots/services rather than private runtime collections. Standalone
  Foundry/Salesforce object, metadata, and user collection helpers are removed.
  The Foundry watcher callback facade is isolated behind its explicit `/callback`
  export; native backend execution uses the scoped Effect watcher.
- **Collection integration:** ontology/tanstack owns local/replicated collection
  options, demand translation and diagnostics, above the platform Runtime.
  Connect has no TanStack dependency: session status uses direct table transactions
  with read-only snapshots and per-user monitors. Its credential definitions still
  use the small Connect ontology. Runtime
  no longer depends on Replica or TanStack DB. Scoped DbClient, demand-driven TanStack subsets,
  join/include forwarding, and persisted-only inspection. No explicit preloads or
  TanStack persistence coordinator. Initial demand attempts sync before its view
  is ready; offline replay still makes no network queries.
- **Demand retention:** replica-level `demand.idleMs` and `maxSubsets` control shared
  active/idle leases, with idle LRU eviction at capacity. Cached proxies use the
  same policy. Row/blob GC runs independently; hard byte budgets remain future work.
- **Retention:** precise subset/action dependencies and bounded automatic row GC
  using mark-and-sweep. Blob metadata, aliases, generation intents and reader/outbox
  roots compose transactionally through ontology-storage. Byte IO uses recovery
  and generation fencing rather than pretending external IO shares a SQL transaction.
- **Effect lifetimes/platform ownership:** removed Effection and the coordination
  package. Web, Node and Expo runtime constructors are scoped Effects and Layers;
  there are no runtime Promise factories or manual runtime cleanup facades.
  Native installation opens acquire the same runtime service directly. Scope closure
  interrupts work and releases SQLite/IndexedDB, connectivity subscriptions and channels.
  Persistent replica hosts use a lifetime Web Lock; RPC remains the standard ontology
  protocol. Local private projections use storage invalidations, and transactional
  Connect claims protect token rotation. SDK sessions/sockets remain context-local
  resources and reconcile external sign-in/logout. Native keyrings compose OS
  keychain/SecureStore with device encryption; Expo uses its native AES-GCM API.
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
  encryption remains available internally. LiveOntology and both transports now
  expose explicit decrypt/cache operations. Foundry temporarily assumes the property
  has not changed while decrypting, pending its API echoing ciphertext in the response.
  Native ciphertext is embedded in rows, with no UUID mapping/import API. Device
  copies live privately on replica rows and follow row GC. Owned storage accepts a
  deployment keyring; the Alchemy DO resource provisions a stable Secrets Store key.
- **Browser credentials:** encrypted OAuth credential persistence with separate
  CryptoKey storage, callback fixes and persisted connection/installation demand.
  Key persistence requires explicit developer opt-in; individual property decrypts
  independently opt into a device-encrypted cache. The API documents same-origin
  access, key loss and offline revocation limits.
- **Inspection:** persisted-only object/outbox views, structured query paths,
  coverage reasons and native pushdown diagnostics, component attribution, scoped
  Effect traces and parent tracing. Five tabs share shadow-root style isolation and
  theme tokens. Demand reference counts track consumer lifetimes; row GC is still
  mark-and-sweep. User-facing devtools refinement is complete for this checkpoint.

## What remains, in recommended order

The incremental delivery checkpoint is implemented; see
[incremental-delivery.md](./incremental-delivery.md) for its state, limits,
transaction boundaries and testing. Browser composition, shared incoming row
installation, child GC/local bytes, native committed delivery and the speculative
server extension are in place. Public website docs describe implemented setup and
behavior; proposals remain in `specs/`.

Hierarchical Query IR/context binding and stateless server authorization are now
implemented in this checkpoint. The remaining v0 gates are downstream Gateway/form
integration in the Streamline repository and final application acceptance. The
legacy HTTP endpoints/clients/error envelopes are removed now, before downstream
adoption, as agreed for this alpha release. Server IVM/live full-query watching,
durable delta history/resume, general untrusted replica-state projection and
advertised/versioned idempotency windows remain future work. See
[Gateway gates](./gateway-v0-parity.md).

The [Query IR proposal](./query-ir-proposal.md) now grounds that final phase in
Streamline admin/token scopes, authorized views, property checks, oracle tests
and composable UI fragments. Delivery resume is recorded separately in
[incremental-delivery.md](./incremental-delivery.md#future-work-resume-after-a-transport-interruption);
persisted client sessions do not yet make delivery subscriptions resumable.

Native server delivery is now explicitly selectable with deliveryStrategy:
auto (default), snapshot or incremental. Both committed and speculative clients
follow the advertised strategy. Snapshot mode keeps invalidation/finite reads and
does not silently use journal delivery. HTTP acceptance covers both strategies
for owned, cached-proxy and replica servers; native server behavior has HTTP acceptance coverage.
Result-maintenance/IVM strategy remains future work. Context type/partition metadata,
entity-selection validation, policy read graphs and action check/bind/read rules are
implemented. Native Describe returns the projected schema and shared context;
clients can acquire those dynamically. Typed policy and public-schema failures stop
construction. Incompatible optional client computations are omitted with warnings.

The policy planner is checked against private eager and independent domain oracles.
Native tests cover masked reads, cache-hit isolation between principals, shared-backend
context isolation, server-bound token parameters, schema drift and transaction-scoped
checks. Generated update execution uses explicit field patches so masked reads cannot
erase hidden stored properties. Policies do not expose raw journals or speculative
state to untrusted clients; scoped incremental authorization remains future work.

1. **Protocol hardening.** Native delivery starts with a selected snapshot and then
   sends atomic incremental patches. Reconnect snapshots preserve local pending
   work. Comparison/staging state and admission history are bounded. Every child
   uses local BlobStorage and ordinary row GC. General scoped returned-state
   authorization and durable delta history are separate follow-ups. The
   issue-tracker SharedWorker remains a trusted same-origin deployment.
2. **Provider synchronization.** Foundry durable edits-history catch-up with honest
   cursor guarantees, Salesforce CDC health/reconnect support, deeper predicate
   pushdown and narrower receipt read-back. Foundry watch invalidations currently
   repair with snapshots; Salesforce uses polling. Neither is a completed durable
   streaming synchronization port.
3. **Remaining Connect authority integration.** Better Auth's lensed native storage
   adapter, scoped local Connect lifecycle, browser key opt-in and public decrypt/cache
   API are implemented. A Foundry-hosted Connect authority still needs trusted actions /
   Cipher writes for atomic refresh claims and credential commits. General native
   mutator auto-encryption, generated write types and outbox-parameter protection are
   separate follow-ups.
4. **Recovery presentation and acceptance.** Devtools renders structured blocked-action
   errors and explicit unknown-outcome retry/discard acknowledgment. Issue-tracker uses
   discard-all, closes its form optimistically and toasts asynchronous failures. Corrected input is
   a new action. Terminal failures use bounded result delivery, not pending outbox
   entries. Independently verified provider receipts remain. Verify cold offline app-shell reload, broader browser /
   private-mode coverage and multi-client reset recovery. Continue focused subsystem
   review in chat.
5. **Gateway transport parity.** The sample remote-notes uses native RPC. Streamline's
   existing finite form workflow still needs adoption of native schema/context discovery
   and hierarchical authorization. Those capabilities are now available on the native
   path; the downstream port remains separate. Deprecated request/response helpers
   are removed in this alpha checkpoint. See
   [gateway-v0-parity.md](./gateway-v0-parity.md) for the inspected workflow and
   deferred untrusted/persistent child replica work.
   Native action-parameter resolution is implemented through HTTP and LiveOntology,
   with authorized row/property reads and fixed-parameter projection for prefills.

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

## Scoped connection/installation checkpoint (2026-10-22)

The generic connection manager and installation lifecycle are now native Effects,
not acquireRelease wrappers around their old async implementations. SDK-specific
authentication clients remain generic (`signIn.oauth`, Better Auth `signIn.email`,
etc.). Native adapter/session/controller contracts use Effects and a typed
`ConnectionError`. Foundry, Salesforce and Better Auth implement those contracts.

`makeConnectionManager` and `makeOntologyBackendInstallation` acquire resources in
Scope; `Connections.layer` and `OntologyInstallation.layer` expose Context services.
The existing create functions are thin UI Promise bridges that own those scopes.
There are no parallel `/effect` entry points. Route configuration, runtime factories,
egress and remote placement retain their framework/SDK callback boundaries.

Installation resources use Effect ScopedCache for concurrent acquisition, retryable
failed opens and per-entry cleanup. Each installation's Scope owns all open entries;
explicit close still releases a cached entry. Per-user serialization orders open,
close, disconnect and forget without blocking unrelated users. Runtime closure
interrupts refresh, restoration and child operations. Failed or interrupted session
handoff releases unadopted resources; stale refreshes and stale egress authentication
errors cannot overwrite a newer login. Cleanup attempts all session/adapter resources
even if an earlier finalizer fails. No logout or durable deletion occurs during
ordinary Scope closure.

This does not centralize private services across tabs or remove the remaining
coordination host boundary. It also does not add the Better Auth server storage
adapter, a Foundry-hosted Connect authority, or the public decrypt/cache API. Those
remain explicit items above. Outbox input encryption remains deferred.

Provider logout runs outside the local state lock because an SDK may await its
own session-change callback. User commands serialize separately; callbacks and
refreshes can make guarded state transitions without reentrancy deadlocks. The
connection lifecycle suite includes that callback sequence as a regression test.

## Better Auth storage checkpoint (2026-10-23)

Better Auth can retain its authentication/API implementation while a scoped custom
adapter stores application-authored ontology objects. Its logical user/session/
account/verification models are views through existing move/select lenses; Better
Auth's schema is checked as an expected view, not imposed as the application's IR.
The adapter rewrites field predicates, ordering and indexes, converts Date/Temporal
at the SDK boundary, and merges writes without dropping hidden application fields.

Owned backends expose `storage.read` and `storage.transaction` for trusted library
integrations. Application-authored operations should normally remain actions.
This capability is useful for an existing library that requires database access;
it need not imply that imports, webhooks, or scheduled jobs should bypass actions.
It is not part of the general backend protocol or exported over RPC. The same
mutation recording and journal append implementation serves actions and these
transactions; rows, attachment retention and journal entries commit atomically.

Issue-tracker now stores auth users as its canonical User objects in the same
SQLite namespace as issues/projects and private auth records. User search can see
all registered profiles. The per-request current-user copy and hidden seed action
are removed. A schema-driven public backend view projects both snapshots and
journal changes, excludes private types and rejects private top-level query fields.
The shared native namespace is freshly seeded; legacy Better Auth SQL tables and
previous demo issue namespaces are not imported. General row permissions remain
future work. See [Better Auth setup](../../packages/better-auth/README.md).

Better Auth's own migration runner is explicitly invoked tooling for Kysely/raw
SQL databases, not required by custom adapter initialization. Migrations remain
separate future work; no compatibility migration or namespace guard bypass was
introduced. Its Effect HTTP integration uses the ordinary handler, while Alchemy
can supply our factory as a custom Database runtime without migration capability.
Neither requires replacing the auth client interface or upgrading to beta.

Installations still own provider-specific ontology resolution: Foundry can select
multiple ontology IDs while a Salesforce instance typically exposes one schema.
"Binding" describes the existing ontology route mapping well, but renaming it is
not necessary for this checkpoint. Schema changes should eventually preserve a
stable live handle while fencing writes, migrating persisted/optimistic/outbox
state and rebuilding affected views. An observable openOntology by itself does
not implement that lifecycle.

Future directions discussed here:

- Explicit action results/receipt payloads, potentially containing returned rows
  or previous values of deleted rows. Keep their meaning distinct from replica
  change batches; define result schemas, visibility, retry consistency and retention.
- A PostgreSQL backend adapter over an existing database: subset reads against
  native tables, application actions mapped to SQL functions/application handlers,
  and logical decoding as the change source. It can observe independent writers
  such as Better Auth using its ordinary SQL adapter. This is distinct from
  sql-ontology-storage owning the database layout. Snapshot/cursor coordination,
  action-to-transaction correlation, slot retention and recovery still need design.
- SQLite session changesets or trigger-backed capture could supply another change
  source; WAL pages alone are not a portable row-level replication API. Keep the
  protocol about committed object changes, not tied to one journal table layout.
- Continue using existing auth libraries rather than rebuilding password/session/
  OAuth behavior as ontology actions in this migration. Domain actions such as
  inviting a user can be added deliberately later.

Public decrypt/cache APIs, Foundry-hosted Connect authority, broader coordination
cleanup and ontology migration execution remain outstanding. Outbox input
encryption remains deferred.

## October 23 checkpoint: embedded encryption and scoped decryption

`Encrypted<T>` carries `{ciphertext, source?}` and a type-only `encryptedValueType` symbol.
Native envelopes contain their encrypted data directly; there is no UUID mapping
or ciphertext import/eviction service. Nested encrypted wrappers (including named
references and containers) fail definition validation/schema compilation.

LiveOntology exposes `decrypt(value, {cache?, signal?})`. Default cache:false
bypasses downloaded copies. Opt-in caching re-encrypts remote plaintext with the
device key and embeds it privately on the existing replica row's property. Cache
metadata is omitted from application rows and replication. A transactional current-
ciphertext check prevents late responses from caching against changed/deleted rows.
Unchanged refreshes preserve it; replacement and row GC remove it automatically.
The original server ciphertext remains available for copying and change detection.
There is no public evictDecrypted API or separate decrypted-value table.

Backend decryption optionally echoes the ciphertext it decrypted. Contradictions
fail; unbound results are not cached. Foundry temporarily echoes the requested
ciphertext under the explicit assumption that its current-property decrypt did not
race a remote change. Its adapter contains a TODO for Foundry to return the actual
ciphertext alongside plaintext. This is an accepted limitation until that API exists.

Both policy HTTP and Effect RPC route explicit decryption. HTTP requires canDecrypt
in addition to row/property visibility. HTTP RPC cancellation reaches the owner's
scoped operation. Memory tabs forward cache policy to their persistent owner.
WebRuntime.persistEncryptionKeys documents persistence/same-origin/key-loss limits.
Expo has no global biometric runtime option; background credentials use SecureStore
without an additional prompt. Session/per-use policies and a general Expo keyring
remain [future work](./sensitive-access.md). Its /plugin entry composes SDK native
configuration and SecureStore backup rules without adding Face ID permission.
Node SecretStore now delegates to the standalone @party-stack/effect-node-keyring
service, using required async native bindings and persistent Linux Secret Service.
There is no cross-keychain/CLI/file fallback. Connect's platform-secret fallback
still uses platform credential references.

The Alchemy DO factory generates one stable 256-bit key through Alchemy Random,
provisions a Cloudflare Secrets Store secret scoped by stack/stage/resource, and
imports it as a non-extractable AES-GCM key. An explicit encryptionKeyring overrides
this default. encryptionKeys accepts pre-provisioned, versioned Alchemy secrets,
selecting an active key while retaining old readers. Provisioning/rollout and
journaled row re-encryption remain explicit application operations; there is no
automatic rotation/migration or key retirement.

Foundry v2 staged-write wrappers convert plaintext strings to {plaintext} and copied
portable Foundry encrypted values to {ciphertext}, preserving OSDK instances without
decrypting. General native mutator auto-encryption/write types and outbox-parameter
encryption remain separate follow-ups. See packages/ontology/encrypted-values.md.

## Recovery/server checkpoint — October 26

Shared normalized BackendError and Unauthenticated now live in ontology-backend;
the errors package and generic HTTP retry wrapper are removed. Providers classify
rejections, authentication, throttling and unknown execution outcomes. Validation
hooks are Effects, preserving full/draft reports and uncertain preflight results.
Public errors project exposed parameter paths and standard input/reference issues;
authored submission messages require explicit disclosure. Projection is safe to
compose repeatedly, and raw causes never reach RPC or replicated action failures.

One scoped makeOntologyServer supports owned, proxy and replica roles. A proxy can
share cached subset demand without a downstream session registry or its own outbox.
Forwarded receipts invalidate affected coverage; incomplete targets invalidate broadly.
Read-only access comes from authorization, without a writes flag. The stateless
projection composes row/property/action/context restrictions before pagination.
Row-filtered projections use snapshots until before/after visibility is supported;
other projections can expose a filtered authoritative journal. Full replica-state
inspection remains privileged.

Issue-tracker's SQLite client now uses native Effect RPC for snapshots, incremental
journal pulls, validation, actions and streamed attachment helpers. Its endpoint
accepts Effect's trailing-slash HTTP URLs, keeps its logical source identity stable,
and binds authenticated context per request. It no longer executes the older policy
HTTP server. Browser acceptance passes offline edits, shared-worker handoff and
reconnect, single-process fallback, navigation and demand attribution (4/4 cases).
Provider live-service acceptance is still required separately.

History gaps rebuild retained rows/demand from coordinated snapshots without losing
the outbox. Expired sessions renew identity and submission counters while keeping
snapshot generations monotonic. Missing accepted results become uncertain, and a
rejected retry cannot erase an earlier lost reply. Incompatible source/schema errors
remain explicit; a source reset is not disguised as an expired read-history cursor.

Completed results default to seven days from completion; journal age/count and idle
sessions have separate settings. Infinity is an explicit retention choice. A finite
result window gives finite idempotency, documented on the backend contract. Cleanup
uses indexed batches, acknowledgments remove submission fingerprints, and idle
sessions release delivery records without deleting pending accepted actions. Protected
old coverage/receipts cannot starve cleanup of unrelated expired metadata. Writes
also advance owned cleanup, independently of idle server maintenance.

State intentionally grows with authoritative rows, unresolved outboxes, explicit pins,
active consumer demand, or configured infinite histories. Finite bookkeeping scales
with traffic inside its retention window, rather than with all lifetime operations.
Client/session and cached-subset admission bounds are configurable; stateless readers
do not allocate a replication session. Transfer buffers and trace stores remain bounded.

ConnectionMonitor exposes a scoped Effect stream; its authentication reporting is an
Effect. Connect redacts decrypted credentials until SDK boundaries. The unused adapter
live flag is removed; Foundry retains explicit watch configuration. Platform runtime
resources remain scoped, with UI Promise facades only at application/SDK boundaries.

Validation: full workspace CI 130/130 tasks, including real workerd tests and Worker
bundle verification; browser acceptance 4/4. No Cloudflare deployment was performed.
Remaining follow-up includes UI recovery controls for uncertain actions, live-provider
acceptance, protocol-child GC/blobs, and UI consumer unmount ordering during pagehide
(TanStack currently logs dependent-query disposal warnings there). General query
watching/IVM, schema migrations and idempotency-window negotiation stay deferred.

## October 27 native API cleanup and remaining v0 order

Native adapters acquire all capabilities through scoped open(context); parallel
adapter-level validation, Promise attachment hooks and cleanup callbacks are removed.
The execution hook/RPC is applyAction/ApplyAction with ActionRequest. A caller's
idempotencyKey supplies the stable request id and receipt.operationId. Optional
providerOperationId is upstream metadata, not retry identity. actionOutcome retains
not-committed/unknown evidence independently of outbox status and Uncertain validation.

Attachment preparation collects only locally staged bytes and leaves existing
remote handles alone. Provider execution handles ordinary/media uploads and returns
ID mappings with its receipt; native staging supports explicit eager uploads.
Metadata selections (including image dimensions) pass through the native service.

Finish byte-stream uploads/storage IO, bounded transfer authorization/limits and example/provider lifecycle/recovery
acceptance before the last v0 phase: Gateway parity including hierarchical Query IR,
context binding, relational read/reference policy execution, dynamic projected
schema/context Describe, and actual form/prefill/attachment/action flows. Do not add
an exists-first public policy language. The deprecated HTTP transport is removed
before the downstream port for this alpha release. See gateway-v0-parity.md for the checklist.

subscribeSubset is deferred. Keep cursor as the continuation term; own snapshots and
journal positions provide the future feed's foundation, but query membership,
join/window dependencies, result removals and authorized reset handling are still
required. See subset-subscriptions.md. Full server IVM, untrusted replica-state
projection, persistent protocol-child GC/blobs, ranges and durable upload resumability
are not silently included in this cleanup.

## October 27 streaming and lifecycle checkpoint

Native byte IO now supports lazy streams, measured unknown lengths, exact declared
lengths and bounded buffers. OPFS/Node/Expo write incrementally; SQLite uses bounded
chunks and completion markers; R2 streams known lengths directly and uses multipart
parts for unknown lengths. Platform cancellation settles before abandoned-generation
cleanup. Native Foundry attachment/media requests bypass Blob-only SDK upload helpers
while retaining the configured authenticated fetch. Owned action fingerprints use
incremental SHA-256 and reopen durable sources rather than consume one-shot inputs twice.

HTTP actions with new bytes use one streamed multipart request, without proxy staging
or an upload registry. Standalone HTTP creation uses a binary body. Both share the
RPC binding's configured HttpClient/server handler and native execution/error policy.
MessagePort retains bounded connection/owner-bound chunk transfers. Authorization
runs at opening/completion; owner checks are cheap per chunk. Transfer limits and
idle/lifetime deadlines are explicit. Full/range/resumable query/upload semantics
remain separate; see blob-future-work.md. Legacy HTTP stays only until final Gateway
parity, then should be deleted.

Existing recovery/retention suites cover history gaps, expired parent sessions, lost
receipts/replies, mapping races and bounded terminal results. OPFS streaming/recovery
browser tests pass. The new issue-tracker reload check exposed browser hook queries
outliving their source collections: providing DbClient alone does not register those
queries for cleanup in the pinned release. No dependency patch is retained; the
warning is deferred by agreement until a functional problem is observed, potentially
revisiting ownership with Relay-style fragment hooks. It is tracked
by a focused expected-failure browser regression, independently of functional recovery.
No private SSR flag or timed disposal workaround is installed.

Additional browser acceptance verifies image upload through the SharedWorker/native
HTTP/SQLite composition, confirmed action settlement, tab reload and reading the image
while offline. A separate cold-start probe confirms the example has no service-worker
app-shell cache: a full offline page reload fails with ERR_INTERNET_DISCONNECTED.
Persisted data/bytes and offline replay work once the app is loaded; this does not
claim cold offline startup. App-shell caching is an application delivery concern,
separate from the storage/Replica migration.

Verification with unpatched dependencies: full workspace CI 130/130 tasks;
issue-tracker browser acceptance six functional cases passed plus the one explicitly
expected cleanup-warning failure; web-runtime browser acceptance nine cases passed.
Foundry upload tests include a real loopback HTTP socket receiving bytes before an
unknown-length producer completes, plus structured/non-JSON error classification.
These HTTP boundary tests do not claim live-provider media upload acceptance.

## October 27: base and connection-state simplification

Protocol children now use the ordinary bounded row collector. Confirmed parent
rows and sparse inherited overrides are the logical base, composed directly at
read time. The duplicate parent-visible table is gone. Own actions remain in one
outbox through parent inclusion; a private inclusion flag prevents repeat replay
and preserves their dependency roots until the final outcome. Same-revision refill
is fenced by a bounded digest/residency record. Query windows, explicit pins,
inherited creations/tombstones and accepted-action dependencies have regressions.
Independent child BlobStorage/staged-byte handoff is now implemented as described
below. See [the current GC rules](./protocol-gc-examples.md).

Connect's session-state TanStack collection is removed. Its direct table writes
retain cross-context refresh/logout coordination; local snapshots and monitors
serve consumers without a DB collection. The TanStack adapter and its tests now
live at `ontology/tanstack`, and the standalone ontology-tanstack package is removed.

## October 27: native child attachments and server roles

Connected clients use the normal replica host and local BlobStorage. Memory tabs
stage/cache in memory; persistent children use their own platform byte service.
Parent access is an ordinary remote provider. Cold reads deliver bytes while both
parent and child fill their caches, with bounded queues and scoped cancellation.
Metadata-only requests retain selected-field provider pushdown and do not read
bytes when the provider supplies those fields. Byte reads use their own stream header.

Speculative submissions transfer missing staged copies before first acceptance.
The parent checks required bytes and installs outbox roots in one transaction.
Accepted duplicates recover without requiring a second transfer. Child receipts
are saved before alias reconciliation; restart can finish a failed mapping even
after the parent's result detail expires. Each child's byte GC is independent.

Only intermediate replica servers expose speculative state. Owned, proxy and
cached-proxy connections use the ordinary committed adapter facet; no child session
is opened for finite calls. Intermediate servers also expose committed upstream
rows/journal through that facet; predictions use the speculative extension.
Describe advertises a definition digest, not private schema contents.

The [subsystem review](./architecture-simplification-review.md) records simplifications
and remaining candidates. Incremental selected-state deltas are still unimplemented.

## October 28 error audit

The [error taxonomy audit](./error-taxonomy.md) separates action validation from
invalid requests, malformed upstream responses and configuration failures.
Replication-specific control errors select explicit stream/session/snapshot
recovery; source/schema mismatches and invalid data stop automatic delivery.
Fatal delivery diagnostics are observable in Replica status. Typed-channel,
RPC preservation and pending-action retention tests cover those distinctions.

## October 28 checkpoint verification

Full workspace CI passes all 133 tasks. The backend, replica, server and ontology
suites pass 35, 106, 80 and 119 tests respectively. Fast-check runs 60 committed
selection traces and 40 speculative traces against independent snapshot oracles.
Web-runtime browser acceptance passes all nine cases; issue-tracker passes six
functional cases plus the existing expected cleanup-warning failure. Browser
acceptance includes offline cross-tab actions, initiating-tab closure, reload,
native attachment caching, rejected-action toasts and devtools query/tracing views.
The deferred TanStack cleanup warning and missing cold-offline app shell remain
as recorded above. No dependency patch or automatic schema reset is added.

The issue-tracker example uses an explicit `query-ir-v0` replica-cache epoch after
the IR/context contract change. Installation credentials retain their namespace; old
replica stores are left untouched. The one-off link-metadata migration is removed.
General schema mismatches still require a deliberate migration or namespace reset.

## Subsystem review

The [2026-10-28 audit](./subsystem-audit.md) records authorization planning, error
channels/recovery, abort propagation, pre-TanStack handle sources, DbClient/SSR
readiness, state bounds, and remaining Effect/maintenance gaps. It distinguishes
verified behavior and fixes from follow-up work; SSR and hard cache byte budgets
are not claimed complete.
