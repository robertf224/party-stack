# Exact ordered-prefix capability

This is a proposed upstream change and the contract implemented by the local DB
patch. The upstream proposal is filed as [TanStack DB #2398](https://github.com/TanStack/db/issues/2398).

## Problem

The ordered source loader currently requests a finite page, then separately loads
every row equal to its leading sort value. A boolean leading field can therefore
turn a 51-row page into a 1,400-row acquisition. A leading `Temporal.Instant`
cannot form the existing scalar cursor, so it instead triggers a full-source
request without ordering or a limit.

A deterministic regression reproduces the current Notes query:

```ts
q.from({ note: notes })
    .where(({ note }) => eq(note.trashed, true))
    .orderBy(({ note }) => note.updatedAt, "desc")
    .orderBy(({ note }) => note.id, "asc")
    .limit(51);
```

The released package acquires `[51, 1400]`; the candidate acquires `[51]` with the
same results. Source, published ESM and published CJS variants pass that oracle.

## Proposed public contract

```ts
interface SyncConfig {
    supportsOrderedWindow?: (options: LoadSubsetOptions) => boolean;
}
```

Core supplies the normalized source WHERE, complete resolved ORDER BY and initial
finite prefix size. The callback is pure. Returning `true` is a semantic promise
for every finite prefix of that fixed WHERE/ORDER, including larger windows and
optimistic headroom. It must not depend on the particular initial limit.

The adapter promises:

- Its complete filter and ordering are exact, or it conservatively supplies every
  row needed for that exact prefix.
- Each ordered field has a homogeneous comparison domain matching DB's comparator.
- The final sort term is a unique, non-null key.
- Refetch preserves the served full-order prefix or reports an ordering invalidation.

The declaration establishes no freshness, completeness of an entire collection,
or readiness. Applied receipts, ownership, cancellation and failure rules remain
unchanged. An absent or declined declaration retains existing behavior.

## Implementation

Only direct source plans qualify. Core rejects joins, residual or functional
filters, computed sorts, groups, distinct and unions before asking the adapter.
For admitted plans, the existing loader:

1. Acquires a full-order prefix from offset zero using `requestSnapshot`.
2. Compares installed boundaries and sort-changing updates using every sort term.
3. Skips the leading-value tie acquisition.
4. Reuses its existing bounded repair, optimistic refill, receipt, retry and release paths.

Growth initially rereads a larger prefix, such as 51 → 101. This repeats some
provider work, but avoids changing cursor predicates or equality semantics. There
is no composite cursor, new index or additional result cache. A leading-only index
is never treated as a composite cursor index. An admitted window moved to a
negative offset, or incompatible admission across merged metadata views, uses the
established full-source fallback.

Party Stack derives admission from its ontology IR: exact filter/order analysis,
resolved scalar families, lexical string collation and a non-optional final
primary key. Optional non-key values retain explicit null placement. Unknown or
mixed domains, unsupported fields and custom/locale collation are declined.
Cached row samples cannot prove the declaration.

## Validation and upstreaming

Repository regressions cover typed admission, the timestamp-first query above,
boolean-leading ordering, window movement, negative offsets, mixed-domain and
missing-key fallback, deletes, trailing-sort changes, optimistic rollback and
confirmation, explicit invalidation, late receipts, retry and scoped cancellation.
The prototype additionally checks ascending/descending and null placement across
primitive, Instant and PlainDate domains against independent full-sort oracles,
and incompatible merged-source admission.

Before upstream acceptance, run DB's full ordered-loading, lifecycle, publication,
replay and optimistic oracle suites. The local patch changes three modules and
their distributed runtime/declaration equivalents. Published Party Stack consumers
do not inherit workspace pnpm patches; an upstream release is the distribution path.

Related reports: [boundary wait #2166](https://github.com/TanStack/db/issues/2166),
[leading-column pagination #1893](https://github.com/TanStack/db/pull/1893), and
[composite ordering #416](https://github.com/TanStack/db/issues/416).
