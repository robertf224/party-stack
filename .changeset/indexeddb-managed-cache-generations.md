---
"@party-stack/db-indexeddb-persistence": minor
---

Implement managed on-demand cache generations with the same claim, rotation,
renewal, expiry, release, and private recovery semantics as upstream SQLite.
Validate claims transactionally on storage operations and collect retired data
only after its last live claim ends. Upgrade IndexedDB storage to version 4 while
preserving existing local-only/eager rows and metadata.

Derive adapter options from SQLiteCoreAdapterOptions without its driver and add
only databaseName. Remove unused notification callback options while retaining
automatic connection closing for database upgrades. Direct adapter operations
now require explicit eager or managed storage targets, matching upstream.

Port managed-cache contracts and receiving recovery histories from TanStack DB,
including the complete finite retired-storage matrix, and run them against
SQLite, fake IndexedDB, and native Chromium IndexedDB.
