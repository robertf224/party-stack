# Ontology-owned schemas, storage, and migrations

Status updated October 30: ontology-spec, derived Effect schemas, ontology-storage,
blob integration, GC and the backend protocol are implemented. Native SQL columns
and general schema/data migration history remain future work. Native object
columns will be designed with migrations, rather than as a separate current pass.

## One ontology model

`ObjectTypeDef` and the rest of the ontology IR are the authored schema model.
Attachments and object references remain first-class concepts. Do not introduce a
second generic schema language below Ontology: that boundary previously required
flattening and reconstructing domain meaning without enough benefit.

`@party-stack/ontology-spec` now owns IR types/builders, value types, inference,
structural validation, lenses, JSON codecs, meta-ontology definitions, and codegen.
`@party-stack/ontology` retains live collections, installations, metadata pulling,
and backend integration, and re-exports its existing public spec surface.

Codegen stays inside ontology-spec for simplicity, isolated behind `/generate`.
Explicit bootstrap uses checked-in generated IR types/builders and has no runtime
dependency back to ontology. Runtime consumers do not load Node tooling through
the spec entry point, although the package currently installs tooling dependencies.

The ported Tables engine now lives in ontology-storage, with separate
sql-ontology-storage and indexeddb-ontology-storage drivers. The public object API
binds existing ObjectTypeDef definitions to generated codecs, derives primary
keys, validates field paths, and stamps a storage namespace with its definition.
The dynamic engine remains under explicit infrastructure entry points. No second
authored schema API was introduced. Physical SQL storage still uses the existing
shared-row/JSON layout. The former sqlite-ontology wrapper now uses the common
owned backend composition; native per-property SQL columns remain future work.

## Backend protocol versus owned storage

The future backend interface is expected to expose pulling changes and invoking
actions with receipts. The engine handles demand, synchronization, optimistic
replay, outbox processing, and receipt/change visibility. Its design should follow
the Replica architecture reference, rather than the current TanStack-coupled
backend adapter interface.

Owned databases additionally need direct transaction-scoped object reads/writes,
subset queries, index operations, and schema upgrades. That lower storage contract
can initially remain internal. It has no live Collection parameters and does not
require a remote backend to pretend it owns a database.

An owned backend can execute an action and atomically persist object changes,
idempotency/receipt records, and change-log entries. Receipts and change-log records
are defined by that backend; the storage contract can handle them through the same
transaction machinery without understanding their protocol meaning. External
attachment bytes still require staging/journaling and recovery rather than a false
claim that SQL and R2 commit in one transaction.

Durable Object bindings and R2 lifecycle handling live in the thin
durable-object-ontology-storage composition package. It shares the SQL Tables,
blob intent/retention and owned backend implementations.

## Derived Effect schemas and storage mappings

Generate or compile TypeScript types, Effect schemas/codecs, and physical SQL
mappings from the same ontology definitions. Effect Schema is a derived runtime
representation, not another schema users author in parallel. SQL mapping consumes
the ontology IR directly; arbitrary Effect refinements/transformations should not
be reverse-engineered into DDL.

The ontology already uses Temporal.PlainDate for dates and Temporal.Instant for
timestamps. Supply small shared Effect schemas/codecs for those values, preserving
precision. Object-reference shape validation can use the target primary-key schema;
checking target existence belongs to execution. Attachment handles retain ontology
semantics while metadata/bytes use the attachment infrastructure.

The current ontology integer is described as 32-bit; bigint and any explicit
integer-width/precision policies need deliberate additions to the ontology IR.
Do not silently reinterpret its existing integer kind to cover arbitrary bigint.

The initial implementation is opt-in `generate --effect`: portable `types.ts`,
Effect-facing `effect-types.ts`, and `effect.ts` codecs all derive from the same
IR. A codec's decoded side uses Effect Result, while its encoded side uses the
portable ontology result shape. Temporal and ordinary objects remain unchanged
in memory; canonical JSON codecs encode Temporal as ISO strings. This is a value
representation bridge, not a second definition language. Future storage should
consume the IR directly for physical layout and compose these codecs at its
boundaries. Bigint is deferred until an explicit ontology kind such as long exists.

## Native SQL columns

Deferred with schema/data migrations after the October 30 review. Initial DDL can
be generated from ontology object definitions, with scalar columns and explicit
JSON encodings for nested values. The larger work is plumbing that layout into
the SQL driver, preserving codec/query/index semantics and specifying version
changes across dialects. No second authored schema language is needed. Do not
blindly enforce SQL foreign keys for partial replicas, whose referenced targets
may legitimately be absent locally. Readable views could be an interim inspection
feature; they are not a substitute for an explicit native layout/migration design.

Currently SQL has shared rows/definitions tables, an encoded payload, and a
JSON/JSONB projection for indexed scalar fields. Expression indexes and subset
predicates already run in SQLite/PostgreSQL, but the layout is not a native typed
column per application property.

Ontology-aware storage could use real tables/columns for declared scalar fields,
with JSON/JSONB for nested values and explicit encodings where needed. Storage
annotations may live on ontology definitions when domain types do not determine
physical choices. Map/Set need not imply relational child tables. SQL inspection
and interoperability are useful reasons to support this layout.

| Concern             | Required decision                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Bigint              | JS bigint is unbounded; SQL integer types have finite ranges. Declare constrained int64 or a lossless NUMERIC/text mapping.     |
| Temporal.Instant    | PostgreSQL timestamp precision is microseconds, while Temporal carries nanoseconds. Explicitly preserve or constrain precision. |
| Temporal.PlainDate  | Specify the supported range/calendar and SQL DATE mapping.                                                                      |
| Nested objects      | JSON values may still need declared bigint/Temporal transforms.                                                                 |
| Missing versus null | Decide ontology semantics; SQL NULL alone cannot preserve both states.                                                          |
| Ordering            | Column comparisons must preserve declared scalar/collation and cursor semantics.                                                |
| Validation          | Validate writes and migration results; avoid implicit migration writes during reads.                                            |
| Schema identity     | Preserve stable object/property identity and ordered versions; presentation-only edits should not require data rewrites.        |

## Lenses and migration history

The existing move/select operations are a starting point for a Cambria-inspired
language, expected to gain casts and other transformations. Share that language
between schema derivation, value transformations, and migration planning.

A migration binds a transformation to source/target schema versions. Preserve old
shapes or enough history to reconstruct and validate them. A projection selecting
fields is not implicit authorization to delete stored data. Lossy casts require
explicit failure/default/reverse policies; not every transformation is invertible.

SQL can optimize a transformation into DDL/DML when its semantics match. Otherwise
use a portable row transformation or report unsupported compilation. IndexedDB and
memory can execute the same logical transformation and rebuild affected indexes.
The backend must not silently change cast behavior to obtain SQL pushdown.

Migration definitions/history belong with ontology definitions. Execution supplies
locking, deterministic ordering across skipped releases, checksums/drift detection,
index maintenance, atomic version advancement, and recovery. A live upgrade must
fence stale readers/writers and coordinate in-memory state as well as persisted
records. Memory needs these semantics too, even though its state is ephemeral.

IndexedDB logical tables/indexes occupy fixed stores, so many migrations are row
transformations and index rebuilds rather than native database-version upgrades.
SQLite rebuilds and PostgreSQL alterations need dialect-specific plans. Long
multi-transaction backfills require resumable phases or staging; independent batch
transactions do not provide whole-migration rollback.

## Replica implications and next checkpoint

A row migration cannot by itself upgrade durable pending mutator arguments. Replica
must migrate invocations, retain compatible mutators, or explicitly reject an
incompatible upgrade. Coordinate base, overrides, outbox, and revision metadata.

The first object-storage contract now exercises attachments, object references,
Temporal, Effect/portable Result conversion, indexes, and rollback across objects
on the ported drivers. Bigint remains deferred to a future ontology kind. Next,
port attachment bytes/metadata and work through rename/default/cast migrations
before shipping a native-column layout or Replica integration. See
[attachments and GC](./attachments-gc.md) for authority, independent row/byte
retention, operation fencing, and subset coverage invalidation.
