---
"@party-stack/ontology-storage": minor
"@party-stack/indexeddb-ontology-storage": minor
"@party-stack/sql-ontology-storage": minor
"@party-stack/build-config": minor
---

Add Effect-based transactional Tables with portable JavaScript/bigint/Temporal values,
native SQL / user-space IndexedDB indexes, subset queries, and separate sparse-overlay composition.
Provide IndexedDB, in-memory, and SQLite/PostgreSQL implementations with a shared conformance contract.
Add an opt-in Effect library build/TypeScript preset and workspace development tooling.

Port these experimental packages to ontology-storage, sql-ontology-storage, and
indexeddb-ontology-storage. Add an ontology-derived object API with generated codecs,
primary-key derivation, validated scalar paths, definition-drift guards, and native
transactions. Keep the raw engine under explicit infrastructure exports. Document
independent attachment-byte and replica-row retention without adding automatic GC.

Allow storage models to derive codecs directly from ontology IR while retaining
generated schemas for statically typed models.
