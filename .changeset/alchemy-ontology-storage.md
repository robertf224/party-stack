---
"@party-stack/durable-object-ontology-storage": minor
"@party-stack/ontology": minor
"@party-stack/sql-ontology-storage": minor
"@party-stack/ontology-server": minor
"@party-stack/ontology-backend": minor
"@party-stack/ontology-storage": patch
"@party-stack/build-config": patch
---

Replace the SQLite ontology attachment coordinator with shared transactional blob
storage and a common owned backend composition. Remove the sqlite-ontology package.
Rename durable-object-ontology to durable-object-ontology-storage and consolidate
its R2 implementation on Alchemy's client, with separate storage bridges and an
Alchemy constructor/resource example. Verify interrupted write/reader recovery with
real local Durable Object resets.

Stream attachment helper transfers over Effect RPC with scoped upload ownership,
bounded acknowledged chunks, size/sequence validation and cancellation. Support
source-only backend attachment/query helpers without constructing LiveOntology.
Keep Effect test aliases from redirecting Vitest worker entry points.
