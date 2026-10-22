---
"@party-stack/coordination": minor
"@party-stack/runtime": minor
"@party-stack/ontology-replica": minor
"@party-stack/foundry-object-set-watcher": minor
"@party-stack/foundry-ontology": minor
"@party-stack/salesforce-ontology": minor
"@party-stack/ontology-backend": minor
"@party-stack/connections": minor
"@party-stack/oauth": minor
"@party-stack/web-runtime": minor
"@party-stack/node-runtime": minor
"@party-stack/expo-runtime": minor
"@party-stack/ontology": minor
"@party-stack/ontology-server": minor
"@party-stack/sqlite-ontology": minor
"@party-stack/durable-object-ontology": minor
---

Replace Effection lifetimes with Effect scopes and fibers throughout coordination,
blob management, and the ontology outbox. Remove the runtime and watcher Effection
exports and dependencies. Runtime disposal cancels owned work and prevents late
remote reads from repopulating closed blob storage.

Use Effect RPC and its browser worker transport for SharedWorker coordination,
with schema-derived intermediate codecs for Temporal, bigint, undefined, and native
structured-clone values. Advance the protocol identity to version 4; coordinating
contexts must run compatible versions. Preserve cancellation, request timeout,
service FIFO, and lost-response fencing in the browser fallback.

Acquire replica/runtime change subscriptions before initial snapshots so changes
racing collection startup or action-status reads cannot be missed. Separate the
scoped replica service composition from application DbClient collections and add
scoped host query streams with persisted-only inspection support.

Forward TanStack subset predicates and supported windows into Replica, preserve
three-valued comparison semantics, and retain the union of active query views.
Reuse maintained whole-collection and primary-key coverage without idle snapshot
refreshes. Repair filtered watch-only snapshots by identity before removing cached
rows that may have moved out of a query.

Replace type-wide GC roots and global outbox eviction suppression with persisted
subset leases and per-action read/query/write dependencies, updated atomically
during replay. Preserve previous and partial dependencies when replay fails.
Prepare simple transaction queries and keyed edits without loading a whole type.
Schedule bounded, scoped replica collection with configurable cache age and batch
limits; invalidate affected coverage when rows are evicted.

Remove explicit collection preloads and whole-ontology startup synchronization.
Forward transaction queries through real TanStack subset demand, including lazy
join key batches and correlated includes, while keeping all replay reads local.

Move native blob metadata, generation intents and retention into the
ontology-storage blobs service. Compose a Tables-backed application facade and
transactional outbox attachment roots. Preserve metadata/aliases after byte
eviction; fence stale deletes and late writes, protect active readers, distinguish
missing cache files from IO errors, and recover abandoned generations conservatively.

Remove the TanStack persistence coordinator, adapter interfaces, SQLite persistence
dependencies, and the legacy IndexedDB persistence package. Local collections now
use scoped Tables-backed views on every runtime, including an owned memory fallback.
Browser storage invalidations and page-resume events refresh active local demand.
Keep private connection and installation record demand alive for their service
lifetime; preserve stable optimistic request identity across canonical storage
round trips and drain temporary outbox queries before closing their source.

Submit native Foundry actions without temporary live collections or per-action
watchers. Convert returned edit identities into durable receipt read-back targets.
Persist the receipt before confirmation, retry failed/incomplete reads after restart
without redispatch, and atomically publish confirmed rows with optimistic settlement.

Port Salesforce snapshots, action submission and query functions directly to the
Effect backend contract. Reuse a collection-independent SOQL transport and
synthesize committed CRUD receipts with known identities and explicit partial
target coverage. Retain conservative read-back for automation effects and polling
repair until native CDC health/reconnect reporting is available.

Add consistent local Replica inspection snapshots and an opt-in in-process
parent/child proof using the same engine. Preserve imported shared state beneath
local predictions, atomically retire handed-off actions during import, and track
stable source identity plus ordered updates across reopen. The proof uses complete
trusted snapshots with manual forwarding and excludes transport, subset sync,
authorization, blob integration and GC; application wiring remains unchanged.

Complete the native LiveOntology execution path and remove the collection-oriented
backend contract, compatibility constructors and duplicate outbox executor. Backend
bindings acquire scoped services with open(context); provider metadata, query and
attachment helpers use native snapshots/services. SQLite and Durable Object schema
initialization happens at acquisition rather than factory construction.

Persist retry deadlines/budgets and failure details. Support pause/discard-all,
accepted/confirmed waits, explicit ambiguous retries and verified-receipt recovery.
Preserve frozen expression time/UUID inputs across replay and forwarding. Save
receipts before idempotent attachment mapping application and retry failed mapping
or confirmation after restart without submitting the action again.
