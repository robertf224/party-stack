---
"@party-stack/better-auth": minor
"@party-stack/blobs": minor
"@party-stack/connections": minor
"@party-stack/coordination": minor
"@party-stack/db-indexeddb-persistence": minor
"@party-stack/durable-object-ontology": minor
"@party-stack/expo-runtime": minor
"@party-stack/foundry-ontology": minor
"@party-stack/node-runtime": minor
"@party-stack/oauth": minor
"@party-stack/ontology": minor
"@party-stack/ontology-devtools": minor
"@party-stack/remote-ontology": minor
"@party-stack/runtime": minor
"@party-stack/salesforce-ontology": minor
"@party-stack/sqlite-ontology": minor
"@party-stack/web-runtime": minor
---

Upgrade TanStack DB dependencies and peer requirements to DB 0.11.3, React DB 0.5.3, Query DB Collection 1.3.4, SQLite persistence core 0.4.3, and Expo/Node SQLite persistence 0.2.28.

Update IndexedDB persistence and runtime coordination for the required atomic resume snapshots, remote subset lease lifecycle, and leader-side committed transactions. The runtime persistence interface remains a `PersistenceAdapter`; custom adapters must implement the new required `loadResumeSnapshot` method.

Maintain only changed rows, metadata, and index entries during IndexedDB commits instead of rewriting complete collections. Reuse existing indexes and lazily rebuild legacy index summaries once. Abort failed index maintenance atomically with row writes.

Preserve nanosecond precision for Instant range indexes and chronological PlainDate ordering across negative and extended years. Older index encodings fall back to scans until rebuilt.

Retain adapter-level schema mismatch checks and stale-adapter fencing in IndexedDB. Runtime per-collection schema resolution is deferred. Upgrade existing IndexedDB databases without discarding rows. Release cached coordinator positions when the last collection subscription closes.

Bound transaction deduplication and replay history, replay missed commits with rows and metadata, and reload when a baseline replacement, history gap, or large change set prevents incremental recovery.

Use ordered IndexedDB cursors for homogeneous supported indexes and stop after a filtered page. Preserve cursor boundary ties, fall back for other ordering semantics, and select metadata-bearing rows using a dedicated index. Match nested expression paths exactly, merge partial row updates, and respect metadataChanged.

Pin broadcast RPC retries to the original elected node and leadership term, discover the leader before the first request, and surface uncertain outcomes as `INDETERMINATE` instead of repeating work after takeover. Coordination wire protocol version is now 2; all communicating runtimes must use the same version. Retain replies throughout the retry window and reject new remote calls when retry retention is full. Preserve row metadata in local mutation coordination and advance cached positions only after storage succeeds.

Scope remote subset acquisition IDs by collection as well as options identity, so releasing a reused query options object in one collection cannot lose another collection’s lease.

Release broadcast reply payloads when their retention window expires while idle, and clear reply, client, and listener caches on shutdown. Bound IndexedDB initialization bookkeeping to 128 collection IDs while capturing each operation’s schema epoch, clear it on close, and handle close during database opening. Release failed remote subset leases and their retained options before reporting the original load failure.

Bound host-side collection position caches for client-only collections and restore evicted positions from durable stream state, falling back to an atomic resume snapshot when `getStreamPosition` is absent. Remove rejected position initialization promises so subsequent attempts can recover.
