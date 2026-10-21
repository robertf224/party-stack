# Effect runtime migration execution

This is the active implementation checklist for the user's request to complete
the owned backend, runtime, Replica, adapter, connection, and installation ports.
The acceptance target is the issue-tracker working online and offline, including
restart and queued optimistic action replay without network-dependent reads.

The user has stepped away and explicitly requested sustained implementation and
edge-case coverage. Continue the complete migration autonomously; do not stop at
the new foundations. Devtools inspection must load persisted data only, never
acquire remote demand. Add named Effect spans around sync, mutation, rebase,
outbox replay/dispatch and lifecycle transitions, with no secret plaintext in
attributes. Verify an accessible trace view as well as the issue-tracker UI.

## Fixed requirements

- Keep ordinary developer-facing TanStack collections and convenient query syntax.
  Effect scopes own collections, fibers, subscriptions, network watchers, and
  installations. Promise facades are permitted at application boundaries.
- Backend adapters expose subset reads, invocations/receipts, and explicit change
  capabilities; they do not own client collections or outbox lifecycle.
- Every mutator/replay read uses persisted local data in its storage transaction.
  It cannot acquire remote demand or trigger a network request. Sync is separate.
- Local-only and replicated collection creators are scoped Effects over one runtime
  and storage. Local collections own data; replicated collections acquire demand.
- GC starts as bounded mark-and-sweep. Roots include active demand, offline pins,
  durable pending actions, uploads, and readers. Preserve authoritative rows and
  sole copies of bytes/ciphertext. Sweep eligibility is rechecked transactionally;
  eviction never emits a remote delete and invalidates relevant query coverage.
- Encrypted<T> is an opaque handle like an attachment. Ciphertext availability,
  the handle, and permission/key capability are separate. Decryption is explicit
  through a service/backend hook; ordinary row/schema/sync paths never decrypt.
- Private local ontology definitions can describe connections and credentials.
  Store encrypted token payloads in tables; key material remains in the platform
  secret/key store. No production database compatibility migration is required.

## Checkpoints

- [x] Runtime codec compilation and default IR-derived storage models (prior turn).
- [x] Add Encrypted TypeDef, core/generated/inferred types, opaque-handle Effect
      codec, and local authenticated-encryption/ciphertext service with external keyring.
      Initial encrypted storage tests pass; expand cross-package coverage before final.
- [x] Define Effect-native ontology-backend protocol, independent of TanStack.
- [x] Initial owned backend core and memory tests: atomic journal, receipts, source cursors,
      snapshots, strict invocation identity, and closed transaction capabilities.
      Extend the contract to SQL/native IndexedDB and attachments as the port proceeds.
- [x] Transaction-scoped TanStack bridge: lazy subset reads, read-your-writes,
      concurrent actions, abort, and publication only after persistence commit.
- [x] Port existing SQLite attachment coordinator into the owned path: inline same-transaction bytes, external staging,
      replacement/orphan recovery, and range-friendly reads.
- [x] Replace SQLite backend internals; its 15 acceptance/conformance tests pass.
- [x] Validate DO native async transactions in workerd: 13 tests pass and the emitted bundle is Worker-safe.
- [ ] Effect-native runtime/storage/bytes/connectivity with scoped application facade.
- [x] Initial Replica base/overlay/outbox/sync, durable offline replay, receipts, source demand,
      restart/reconnect, and bounded GC. Expand retention, lease and cursor edge-case coverage below.
- [x] Scoped localCollectionOptions / replicatedCollectionOptions and collection factories.
      Persisted-only queries have no demand capability. Refine subset/unload retention below.
- [ ] Port remote HTTP, Foundry, Salesforce and meta adapters to the new protocol.
- [x] Port Foundry object-set watcher structured concurrency to Effect; callback and Effection facades delegate to it.
- [ ] Private local connection/credential ontology, encrypted OAuth token persistence,
      scoped connection refresh/egress, and scoped installations.
- [ ] Wire issue-tracker and exercise browser online/offline/reload/reconnect with
      an owned backend fixture; preserve existing consumer API behavior where practical.
- [ ] Complete meaningful package tests, native IndexedDB tests, workspace CI, docs,
      changesets, and final limitations report. Do not claim undeveloped checkpoints.

## Current integration notes

- New packages: ontology-spec, ontology-storage, sql-ontology-storage,
  indexeddb-ontology-storage, ontology-backend, and ontology-replica. SQLite/DO now use
  owned storage; platform runtimes expose scoped Tables alongside legacy compatibility APIs.
- Owned backend core is in ontology-backend/src/owned.ts; SQLite now supplies
  an upload coordinator. Receipt identity includes attachment byte digests and a trusted
  principal scope. Journal source generations survive reopen and change after database reset.
- Core storage and Table transactions share contextual native transaction handles.
  Preserve the complete Effect service context across TanStack Promise callbacks;
  a raw Effect.runPromise can otherwise acquire a different SQL connection.
- The old issue-tracker profiles use Foundry OAuth plus an HTTP remote SQLite
  backend with Better Auth. Its web runtime currently uses old persistence + OPFS.
- Current OAuth delegates individual token/PKCE strings to RuntimeAdapter.secrets,
  with a deliberately unsafe ordinary-persistence fallback in the browser demo.
- Existing SQLite attachments include upload intents and orphan recovery; port
  these rather than replacing them with naive write/delete behavior.
- New EncryptedValues local service uses random 96-bit AES-GCM IVs, 128-bit tags,
  and authenticates namespace/handle/key identity. Keys are supplied as CryptoKeys;
  platform keyring persistence/provisioning remains to be implemented.
- Foundry Cipher docs verify permission-controlled decrypt/update operations.
  Do not invent a universal decrypt endpoint: use explicitly configured provider
  operations and report unsupported capability where unavailable.

## Browser and integration checkpoint

- Shared Replica/runtime/ontology/HTTP/devtools/SQLite test graph passed 42/42 tasks.
- Integrated ontology test queues an offline edit, closes/reopens the runtime,
  restores its projection with zero network reads, then commits on reconnect.
- Issue-tracker production build passed 60/60 tasks. The local development server
  is running at https://wt-e72f24025c.issue-tracker.localhost/ (localhost:3000).
- Browser currently uses the seeded local Grace Hopper SQLite demo account.
  Created a project named "Offline runtime verification". Its row is visible in
  persisted-only devtools; actual Effect spans are visible in the Effect traces tab.
- Found a real browser completion race (receipt and pending row read separately).
  Added atomic actionStatus read; rerun the browser flow after rebuilding.
- Outbox-mode actions now return after durable local enqueue; direct mode waits for
  remote completion. outbox.enqueue exposes a separate completed Promise.
- Expo/Web package tests pass after accounting for the separate owned-storage DB.
  DO workerd initially failed because the sandbox prohibited its localhost listener;
  rerun with an escalated tool call is authorized and pending.

## Required remaining edge cases / integration work

- Runtime Effect services and native platform Tables are implemented, but generic
  createLocalCollection still uses the legacy persistence path. Port its facade,
  blob metadata/bytes, connections, OAuth and installations; keep cleanup versus
  disconnect versus forget distinct.
- The new Replica-backed live path activates for persistObjects + runtime.tables +
  effectBackend. HTTP and SQLite provide effectBackend; Foundry, Salesforce and meta
  still need their Effect ports. The old live path remains for other consumers.
- HTTP currently runs the policy-enforcing snapshot/action transport through an
  Effect protocol. Durable receipts are forwarded, but pull journal transport is
  not wired. Do not expose unfiltered journals through arbitrary row visibility
  policies. Add an explicit authorized change capability and tests.
- Replica sync currently refreshes complete active object-type snapshots. Implement
  translated subset demand, proper unload releases, local reader roots, and avoid
  needless whole-type network polling for journal-capable sources.
- Add snapshot/journal cursor barriers so historical change pages cannot briefly
  regress a newer snapshot; test concurrent snapshot acquisition and pagination.
- Remove/edit/retry currently share the sync gate. Followers can wait indefinitely
  for the leader lease while holding that gate; move local mutations off the sync
  gate and atomically compare/claim an unchanged queued invocation before dispatch.
- Add broader GC tests and progress through pinned oldest candidates (current
  bounded scan can repeatedly encounter only pinned candidates). Pending actions
  conservatively root all types, which is safe but can later be narrowed to read sets.
- Completed receipts are persisted locally. Test resubmitting completed invocation
  IDs, lost receipts, concurrent leaders/followers, and definition/source resets.
- Transaction callback bridge rejects escaped handles and carries full Effect
  context. Extend tests to native IndexedDB and cancel/cleanup races.
- Declarative now()/uuid() inside action bodies are still generated on replay;
  freeze nondeterministic action inputs/defaults before persisting intent.
- Add opaque Encrypted handling to adapter codecs/metadata/UI switches. Platform
  keyring provisioning and encrypted OAuth credential persistence remain outstanding.
- Existing SQLite schema compatibility checks still create now-unused old object
  tables. Remove those, update schema conformance, and keep a clear ownership guard.
- Finish Foundry object-set watcher Effect port, adapter ports, and full issue-tracker
  offline/reload/reconnect verification. No offline app-shell service worker yet.

## Follow-up verification and corrections

- Added explicitly authorized HTTP full-replica snapshots and journal pages. This
  capability is separate from row/property policies, denied by default, and
  rechecked on every request. Temporal values and source-coordinated snapshot
  cursors survive the transport. Revocation, malformed input, and invalid cursor
  responses are covered by tests. The shared issue-tracker workspace opts in.
- Journal-backed full snapshots are reused; unchanged journal polls no longer
  rebase every pending action or reload all active object types.
- Added scoped Foundry watcher implementation, bounded frame queues, shared
  subscriptions, reconnect/heartbeat/ack timeouts, and late-socket cancellation
  fencing. The Effection entry point remains a compatibility facade.
- Added a transitional Effect backend executor using private scoped TanStack
  collections for existing adapters' confirmed read-back. Foundry now exposes the
  native protocol and uses direct cancellable snapshot fetches where possible.
  Salesforce and metadata adapter protocol ports are still outstanding.
- The application local-collection facade uses owned Tables when available.
  Collections remain on demand. Creation does not scan storage. OAuth reads a
  session or pending callback by explicit query; connection/partition restoration
  and blob recovery explicitly query the records they need. Do not restore eager
  collection loading to make imperative `.get()` calls work.
- Confirmed collection writes wait for TanStack's sync acceptance receipt rather
  than visibility, which could otherwise deadlock on the mutation being persisted.
- OAuth regression covers redirect PKCE state across client cleanup/recreation on
  owned Tables. The callback route now defers browser-only initialization until
  its client effect; importing profiles during SSR caused `window is not defined`.
- Action `null` inputs clear optional stored fields; omitted inputs leave them
  unchanged. The stricter row boundary exposed this preexisting interpreter
  mismatch. Regression covers create, set, omitted update, clear, and required
  unknown values containing null. SQLite issue creation succeeded in the browser.
- User wants the tab named **Performance**, focused on sync timing, with a
  playground-style waterfall. Added trace selection, nested bars, zoom, live spans,
  failure highlighting, duration/self-time inspection, bounded retention, and
  clear-generation fencing. Sync attempts and enqueues have distinct root traces.
  Fixed stylesheet source discovery for the extracted component; verify screenshot
  after the app is restarted (the previous dev process crashed on callback SSR).

The full authorized migration remains in progress. Do not treat these checkpoints
as completion of connections/OAuth lifecycle ports, encrypted credentials,
attachment/ciphertext GC integration, native browser/DO coverage, or offline app
shell verification.

## Internal collection ownership and authentication follow-up

- Keep `.objects` public. Each LiveOntology owns an internal TanStack DbClient;
  transaction snapshots and temporary backend executors own separate scoped clients.
  No public `.db` property or SSR/hydration integration has been added.
- Runtime disposal now closes native ontology collections and replica fibers, rejects
  escaped operations, and cannot silently open another managed runtime on the same
  closed adapter. Blob metadata collections share the ontology's scope so dependent
  queries close before their sources.
- Connection refresh and browser connectivity stabilization now use Effect scopes
  and fibers. Regression coverage verifies cancellation and cleanup of late refresh
  results, including when callers close only the owning runtime.
- OAuth clients own scoped local collections, abort token requests on cleanup,
  release browser sessions, and retain persisted credentials for restoration.
  Foundry/Salesforce adapter contexts carry the owner scope into OAuth.
- Web OAuth credentials use encrypted table values and opaque handles. The separate
  browser keyring persists nonextractable WebCrypto keys through native IndexedDB
  structured cloning; concurrent tabs atomically choose one active key. This keeps
  key material out of ordinary table exports, and does not isolate it from arbitrary
  same-origin script execution. Native Chromium verifies encrypted transaction commit
  and restoration across close/reopen. The issue-tracker's plaintext fallback flag
  has been removed. Node OS-keychain credential storage remains available; the planned
  Node/Expo keyring-only credential design is still outstanding.
- Salesforce and metadata adapters now expose the Effect protocol. Native protocol
  executors use scoped DbClient ownership; metadata rejects unsupported mutations
  before opening transports. Snapshot adapters still require query-pushdown refinement.
- Foundry's registered redirect is `http://localhost:3000/auth/callback`, while
  development runs on a worktree HTTPS origin with separate IndexedDB storage.
  Callback messages now target the explicitly configured worktree origin and validate
  origin/source/path/state; no wildcard target is used. Acknowledgment stops fallback
  recovery. Detached callbacks move to the trusted worktree origin before loading
  durable PKCE state. Per-attempt memoization prevents a previous completion from
  masking later attempts. Real Foundry consent, code exchange, encrypted session
  persistence, and project/issue loading succeeded using the redirect flow. Popup
  behavior is restored and its cross-origin handshake has unit regression coverage;
  the desktop popup itself is not exposed by browser automation.
- Browser reload restored the SQLite fixture project/issue/profile. The Performance
  waterfall alignment was visually verified and a screenshot saved. True offline
  document reload, GC integration for bytes/ciphertext, and the remaining full
  lifecycle/adapter work are still required before declaring the migration complete.

## Foundry live synchronization checkpoint

- The initial compatibility bridge refreshed active snapshots on every five-second
  Replica tick. It did not connect the Effect watcher to the native protocol.
- Backend bindings can now supply demand-scoped `watchSubset` invalidation streams,
  separately from durable journal `changes.pull`. Their resources belong to the
  collection demand scope. Idle healthy subscriptions reuse a complete installed
  snapshot; reconnect/change/refresh hints invalidate it. A hint arriving during a
  fetch retains a newer invalidation generation so the next sync repairs that race.
  Watch failures fall back to polling rather than treating an unusable subscription
  as permanent coverage. Synthetic admin users use a scoped one-minute refresh
  cadence because they have no ontology websocket feed.
- Foundry bindings multiplex object-type subscriptions through one Effect watcher.
  Configuring the users integration no longer routes every object type through
  temporary TanStack collections. Synthetic user reads have since moved to a native
  Admin Users subset loader as well: batch-by-ID lookups, paged user listing, and
  conservative prefix search with exact local filtering, ordering, and limits. This
  fixes user-ID queries being broadened to an unfiltered collection search that
  returned no profile rows. The connected issue-tracker profile and Users table
  were verified against Foundry after the port.
- This first bridge still repairs invalidations with snapshots. Native persistent
  per-type edit-history cursors and targeted changed-row installation remain work
  to port from `objectCollectionOptions`. Websocket hints are not durable journal
  commits, and their arrival does not acknowledge an action invocation.
- Live Foundry action execution still waits through the existing operation-ID
  observation/read-back path in private scoped collections. Its returned receipt
  now retains the Foundry operation ID alongside our invocation ID. This is not
  a durable server deduplication guarantee; an ambiguous lost response remains
  uncertain and is not automatically dispatched twice.
- Replica retains journal receipt acknowledgments so a deduplicated receipt older
  than the local head can settle. A concurrently completed entry is not resurrected
  when an in-flight invoke returns. These receipt tombstones currently share the
  unbounded retention policy of completed actions; a safe compaction horizon remains.
- Plain-object storage identities now sort keys recursively. Nested insertion order
  no longer changes invocation identity; ordered arrays and missing/undefined values
  retain their distinct semantics.
- Requested first subset overlap rules: exact primary-key coverage and complete
  collection coverage. More complex predicate/window overlap analysis is deferred.
  Local presence is available immediately; freshness still requires journal progress
  or active watcher invalidation, not an indefinite row-exists shortcut.

- Scoped installation factory is available as `makeOntologyBackendInstallation`
  from `@party-stack/ontology`. Its owner scope closes live ontologies,
  connection sessions, and installation runtimes while retaining durable state.
  The existing Promise factory remains the application boundary. Scope-close
  regression passes; initialization and late-route cancellation still need hardening.
- Full workspace CI passed 144/144 tasks before the watcher/receipt follow-up.
  Follow-up Foundry/Replica/HTTP graph passed 43/43, then receipt/HTTP scope
  regressions passed 42/42; ontology installation tests passed 29/29 tasks.
  A fresh full CI is running for the latest combined source.

## Runtime consolidation scope (latest user direction)

The user explicitly requests removing Effection across the repository, making the
whole runtime Effect-native, retiring obsolete persistence infrastructure once
Tables/Storage replaces it, revisiting coordination around a central owning
process, and using Effect RPC for RPC boundaries. Promise and collection facades
at the developer boundary are fine; wrapping all old internals indefinitely is not
the end state. The user is waiting for a coherent cut before a focused chat review.

Current work and remaining inventory:

- Blob leader/GC/manager lifetimes now run in Effect scopes. Runtime disposal aborts
  remote reads, fences ignored late responses from caching bytes, and closes
  metadata collections. The graph covering blobs/ontology/Foundry/HTTP passed
  44/44 tasks, including the new cancellation regression. Attachment read/metadata
  AbortSignals propagate through the LiveOntology bridges and HTTP/Foundry adapters.
- Removed unused Effection dependencies from blobs and foundry-ontology. Removed
  the unused watcher Effection export/facades and their dependency helpers. Its
  callback facade still delegates to the Effect watcher.
- Coordination is now Effect-owned throughout: single process, browser lock /
  broadcast fallback, and SharedWorker. SharedWorker uses `effect/rpc` plus Effect's
  browser worker platform, retaining Temporal/bigint through `Schema.toCodecIso`.
  Removed the custom worker request/cancel protocol and all coordination Effection
  helpers/dependencies. Native MessageChannel tests cover values, cancellation,
  timeout, host shutdown, and isolation between clients. Coordination/runtime/blob/
  Replica regression graph passed 22/22 tasks.
- The legacy ontology outbox now uses Effect scopes/fibers, scoped background
  callbacks, a sliding wake queue, and Clock/sleep for retry scheduling. Runtime
  disposal closes its scope. Removed the runtime Effection export and the remaining
  runtime/ontology dependencies. No application/library source imports Effection.
  Ontology graph passes 29/29 tasks: 89 tests and one existing expected failure,
  including all 25 legacy outbox retry, recovery, FIFO, and projection tests.
- RuntimeAdapter still exposes legacy Promise ports and persistence. Replace this
  as the implementation contract with scoped Effect services/layers. Keep simple
  application facades around the new host rather than two long-lived engines.
- Browser central host should own storage, Replica, outbox, connections, timers,
  watchers, and GC. Other contexts consume typed Effect RPC and projection streams.
  Investigate the existing SharedWorker path and fallback before changing ownership;
  do not just port the bespoke RPC implementation without evaluating its replacement.
- Installed Effect 4.0.5 includes RPC under `effect/rpc` and worker primitives under
  `effect/workers`. Read local sources and examples before implementing transport.

The canonical-value contract now compares semantic encoded values in both base
and overlay oracle checks. Storage tests pass 20/20. Journal acknowledgment also
requires a matching invocation receipt cursor, preventing another principal's
colliding invocation ID from acknowledging our pending action. Receipt observations
are keyed by invocation ID plus cursor. Include its new regression in the next
full CI run; the last full CI failed before the final overlay assertion correction.

## Owned host refinement

The user proposes a small pseudo-Durable-Object primitive for coordination. See
[runtime-host.md](./runtime-host.md) for the proposed direction: one scoped host
per installation/principal/ontology namespace, session-owned demand, local storage
transactions, typed Effect RPC, and election as a placement detail. This central
host is the next wiring step; the Effect ports above do not by themselves complete
that ownership change. Keep the authoritatively owned backend and disposable replica
roles distinct, and preserve lost-response reconciliation during takeover.

The native path now composes `makeReplicaHost` separately from application
collection materialization. It owns backend acquisition, Replica, attachment
preparation, and blob lifetime; the LiveOntology facade owns its DbClient and
collection views. Placement is injected into the host composition. A regression
proves the host works without backend application collections, survives closing
individual local reader scopes, and releases its backend and blob metadata on
host closure. Connection/installation ownership, one host shared across contexts,
and domain RPC sessions remain to be wired; this is the composition boundary,
not a completed central host rollout.

Host query streams now acquire a scoped demand or persisted-only reader lease and
release it on cancellation. A race regression exposed that `Stream.toPull` alone
does not eagerly subscribe to a lazy PubSub stream. Replica and Runtime now expose
an Effect-valued `subscribeChanges` acquisition; host snapshots, collection sources,
and action-completion waits acquire it before reading their initial state. The
replica/runtime/ontology graph passed 31/31 tasks, including the racing snapshot
and persisted-only cancellation regressions. Ontology now has 92 passing tests and
one existing expected failure.

Full workspace CI passed 144/144 tasks after the coordination/outbox ports and host
composition split. Coordination's follow-up assertion cleanup passes 43/43 tests.
Full CI also passes 144/144 tasks with the explicit subscription acquisition change.

## Subset demand and maintained coverage checkpoint

Replica now reuses maintained whole-collection coverage, confirmed primary-key
results (including absence), and confirmed keys from other complete snapshots.
There is no coverage TTL. Journal progress maintains unbounded queries; bounded
windows retain their snapshot on an idle journal and refill after progress.
Watch-only coverage requires an active caught-up watcher. GC invalidates evicted
coverage. See [replication-coverage.md](./replication-coverage.md) for the exact
rules and conservative fallbacks.

The collection bridge now translates actual TanStack subset expressions using the
existing ontology definitions. It preserves three-valued comparison semantics and
nullish ordering, pushes supported windows, and widens before residual filtering
or locale/custom sorting. Independent acquisition scopes remain independent even
for identical queries. Materialization unions active subsets and excludes late
reads after release. Static local collections keep immediate persisted refreshes.

Watch-only filtered snapshots repair omitted cached candidates by primary-key
batches. A changed filter membership therefore updates the object's baseline
rather than falsely deleting it or leaving a stale matching row. Those requests
run outside the atomic installation/rebase transaction.

Validation for this checkpoint: full CI passes 144/144 tasks; Replica has 14
passing tests and Runtime has 38. SQL conformance covers SQLite and PostgreSQL
nullish ordering and continuation boundaries. Native Chromium IndexedDB passes
all three browser suites. The issue-tracker browser restores 8 Foundry issues,
prefix search returns the expected 5, and selecting Colto project returns 1.
The captured idle Performance trace has a sync root without snapshot reloads.
Browser offline mode was not available in the automation surface; persisted-only
replay and cancellation remain covered by integration tests, not a new browser
offline proof in this checkpoint.

This completes the initial subset/coverage work, not the overall migration.
The shared host domain RPC/session rollout, durable Foundry edits-history catch-up,
remaining adapter consolidation, and automatic GC scheduling are still outstanding.

## Precise retention checkpoint (supersedes the coarse GC guards above)

The user rejected type-wide retention and global outbox eviction suppression.
Both guards are now removed. Demand and persisted-reader leases store their actual
query. GC checks unbounded predicates against bounded sweep candidates and marks
bounded query windows through storage, protecting both confirmed/visible membership
and the offset prefix that influences a window. Queries actually requesting the
whole collection still retain that collection.

Replay now records durable point-read identities, query-result keys, query regions,
and write targets. Ingestion, optimistic rebase, and dependency changes commit in
the same local transaction. Sync can continue while pending actions exist; unrelated
rows remain collectible. Successful replay replaces its dependencies; failure keeps
prior roots and adds partial reads. Query regions protect newly matching rows even
while a replay remains blocked. Receipt reconciliation and action removal release
the roots atomically.

The transaction collection bridge was also loading whole object types before
simple point queries. It now prepares supported single-source WHERE predicates and
keyed edits through persisted reads, caching each prepared region within the same
transaction. Complex joins/derived sources still have a broader persisted fallback;
the planned correlated query IR should remove that remaining precision limitation.

Automatic bounded GC is now scoped with Replica and uses the same placement
capability as sync. Its defaults are a one-minute interval, 100 candidates per
transaction, and a 24-hour cache age; policies can be configured or disabled.
Retention timestamps, primary keys, pending sequence and dependency identities are
indexed. Coverage invalidation also accounts for old returned keys that have moved
out of a snapshot filter.

Validation: full CI passes 144/144 tasks. Replica has 20 passing tests, including
precise overlapping/cross-context roots, pending action restart, continued ingestion,
failed replay/phantom membership and scoped automatic maintenance. Ontology has
93 passing tests plus one existing expected failure. The 13 workerd Durable Object
tests pass and the Worker-safe bundle check passes.

Blob consolidation remains an explicit next change, recorded in
[attachments-gc.md](./attachments-gc.md). The current package has a Runtime/TanStack
dependency, so its implementation must be lowered before moving into
ontology-storage; a package re-export would create a cycle. The Rindle/TanStack
correlated-subquery direction is recorded in [query-ir.md](./query-ir.md).

## Query demand and transactional blob checkpoint

Removed explicit `preload` calls throughout apps/packages and their tests.
`waitForLiveOntologyReady` waits for subsystem startup without starting every
object collection. Tests and the browser persistence harness acquire actual query
or subscription demand. The legacy outbox owns an initial-state subscription to
its locally persisted pending entries; cleanup does not trigger another load.

Transaction collections now forward TanStack's real `loadSubset` requests into
the persisted transaction, including join key batches and correlated includes.
They have collection indexes for lazy join execution. The previous manual
whole-type fallback is removed. Imperative edits still prepare their target key.
A filtered left join and an include with a child limit are tested. Inner joins can
choose a broad driving scan, and the current includes compiler requests correlated
keys without forwarding its child limit; these are actual TanStack demand shapes,
not evidence of complete relational/limit pushdown. See [query-ir.md](./query-ir.md).

The native client blob implementation is now `ontology-storage/blobs`, independent
of Runtime and TanStack. Metadata, aliases, write/delete intents, and durable roots
use Tables. External byte IO occurs outside database transactions, under immutable
bounded-length generation keys. Byte eviction detaches the generation atomically
and preserves identity/metadata. A late delete cannot remove a later cache fill.
Non-cancelable writes settle before cancellation can finalize or abandon their
intent. Recovery respects registered owner liveness and retries deletion intents.

The Tables-backed runtime blob manager is a Promise facade plus an on-demand
metadata projection. It preserves logical names/MIME independently of physical
files, treats a typed missing cache file as a recoverable miss, preserves other IO
errors, and fences late remote reads after cleanup. The replica host composes the
native service and enables independent five-minute byte-cache maintenance.
Standalone native facades leave byte collection disabled unless configured, since their
caller must establish its retention integration.

Replica enqueue/replay/edit/remove/receipt reconciliation now change attachment
roots in the same local transaction as pending work. Ontology-aware traversal
handles nested optional/list/map/struct/union/result values. Upload completion does
not release an invocation's roots; offline/retry/blocked/uncertain work remains
protected until removal or receipt reconciliation. Editing replaces roots after
successful replay and conservatively retains old/new dependencies if replay is
blocked. Active byte readers have separate transient roots.

Validation: full CI passes 144/144 tasks. Storage has 28 tests (including eight
blob race/recovery cases); Replica has 22; the ontology package has 94 passing
plus one existing expected failure. Shared blob conformance runs against native
Chromium IndexedDB, SQLite and PostgreSQL. Native Durable Object tests and the
Worker-safe bundle check pass. No browser offline-mode claim is added here.

The full migration remains incomplete. Generic inline transactional byte capability,
identity graph collection, explicit offline attachment pin APIs, legacy store
retirement, domain host RPC/session ownership and the remaining adapter/runtime
ports are subsequent work. Existing SQLite/DO authoritative attachment coordination
continues to provide its inline/external guarantees.

The issue-tracker UI was verified after the rebuild: Foundry shows 8 issues,
Colto project shows 1, and prefix search `Hi` shows 5. The verification screenshot
is `demand-without-preload.png` in this task's visualization directory. Attachment
remote refetch also preserves its authorization source while substituting a bound
remote ID. The same declared-value traversal decorates nested attachment sources
and collects pending-action dependencies.

## TanStack persistence retirement checkpoint

The legacy `db-indexeddb-persistence` workspace package, runtime persistence
coordinator, persistence adapter interfaces/helpers, and TanStack persistence
dependencies are removed. Node and Expo no longer open a second database for that
protocol. The IndexedDB benchmark retains native indexed, full-scan, and memory
comparisons with an evaluator oracle; the deleted adapter is no longer a benchmark
or conformance dependency.

Every local collection now uses the scoped Tables-backed path, with owned memory
Tables when an adapter supplies no platform storage. Application collections stay
on-demand. Typed ontology/Replica subsets retain their existing pushdown; arbitrary
untyped private collection fields conservatively widen reads when their comparison
semantics cannot be proven. Connections and installation partition bookkeeping own
explicit local record subscriptions for the lifetime of the consuming service.
The remaining private-record ontology port should supply those definitions rather
than introducing another independent schema vocabulary.

Browser invalidation hints reread shared storage, including after visibility,
focus, or page resume. The native cross-tab suite passes seven cases: CRUD/follower
writes, missed notifications, final-write resume, leader replacement, visibility,
simultaneous writes/reload, and Chromium freeze/resume. Runtime tests cover memory
reopen, scoped updates, conservative local query handling, namespace/schema guards,
concurrent transactions, failed-write rollback, and scope cleanup.

The port exposed and fixes two lifetime/identity issues: a service that consumes
private records must retain its demand, and outbox request fingerprints must survive
canonical object-key ordering in storage. Outbox teardown now drains its temporary
TanStack query subscriptions before closing their source. Its 25 behavioral tests
pass against Tables without cleanup warnings. The ontology suite has 91 tests after
replacing the retired persistence-specific tests and expected-failure witness.

This checkpoint does not retire the remaining legacy outbox executor, centralize
domain host/session ownership, or finish the platform Layer and private ontology
ports. Browser key custody, ciphertext caching, and plaintext persistence consent
are separate policies; the current implementation and unresolved configuration API
are recorded in [runtime-host.md](./runtime-host.md#key-custody-and-persistence-consent).

Validation: full workspace CI passes 141/141 tasks, including native Durable Object
tests and the Worker-safe bundle check. The separately invoked native cross-tab
browser suite passes all seven cases. After the final builds, reloading the issue
tracker restores the Foundry session, the sidebar's 8 issues, and the current
My first project view with 2 issues. This is an online UI check, not a browser
offline-mode or service-worker claim.

## Native Foundry action receipts checkpoint

Foundry action submission now bypasses the temporary collection-based invocation
executor. The SDK submission/attachment preparation is shared with the old facade,
but the native path creates no temporary collections, watcher, or edit-history
read-back. Returned edit identities populate the portable receipt's optional
`affected` list; large-scale edits retain broad type targets. Replica durably saves
the receipt on its acknowledged outbox entry before confirmation.

Receipt confirmation calls the ordinary backend `loadSubset` with bounded
primary-key `in` predicates. Foundry routes these through its existing search
endpoint; both native and legacy callers share the HTTP/pagination helper. A
temporary GET-by-key specialization was removed. Endpoint selection and other
performance changes are deferred until measured benchmarks justify them.

Complete read-back and optimistic settlement publish in one local transaction.
Failed or incomplete reads retain the saved receipt across restart, and known
committed receipts reconcile before startup demand snapshots can double-apply the
pending optimistic action. Tests cover exact identity/deletion handling, unrelated
row preservation, partial/offline confirmation and restart without redispatch,
startup ordering, and two native actions retaining one physical watcher socket.

Validation: full workspace CI passes 141/141 tasks. Replica has 26 passing tests;
Foundry has 195. The issue-tracker remains available with its Foundry session and
current two-issue project view. This checkpoint does not claim a real-browser
network-count benchmark. Foundry durable `changes.pull` catch-up, remaining adapter
wrappers, native outbox behavior parity, and host/platform ownership remain open
as recorded in [runtime-host.md](./runtime-host.md#remaining-adapter-and-runtime-migration).

## Native Salesforce backend checkpoint

Salesforce's Effect backend no longer invokes `makeAdapterBackend`. Snapshot
reads, action submission, and query functions call the Salesforce client directly;
they create no temporary collections or CDC subscriptions. The old facade shares
parameter codecs and submission logic while its remaining callers are migrated.

A successful CRUD API response becomes a synthetic committed receipt carrying
the invocation ID and known record identity. `affectedComplete: false` distinguishes
this hint from Foundry's complete edit reports: triggers/automation can change
additional modeled rows. Replica persists the flag with the receipt and uses
conservative broad read-back, including after restart, without dispatching the
action again. Flows and standard actions report broad modeled-type targets.
This is deliberately not a claim of scalable incremental Salesforce catch-up.

The collection-independent SOQL transport is shared with the old collection
facade. Native key equality/batches push down through validated identifiers and
escaped literals. Other predicates, ordering, cursor, and windowing are evaluated
after complete pagination and ontology-value decoding. Invalid/incomplete pages
and malformed identities fail without publishing a complete snapshot. Scope
cancellation aborts client transports that support bound signals. Native CDC
health/reconnect reporting and a durable changes cursor remain future work;
polling repair stays enabled.

Targeted verification passes 38/38 graph tasks, including builds, formatting,
lint and type checks: Salesforce has 58 passing tests and Replica has 27.
Tests exercise direct CRUD/Flow/query-function execution, synthetic receipts,
SOQL pagination/filtering/windowing, escaped key literals, empty-key reads,
invalid snapshots, rejection versus unknown outcome, transport cancellation,
and partial-receipt recovery covering automation effects in another row/type.
Full workspace CI also passes 141/141 tasks, including the Durable Object tests
and Worker bundle safety check.

Host/remote ontology reconciliation remains an architectural target, not a new
implementation in this checkpoint. The initial thin cross-tab proposal streams
visible subsets into per-tab DbClient collections. Subsequent discussion explores
memory children mirroring parent base/projection/outbox state with a local speculative
tail, using the same replication contract rather than a separate host protocol.
See [replica-state.md](./replica-state.md) and the current
[migration inventory](./migration-status.md); neither shared-client path is implemented.

## Parent/child Replica state proof

The existing engine now supports consistent local `snapshotState` inspection and
an explicitly experimental `sourceMode: "ontology"` for trusted full-state ingestion.
The parent and both memory children use `makeReplica`. A child stores imported
parent state separately, materializes the parent-visible result beneath its own
overlay, and atomically adopts an update, retires matching local predictions and
rebases its remaining actions. Mirrored pending work is observed, never dispatched
by the child. Action status distinguishes pending parent work from completed receipts.

A persisted source identity and transactionally advanced state update number let
the child reject source resets/conflicting updates and ignore duplicate/older
snapshots. Handed-off invocation identity survives reopen and prevents duplicate
local projection when a caller repeats enqueue. A persisted source-mode guard
rejects silently reopening imported parent state as a direct backend namespace.

The proof requires complete snapshots of every modeled type, manual forwarding,
disabled GC and no blob service. It does not define a subset-aware wire protocol,
parse untrusted RPC payloads, implement authorization, or route the application
through a worker. Those boundaries must be supplied before exposing state remotely.
See [replica-state.md](./replica-state.md) for the plain-language ownership model.

Five new tests cover two-client optimistic handoff and confirmation, dependent
local work, lost acceptance replies, duplicate/older snapshots, shared removal,
restart/reset, conflicting action identity, invalid-row rollback, source-mode
recovery, and receipt observation from another client's action. Replica passes
32 tests; the final full workspace CI passes 141/141 tasks including workerd and
the Worker-safe bundle check. No new browser offline or worker transport claim
is implied by this in-process checkpoint.

## Scoped parent connections

Added a trusted `ReplicaStateSource` capability and scoped `connectReplicaParent`.
The connection subscribes before reading state, automatically imports parent
updates, and forwards only the child's own ordered tail. `syncParent` claims an
invocation before IO so concurrent edit/removal cannot change a possibly accepted
action. Reply loss and interruption retain its identity; refresh can establish
acceptance without repeating submission. Retryable transfer failures use bounded
retry pacing. Scope closure stops subscriptions/worker without deleting accepted
parent work. Fresh children recognize IDs already present in imported state.

The same connection composes through an intermediate memory Replica. This reuses
one engine with an imported parent view, rather than embedding a second engine
inside each child. `actionStatus.parentAcceptance` reports immediate-source
acceptance separately from queued/sending/acknowledged/blocked/uncertain processing
states and accepted/committed receipts. No topology-level status enum was added.

Completed records remain unbounded full action/receipt records in the same Replica
namespace. They currently protect deduplication and restart/completion observation;
compact receipt/tombstone retention needs an explicit retry/history policy before
expiration is safe. See the status discussion in [replica-state.md](./replica-state.md).

This remains trusted full-state local exchange with disabled child backend sync,
GC and blob service. Selected records, transport decoding/authorization, domain
RPC, app placement and production durability guarantees remain unfinished.

Verification: Replica passes 38 tests, including 11 parent-state/connection tests.
Full workspace CI passes 141/141 tasks, including the Durable Object tests and
Worker-safe bundle verification. This checkpoint does not change application
placement or claim a new browser offline/worker integration result.

## Source terminology and bounded retention design

Renamed the public source modes to `adapter` and `ontology`, distinguishing the
snapshot/action integration from the standard logical-state protocol without
classifying physical placement or authority. Existing persisted source-mode
markers remain readable. Renamed the backend and remote-client capability from
`deduplication` to `idempotency` across implementations and consumers; durable
means keyed invocation identity/result preservation, not a claim about action bodies.

Recorded the next protocol design in [replica-state.md](./replica-state.md):
cumulative applied-state acknowledgments, scoped consumer/view generations,
bounded leases/log retention, explicit resnapshot and separate action retry/result
retention. Resnapshot must preserve local-only work and staged bytes. The same
document describes upload grants/direct OPFS or object-store writes with owner
finalization, extending existing blob intents and generation fencing. These are
design requirements, not implemented acknowledgments, compaction or direct-upload APIs.

Verification after the API rename: full workspace CI passes 141/141 tasks, including
38 Replica tests, application builds/type checks, Durable Object tests and the
Worker-safe bundle check. The issue-tracker remote-source configuration now uses
the renamed `idempotency` option.

## Resumable client admission and typed sources

Replaced the separate source-mode flag with mutually exclusive `backend`/`source`
construction. The public capability is now `supportsIdempotency: boolean` across
native backends, remote bindings, application configuration and tests. A protocol
source starts its scoped transfer connection automatically; provider sources keep
their existing watch/pull path.

Added `ontology-backend/clients`, a transaction-local client registry shared below
Replica. Stable client identity and its resume credential survive reconnect, while
the connection ID rotates to fence the old transport. Sequence acceptance joins
the supplied callback's database transaction. Duplicate requests, changed payloads,
sequence gaps, undelivered acknowledgments and expired clients are handled explicitly.
Admission details compact after applied-state acknowledgment; a per-client watermark
still rejects old requests. Capacity and unacknowledged detail counts are bounded,
and expiry cleans inactive metadata without deleting accepted application work.

Replica forwarding now persists its outgoing sequence before IO and acknowledges
the installed parent state only after the child commit. Lost replies preserve the
same request identity; a source without idempotency produces an uncertain outcome
instead of an automatic repeat. Heartbeats renew idle valid connections. Actual
tests exercise 25 handoffs with no accumulated admission details, plus 50 direct
admissions/acknowledgments and expiry/reconnect/rollback cases.

This bounds admission bookkeeping only. Replica completed/forwarded actions and
journal receipts, plus owned-backend receipts/journals, still require safe bounded
retention. Authoritative and thin-proxy protocol sources, partial-state exchange,
domain RPC, application placement and direct blob grants remain unfinished. The
three intended server compositions are recorded in `replica-state.md`; none
requires an outbox merely because it exposes the standard protocol.

Verification: the targeted backend/Replica graph passes 14/14 tasks, including
seven backend tests and 41 Replica tests. Full workspace CI passes 141/141 tasks,
including Durable Object tests, Worker-safe bundle verification and application
builds. The first sandboxed run could not bind the workerd loopback server; the
permitted rerun outside the sandbox completed successfully.

## Selected sources, owned protocol execution and domain RPC

Moved the transport-independent logical source contract to
`ontology-backend/protocol`, shared by owned backends and Replicas. An owned
backend now exposes `.protocol` directly, committing mutation, journal, ordered
admission and result together without constructing an upstream outbox. Its client
results compact on applied acknowledgment or client expiry, while the watermark
rejects old requests. Protocol execution does not accumulate raw arbitrary-ID
receipt rows. The owned journal retains a configurable number of commits (default
10,000); cursors older than its floor fail explicitly rather than skipping changes.
Replica completion history and legacy raw owned receipts still need safe bounds.

Normalized imported base, projection and action records into child tables. Automatic
source reads select active subsets plus pending-action dependencies and requested
action identities. Queries evaluate composed visible state before limiting; selected
membership replacement covers filter exits, window movement and deletion. Persisted
view generations fence late responses and acknowledgments even when the source
revision is unchanged. Local offline work keeps its precise dependencies after UI
demand closes. Transfer still replaces selected membership snapshots; retained delta
logs and automatic history-reset recovery remain unfinished.

Added schema-first `remote-ontology/rpc` and scoped `rpc/http` Fetch server/client
composition. Demand and change streams use Effect scopes and NDJSON framing.
Operation authorization is mandatory; returned-state projections/old policy wiring
remain necessary before restricted clients can use the protocol. Shared storage
value codecs preserve rich values across the wire. Initial offline reads retain
cached state, failed subscriptions reacquire, and reconnect refresh repairs missed
invalidation hints. Production worker ownership is not switched yet.

Restored focused Foundry watcher manager/session/physical-connection modules with
shared logical subscriptions and cached connection state for late consumers.
HTTP subset reads and watched object sets share conservative filter translation;
unsupported predicates broaden safely and exact evaluation remains local. Watch
updates remain invalidation hints, as agreed; direct authoritative row application
is deferred until measured optimization work.

Verification: backend 16 tests, Replica 49, Foundry 198, watcher 8 and remote 39
pass in their targeted build/check/test graphs. HTTP tests use Fetch request/response
streams with real serialization, authorization and cancellation, including Temporal
and bigint values. No new browser offline/SharedWorker acceptance result is claimed.

Full workspace CI for this checkpoint passes 141/141 tasks, including application
builds, Durable Object tests and Worker bundle verification. The sandboxed run
could not bind local callback servers; the permitted rerun completed successfully.
A subsequent targeted remote graph passes 31/31, including forced HTTP demand
stream interruption/reacquisition and public declaration verification.

## Worker transport and scoped web runtime

Renamed the package to `ontology-server` and updated workspace consumers/lockfile.
Added platform-neutral Effect RPC worker constructors. The server returns a scoped
fiber; the client retains its worker pool in the caller's Scope and bounds its
handshake. Native MessagePort tests cover two memory tabs, shared prediction and
confirmation, independent stream cleanup and handshake timeout.

Extracted `Runtime.make` for scoped construction and added `web-runtime/effect`.
The web Layer lazily acquires platform resources and releases them on completion,
failure or interruption. It supports worker globals, explicit isolated memory,
locked shared persistence and explicit browser-local key persistence. Synchronous
IndexedDB open rejection now becomes a typed storage error, preserving normal
cleanup/fallback handling. Legacy factories/WeakMap glue remain for current consumers.

Added a real-browser proof with one SharedWorker owning IndexedDB and one memory
Replica/TanStack collection set per tab, using the scoped runtime Layer in both
places. It passes initiating-tab closure, continued writes and surviving-tab reload
in an isolated Chromium context. All seven existing lock/broadcast browser cases
also pass. The application still uses its existing installation path; connection,
attachment and helper routing must be integrated before switching issue-tracker.

Verification: the targeted runtime/worker/storage graph passes 38/38 tasks;
ontology-server has 42 tests and web-runtime 11 unit tests. The browser suite passes
8/8 cases. Full workspace CI passes 141/141 tasks, including application builds,
Durable Object tests and Worker bundle safety. Dependency relinking required
restoring the locked SQLite native binding before this successful run.

### Ordinary internal APIs and optional generated Effect models

Promoted the runtime, ontology runtime, web runtime, watcher and backend Effect
implementations to their ordinary package exports. Implementation modules now
live under responsibility-based names such as Runtime, WebRuntime, runtime,
collections and resources. This naming cleanup does not itself retire the
remaining legacy factories or move the issue-tracker into a SharedWorker.

The public schema generator remains explicitly optional for external non-Effect
consumers: portable `types.ts` is the default; `--effect` adds `effect.ts` and
`effect-types.ts`. `ontology-spec/effect` remains the runtime schema/compiler
entry point, and `generateEffectSchemas` / `emitEffectSchemas` retain their names.
The separate build-config Effect preset is also retained.

### Issue-tracker shared owners and memory views

Separated scoped Replica view materialization from owner construction. Views own
DbClient collections, action facades and local inspection. Memory view enqueue
waits for durable owner acceptance, with remote completion still a separate receipt
waiter. Pending-action inspection reads imported plus local action tables directly
and leases the parent's action view; it does not export all object rows.

Issue-tracker installations now choose placement through an application open hook.
A worker restores its bound installation/principal partition and serves the Replica
source. Tabs construct isolated memory Replicas over Effect RPC. Explicit helper
RPCs preserve query functions, full/draft validation, staged attachments, outbox
controls and bounded owner traces. Worker startup and typed bootstrap failure are
separate from source repair. Fallback is limited to unavailable worker transport.

Replaced the duplicated eager web factory with a ManagedRuntime boundary over the
scoped platform Layer; raw and framework facades share the acquired service. The
example opts into persistent browser credentials. Tab pagehide disposes its scope;
back/forward-cache restoration reloads to acquire a fresh scope. Connection and
installation metadata still has coordinated per-context owners; its final private
ontology/key-policy migration follows this application-data checkpoint.

Manual browser verification covers restored Foundry and SQLite profiles, a status
change appearing in another tab, initiating-tab closure, survivor writes and actual
worker Performance spans. The application browser acceptance creates a labeled
SQLite issue and verifies offline edits, a shared pending outbox, tab closure,
reconnect and reload without fallback. Offline document/app-shell reload is not yet
covered. The byte helper currently copies through RPC; direct OPFS/external grants
and range reads remain later blob work.

## Diagnostic inspection checkpoint

Devtools now opens on persisted Objects, followed by Outbox, Queries, Tracing and
Schema. The local query inspector uses ontology labels and typed expression tokens;
its exact-query load counters may come from the worker's read-only monitor. Foundry
and Salesforce snapshot diagnostics distinguish provider rows fetched before local
filtering/windowing from rows returned to Replica. Unknown/evicted/covering-query
loads are not labeled zero, and these metrics do not claim to count database scans.
Tracing is a sortable operation table with meaningful operation icons and colored
outcomes, with nested waterfalls and bounded subscription messages in details only.
Schema uses React Flow pan/zoom/selection and Dagre layout.

Canonical ontology reads normalize optional provider nulls to undefined. The
TanStack-to-storage translator no longer generates redundant non-null guards for
those typed fields; generic storage still distinguishes explicit null and undefined.
This UI/diagnostic work does not complete private connection/installation ownership,
credential policy, direct/ranged blob transfer, retained protocol history/reset,
or remaining legacy adapter/runtime retirement.

## Native action policy and backend retirement — October 21

Completed the native execution/construction checkpoint described in
[native-actions.md](./native-actions.md):

- Persist retry budgets/deadlines, preserve total attempts, implement pause and
  discard-all, and expose cancellable accepted/confirmed observations. Discard-all
  intentionally abandons unknown outcomes too; refresh can reveal a committed
  remote write. Pause retains the evidence for explicit recovery.
- Distinguish known pre-submission failures from ambiguous remote outcomes.
  Reconcile independently verified receipts without redispatch; explicit ambiguous
  retry requires the caller to acknowledge possible duplicate execution.
- Persist receipts before local attachment mappings. Retry idempotent local receipt
  application and confirmation after restart, preserving evidence if either fails.
- Freeze portable expression time/UUID inputs across rebase and forwarding. Skip
  speculative action logic for confirmed-only visibility while resolving its inputs
  from persisted transaction data. Explicit UI parameter resolution can still demand
  data normally.
- Remove makeAdapterBackend, backendAdapterFromEffect, the second outbox executor
  and collection-oriented backend methods. LiveOntology always composes Replica;
  native provider bindings acquire services through scoped open(context).
- Port metadata/query/attachment paths to native SDK snapshots/services. Preserve
  safe residual filtering/windowing, cancellation and native Foundry Admin Users.
  SQLite/DO schema creation is lazy at service acquisition; retired private JSON
  tables are no longer created. Some independent collection helper exports remain.
- Initial collection demand attempts synchronization before becoming ready;
  persisted-only replay/inspection stays local. Unwatched demand uses scoped polling,
  with an explicit false policy for static metadata and honest watcher diagnostics.

Full workspace CI passed 141/141 tasks after the native contract/fixture ports.
Chromium acceptance passed 4/4 cases, including offline edits surviving tab closure,
shared-owner settlement/reload, stable devtools navigation and worker-disabled fallback.
See [migration-status.md](./migration-status.md) for remaining work and verification
limits; this checkpoint does not finish blob integration or general remote hardening.
