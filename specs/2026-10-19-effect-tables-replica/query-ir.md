# Query IR direction

This is a design note, not an implemented ontology query API.

The October 19 discussion adds Rindle's `.sub`/`rel` approach as a reference,
alongside TanStack DB's includes system. Rindle's current
[API map](https://rindle.sh/docs/api) lists `rel` and relationship definitions;
its [public examples](https://rindle.sh/) show `.sub` with an explicit child source,
parent/child key correlation, and child ordering/limits. The originally supplied
query-builder URL was unavailable to the research reader. We have not independently
verified a migration/deprecation schedule for Zero's `.related` API.

## Design choice

Correlated subqueries should be a general query primitive. A named ontology
relationship supplies convenient defaults for building that same primitive. It
must not create a separate execution language or restrict queries to predefined
links.

Keep these concepts explicit in a portable, serializable query tree:

- Source identity: ontology/namespace and object type, plus a lexical binding.
- Expressions: references to local/outer bindings, literals, parameters, operators.
- Relational operations: source scans, filtering, projection, ordering, limits,
  offsets/cursors, joins, and aggregates.
- Nested projections: output alias, child query, parent/child correlation,
  cardinality, and optional required/optional result behavior.
- Existence predicates: correlated exists/not-exists without requiring the child
  result to be included in the output.

Use binding identity rather than inferring scope from a property name or alias
string. A nested query's order and limit apply per parent. Composite correlations
and multiple nested projections of the same relationship must remain expressible.
Projection aliases belong to result shape, not source identity.

The builder can offer a `sub`/includes-style operation for arbitrary child queries
and a `rel` helper derived from an ontology link definition. Both should lower to
the same correlation representation. The exact spelling is still open. Explicit
source handles must also permit cross-ontology joins, such as joining an outbox
entry to its action-type metadata. Possession of a source name does not authorize
access to that source.

## Connection to replication and retention

A query tree can describe UI data, offline pinning, and security-policy inputs.
Those uses share structure, but their interpretation and authority remain explicit:
a client demand is not itself an authorization rule.

Demand and GC must follow the correlated result region and its dependencies,
including outer correlation keys, child membership, per-parent windows, and reads
performed by pending operations. A child subscription must not pin an entire child
object type merely because it appears in a query. New matching rows are a query
dependency, not just a list of keys observed in an earlier snapshot.

Lenses remain version/type/value transformations. Query expressions and lens
expressions can share operators and binding rules; changing a schema version and
selecting a live related subset remain distinct operations.

## Current implementation boundary

The storage predicate IR handles flat subsets. Transaction collections now forward
TanStack's actual `loadSubset` requests to the persisted snapshot, including lazy
join key batches and correlated includes. They do not manually preload all rows
of the types named by a query. Imperative keyed edits prepare only their target.
The same transaction owns the ephemeral DbClient and all query work; no remote
capability is available during replay.

A filtered left join and a correlated include with a child limit have regression
coverage. TanStack chooses the driving scan for inner joins; that scan can still
be broad when its chosen source has no predicate. The includes compiler currently
requests correlated child keys through `IN` and applies the child limit in its
query execution; the observed child source request does not include that limit.
Forwarding actual demand does not establish that every relational operation or
per-parent limit is executed by the storage database. The proposed query IR still
provides portable query descriptions and the basis for additional pushdown.
