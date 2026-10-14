---
"@party-stack/better-auth": patch
"@party-stack/blobs": patch
"@party-stack/connections": patch
"@party-stack/db-indexeddb-persistence": patch
"@party-stack/durable-object-ontology": patch
"@party-stack/expo-runtime": patch
"@party-stack/foundry-ontology": minor
"@party-stack/node-runtime": patch
"@party-stack/oauth": patch
"@party-stack/ontology": minor
"@party-stack/ontology-devtools": patch
"@party-stack/remote-ontology": patch
"@party-stack/runtime": patch
"@party-stack/salesforce-ontology": patch
"@party-stack/sqlite-ontology": patch
"@party-stack/web-runtime": patch
---

Align Expo runtime dependencies on SDK 57 and provide a required Expo Blob/File polyfill. Hash Expo storage names, and verify idempotent cleanup closes SQLite before deletion.

Expose optional awaitable collection refresh utilities and implement full Foundry snapshot refresh, preserving subscriptions and propagating failures. Use fresh committed snapshots for operation acknowledgement when edit history is unavailable.

Upgrade TanStack DB and integrations to their latest releases and adapt persistence adapters and coordination to explicit storage targets.
