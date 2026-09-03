# @party-stack/sqlite-ontology

Provider-neutral authoritative SQLite backend for Party Stack ontologies.
Each SQLite database is owned by exactly one ontology; use a separate database
for another ontology.

The package owns:

- The minimal synchronous `SQLiteDatabase` contract.
- Object tables, queries, declarative actions, registered mutators, and query
  functions.
- Atomic cross-collection action persistence.
- Inline or injectable authoritative attachment bytes.
- Internal table scaffolding and attachment-schema compatibility.

It does not own Cloudflare bindings, authentication installations, runtime
persistence, or application-defined schema migrations.

Object-schema signatures remain fail-closed: changing an existing object IR is
rejected until the caller migrates or recreates that database. A general
application migration API is intentionally deferred from this package scope.

## Database portability

An existing better-sqlite3 database structurally satisfies `SQLiteDatabase`.
Other SQLite runtimes can provide the same `exec`, prepared statement, and
synchronous transaction subset without importing platform types here.

## Attachments

Inline SQLite BLOBs are the default. Supply
`attachmentStorage.external.bytes` to store authoritative bytes elsewhere while
retaining metadata and object references in SQLite.

External writes use generation-specific keys and an upload/orphan journal so a
failed SQL commit never leaves an object reference without its required bytes.
Use `collectSQLiteAttachmentOrphans` and
`recoverSQLiteAttachmentOrphanClaims` for cleanup and crash recovery.

Each SQLite database stores one ontology's attachment table, keyed by
attachment ID. Legacy attachment rows are upgraded automatically as internal
package scaffolding.
