# Query pushdown diagnostics

Updated October 21, 2026.

A query has two translation boundaries: the consumer's TanStack expression into
our portable subset IR, then the adapter's subset into provider operations. The
inspector keeps the original per-source expression visible and explains both
stages inside Pushdown. This does not yet represent an entire hierarchical query.

## Report contract

`BackendSnapshot.pushdown` optionally carries `SourceQueryPlan`. The same report
travels with the retained replica load diagnostic through the read-only RPC. It
annotates the request's existing `query.where` tree, rather than sending a second
expression language. Paths are AND/OR child indices and NOT child 0; the empty path
addresses a leaf at the root. These paths refer to the original tree even when the
UI flattens adjacent AND groups.

Each leaf can report:

- `source`: a native condition evaluates this predicate.
- `candidate`: a native condition narrows candidates; the adapter finishes exact evaluation.
- `adapter`: no effective source condition; the adapter evaluates it after loading.

An omitted leaf is unknown. Rendering must not infer unsupported or exact execution
from absence. An OR with an unsupported branch cannot safely send just its other
branch; the annotations describe effective execution, not isolated operator support.
Sorting and pagination report `source`, `adapter`, or `none`, independently. The
`rechecksFilter` flag makes redundant verification explicit even for native terms.
Optional `{ language, text }` native syntax is opaque inspection data. Devtools
never parse Foundry JSON or SQL to reconstruct a portable predicate.

The Foundry adapter reports the same candidate translation used for searches and
watches. LIKE/ILIKE and ranges remain candidate predicates; exact adapter filtering
precedes ordering and pagination. Equality, IN and scalar array membership have
native conditions. Negation, field comparisons and unsafe OR fragments remain local.
Other adapters may omit a report; the inspector says so without guessing.

These are reports of actual request execution, not optimizer proofs. Replica
coverage and result correctness still rely on the snapshot/query contract; a plan
must not authorize dropping residual checks or moving a LIMIT across a residual.
A future planner capability API can use similar categories, but needs semantic
contracts and conformance tests before changing execution.

## Prior art and design rationale

[DataFusion table providers](https://datafusion.apache.org/library-user-guide/custom-table-providers.html)
report Exact, Inexact or Unsupported per filter. Inexact preserves an engine-side
filter. This is the closest model for distinguishing native evaluation from
candidate reduction. Our diagnostic categories mirror the distinction without
letting a UI report alter execution.

[Trustfall VertexInfo](https://docs.rs/trustfall/latest/trustfall/provider/trait.VertexInfo.html)
provides static candidate constraints and dynamic constraints resolved from prior
query context. This suggests a useful future direction for correlated relationship
loads: expose usable constraints to adapters rather than forcing broad resolution.
Its hints are distinct from an adapter declaring exact filter evaluation.

[SQLite virtual tables](https://www.sqlite.org/vtab.html#outputs)
separate consumed constraints from ordering, and let a provider declare that a
constraint needs no engine recheck. That separation supports reporting filter,
ordering and pagination independently instead of a single pushdown boolean.

## Counts and limits

The requested limit is a query clause. Source-response and delivered-row counts
are request metrics, not collection sizes or storage scan counts. The latest exact
request is shown; diagnostics never fabricate an execution chain from unrelated
loads. A missing exact request can result from covering cache state, a broader
load, or buffer eviction, and should not be called a cache hit without evidence.
