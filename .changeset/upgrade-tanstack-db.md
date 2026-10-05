---
"@party-stack/better-auth": minor
"@party-stack/blobs": minor
"@party-stack/connections": minor
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
---

Upgrade TanStack DB dependencies and peer requirements to DB 0.11.3, React DB 0.5.3, Query DB Collection 1.3.4, SQLite persistence core 0.4.3, and Expo/Node SQLite persistence 0.2.28.

Update IndexedDB persistence and runtime coordination for the required atomic resume snapshots, remote subset lease lifecycle, and leader-side committed transactions. Custom runtime persistence adapters must implement `loadResumeSnapshot`.

Maintain only changed rows, metadata, and index entries during IndexedDB commits instead of rewriting complete collections. Reuse existing indexes and lazily rebuild legacy index summaries once. Abort failed index maintenance atomically with row writes.

Preserve nanosecond precision for Instant range indexes and chronological PlainDate ordering across negative and extended years. Older index encodings fall back to scans until rebuilt.

Enforce collection schema versions and fence stale IndexedDB adapters after resets. Runtime collection factories forward schema and local/synced mode to scoped adapters, preserving incompatible local-only data and resetting refetchable synced caches. Upgrade existing IndexedDB databases without discarding rows.

Bound transaction deduplication and replay history, replay missed commits with rows and metadata, and reload when a baseline replacement, history gap, or large change set prevents incremental recovery.

Use ordered IndexedDB cursors for homogeneous supported indexes and stop after a filtered page. Preserve cursor boundary ties, fall back for other ordering semantics, and select metadata-bearing rows using a dedicated index. Match nested expression paths exactly, merge partial row updates, and respect metadataChanged.
