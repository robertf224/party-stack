---
"@party-stack/ontology-storage": minor
"@party-stack/ontology-backend": minor
"@party-stack/sql-ontology-storage": minor
"@party-stack/ontology-replica": minor
"@party-stack/ontology": minor
"@party-stack/better-auth": minor
"@party-stack/foundry-ontology": minor
"@party-stack/salesforce-ontology": minor
"@party-stack/ontology-devtools": minor
---

**Breaking:** storage filters are now ontology-spec expressions. `Query.where` is a spec `Expression` from a validated subset over the `row` binding (`rowBinding`): row fields (`getAt` paths), literals, `length` of a field, eq/ne/lt/lte/gt/gte, `in` with a literal list, `contains`, `like`/`ilike`, and/or/not. The separate `Predicate` AST (`{ op, left, right }`) and its `Operand` type are removed; use the `Filter` type. The `eq`, `inArray`, `and`, … helpers keep their signatures and now build spec expressions, and `filterOperand`, `filterField`, `inValues`, `rebindFilter` and `mapFilterFields` read or rewrite them. `isEmpty` is removed: use `eq(length(field("tags")), 0)`, which also matches a missing list.

Spec `length` now lowers to storage `length` for any comparison and bound, on list and string fields, instead of only as an emptiness test rewritten to `isEmpty`. SQL storage compiles an emptiness test of a list (`= 0`, `> 0`, …) from its multi-entry projection; IndexedDB and memory storage evaluate `length` on rows. Foundry sends `length(array) == 0` (and `< 1`, `<= 0`) as `isNull`, and `> 0` (`>= 1`) as its negation, both exact.

`compileObjectSubset` now validates and normalizes a subset's filter into the storage subset instead of translating it, and `objectSubset` and policy planning embed storage filters back into spec subsets by renaming the binding. Replicas drop persisted coverage and action-retention records whose filters predate this format when they open.
