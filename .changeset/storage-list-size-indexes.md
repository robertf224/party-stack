---
"@party-stack/ontology-storage": minor
"@party-stack/sql-ontology-storage": minor
"@party-stack/ontology-backend": patch
"@party-stack/ontology-replica": patch
"@party-stack/better-auth": patch
---

Fix demand failing with "Index values must be queryable scalars" when a filter checks a list property for a missing value (for example `isUndefined(token.allowedFormIds)`). Since 0.2.2, such checks pushed down exactly, and lazy query indexes then requested a scalar index on the list. `indexesForQuery(query, ir, objectType)` now takes the object type and fits each index to the property: a scalar index for a scalar (missing-value checks included), an element index for `contains`, and a size index for a list. It never requests a scalar index for a list or struct.

New list size indexes (`{ name, field, size: true }`) key each row once by its list's element count, and a missing list by the missing value. One index answers a list's `isUndefined`, `ne(list, undefined)` and every `length` comparison, in memory, IndexedDB and SQL storage, instead of scanning rows. The planner also negates comparisons under `not`, so `not(isUndefined(list))` uses the same index.
