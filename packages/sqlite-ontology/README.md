# @party-stack/sqlite-ontology

Provider-neutral authoritative SQLite backend for Party Stack ontologies.

The package owns:

- The minimal synchronous `SQLiteDatabase` contract.
- Object tables, queries, declarative actions, registered mutators, and query
  functions.
- Atomic cross-collection action persistence.
- Collision-safe SQL namespaces.
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

Attachment identity is `(SQL namespace, attachment ID)`, allowing separate
logical ontologies to reuse an attachment ID safely.

Legacy attachment rows are upgraded only as internal package scaffolding. Rows
without an ontology require an explicit `legacyAttachmentSqlNamespace`; they
are never assigned according to startup order.
