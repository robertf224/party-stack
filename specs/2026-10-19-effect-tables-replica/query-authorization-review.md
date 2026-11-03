# Query IR and authorization review — November 3, 2026

This follows the [server/protocol review](./server-protocol-review.md). The first
pass covers the IR, finite executor, authorization rewrite/view, and server policy
binding. Builder ergonomics are being reviewed with concrete multi-root examples.

## Checklist

- [x] Inventory Query/Subset/Expression definitions and builder exports
- [x] Trace semantic validation, lexical bindings, windows and uncertainty
- [x] Inspect physical lowering, correlated batching and per-parent windows
- [x] Inspect hierarchical grants, guarded fields and rewrite barriers
- [x] Trace context specialization, public schemas and action parameter binding
- [x] Verify owned authorization shares the mutation transaction
- [x] Add focused regressions and compare with reference/eager/domain oracles
- [ ] Finish expression execution/typing alignment, including lookup on row fields
- [ ] Review builder ergonomics with application examples

## Current boundaries

`QueryDocument` is a multi-root selection document, with optional input definitions.
Each named `sub` supplies a source/binding, predicates, ordering/window and nested
selections. Query shares the Subset fields directly. Scalar `case` produces one
value; `selectCase` chooses a selection group. Entity-mode reads use the same IR
but require source property names rather than arbitrary computed aliases.

Finite execution lives in ontology-storage; ontology-backend supplies BackendError
boundaries. The server's projected reader enforces the policy on every scan,
including cache hits. Rule-based narrowing reduces compatible source reads;
caller ordering/pagination follows grant union and field masking. Windows and
singular cardinality remain rewrite barriers. Authorized readers omit grouped
window pushdown until it can preserve authorization-before-pagination semantics.

Owned action binding, checks, reference validation and mutation share one storage
transaction. A projected provider has separate gateway checks and a subsequent
provider-owned authoritative transaction. Check success does not grant arbitrary
query-function output safety; those implementations remain trusted capabilities.

## Reproduced and fixed

1. An existential policy check with an unknown draft input failed with Forbidden.
   EXISTS now tracks unknown candidates without treating them as false. A known
   matching row can prove true; no match with unknown candidates stays uncertain.
   Limit zero proves false. Projection and ordering are irrelevant to existence,
   except ordering used by a keyset cursor. Ordinary selection filters still fail
   closed, and action application still requires a known true check. Fast-check
   compares every certain answer with all possible concrete input completions in
   its generated domain, for planned and reference execution. A projected-server
   test verifies draft validation and rejected/successful application separately.
2. Logical list equality was lowered into scalar-only storage comparisons and
   failed instead of executing residually. Lowering now uses the existing declared
   field validator, including scalar-list requirements for CONTAINS. It receives
   the full source/binding, so it validates against the right source definition.
   Unsupported physical forms remain in the logical evaluator, with pagination
   applied afterward. Planned/reference regression verifies identical results.
3. Property discovery could overwrite an inner grant when nested bindings reused
   an object type, and missed ancestor fields selected inside child queries.
   Discovery now shares each type's upper-bound set before descending and resolves
   fields against lexical bindings. Ancestor fields granted through child matches
   stay conditional. Tests cover public schema projection, per-row field masking,
   and both optimized/eager policy views.

## State and failure observations

Executor row identities, grants, batching and lexical scopes are finite-call state;
they do not create retained query sessions. Policy views keep no cross-request
grant cache. Validation bounds query depth/nodes and issue count. Finite query
evaluation still has no universal read/work budget; eager/reference paths can
materialize broad selections. Streaming result execution and cost-based planning
remain separate future work, rather than silently truncating authorization reads.

Reader failures remain in the caller's typed Effect error channel. Unknown policy
checks are values, not transport failures. Malformed query definitions are
InvalidRequest; incomplete finite source snapshots are InvalidResponse. Denials
are projected at the server boundary, with public parameter issue filtering kept
separate from retry/outcome facts.

## Next checks

The validator accepts object-reference expressions beyond input/context references;
the executor's lookup type resolver currently handles fewer forms. Review that
alignment before calling the expression pass complete. Portable action-expression
execution also has a narrower supported set than finite queries; query-only and
shared scalar operations should be distinguished explicitly in that pass.

No new public query syntax or execution-strategy knob was introduced by these
correctness fixes. Route-level capability advertisement remains with installations;
byte-read ownership remains with attachments.

## Verification

The spec/storage/backend/server suites pass (117/45/83/86 tests respectively).
Full workspace `vp run ci` passed 133/133 tasks. The application-facing multi-root
dashboard and PostApproval examples were also checked with the actual semantic
validator against representative definitions. This is a review checkpoint; the
unchecked expression/builder items above remain open.
