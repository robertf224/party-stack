# Owned backend port checkpoints

Status: runtime Effect codec compilation is implemented. Transaction-scoped
TanStack execution, attachment integration, backend journals, and backend factory
replacement below are proposed checkpoints, not implemented capabilities.

## Preserve query execution while replacing storage

Keep the existing `tx.query` / `tx.mutate` developer boundary for the first port.
TanStack DB can execute queries over invocation-scoped collections whose subset
loads use the caller's owned-storage transaction. A portable ontology expression
and hierarchical query IR does not require a new query executor.

Every read used by an authoritative action, including parameter/default lookups,
must participate in the chosen transaction/consistency policy. Queries must see
the action's own writes. An arbitrary snapshot of long-lived UI collections is
not that transaction. Publish confirmed changes after persistence commits; discard
the invocation's temporary state on rollback.

A database snapshot alone is not a portable serializability guarantee. Select a
documented conflict/serialization policy for each backend. The current SQL driver
uses PostgreSQL key locks and conservative logical-table predicate guards held
through commit for cooperating writers, plus lock-free repeatable-read snapshots.
This does not establish isolation from arbitrary external writers.
The bridge must also respect IndexedDB transaction lifetimes and Durable Object
transaction/scheduling restrictions. Do not run remote/blob network I/O while
holding a native storage transaction.

Preserve the active Effect service context when crossing into TanStack Promise
callbacks: capturing a transaction handle alone is insufficient if the SQL
statement subsequently runs in a fresh Effect context and acquires another
connection. Callback work must finish or be interrupted before the transaction
scope closes; it must not leave background reads/writes using that connection.

The first proof must exercise lazy subset loading, read-after-write queries,
multi-object rollback, concurrent conflicting actions, and publication only after
commit. Translate supported TanStack subset predicates, with complete fallback
loads where required. Unsupported expressions must not silently become partial
query results. Keep access to private TanStack IR behind a small compatibility
boundary rather than adopting it as the portable protocol.

## Expressions, hierarchy, and cross-ontology references

Extend ontology-spec's existing expressions with comparisons, boolean operators,
membership, and pattern matching. Query rows use ordinary input/local bindings;
query parameters and authenticated context retain their existing roles. Structural
property access can retain `field` as convenient contextual syntax.

Query IR separately describes sources, relationship existence, related result
inclusion, ordering, and pagination. Ontology links supply default correlations.
Object lookup/to-one link traversal can lower to that relational machinery. Keep
explicit joins for relationships that cannot be declared in either source model.
A typed builder with reference proxies is an authoring layer over that IR.

Source bindings must identify the ontology/storage namespace as well as the object
type. The outbox can reference action-definition metadata from the meta ontology
without copying those definitions into every application ontology. Durable pending
work must retain enough definition identity/version or historical metadata to
remain understandable after an ontology update.

Cross-ontology composition does not imply a distributed snapshot: sources sharing
one owned database transaction can participate in its consistency boundary;
independent/remote sources need explicit consistency and availability semantics.
Keep this separate from whether the query builder can express their relationship.
Apply trusted policies to all relevant source/related reads before exposing results;
offline pinning cannot broaden authorization.

## Port sequence

1. Runtime codecs: `compileEffectSchemas(ir)` in ontology-spec's optional Effect
   entry, and `makeStorageModel({ namespace, ir })`. Generated named codecs remain
   supported. This checkpoint is implemented and checks runtime/generated parity.
2. Transaction-scoped query/mutation bridge, proving the behavior above before
   committing to the full backend integration. Retain TanStack as executor.
3. Port attachment metadata, inline bytes in the same database transaction, and
   external-byte staging/recovery. Reuse the existing SQLite/R2 failure cases.
   Design reads to accommodate ranges without claiming every driver streams.
4. Replace sqlite-ontology internals using the shared bridge and attachment
   services. Preserve current public factory/handler APIs where practical. There
   are no production databases requiring a legacy-layout migration.
5. Adapt DO SQL native transaction/lifecycle behavior, compose the same backend
   implementation with SQLite or R2 bytes, and run its existing conformance suite.
6. Move runtime local collections progressively onto the same storage and commit
   publication foundation, then introduce Replica/sync/outbox demand integration.
   Existing local collection helpers provide a useful migration boundary; plain
   local row collections need not all become public ontology object types.

## Durable commit journal

Include a bounded first journal with the owned-backend checkpoint rather than
waiting for the full replication engine. An action's object changes, attachment
metadata, receipt (when supported), and change batch must commit atomically.
Choose a source-scoped commit position and record ordered transaction boundaries,
object identity, final upserts/deletes, and optional action/receipt correlation.
Exact journal interfaces remain to be implemented.

Readers catch up from durable positions. In-process notifications only wake them
after commit; they are not the source of truth. Initial snapshots and their
continuation positions must be coordinated so changes cannot fall between them.
Retention must define when an old cursor requires a new snapshot. A journal does
not itself implement hierarchical query maintenance, authorization-aware remote
delivery, or optimistic action reconciliation.

Replica work can then add demand leases, subset completeness, offline pins,
optimistic overlays, durable outbox and receipts, reconnect handling, independent
row/blob eviction, and `replicatedCollectionOptions`. Connection/OAuth/installation
records can migrate through existing local collection boundaries later, while
source identity and lifecycle ownership remain explicit from the start.
