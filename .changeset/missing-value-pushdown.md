---
"@party-stack/ontology-spec": patch
"@party-stack/ontology-storage": patch
"@party-stack/ontology-server": patch
"@party-stack/ontology": patch
"@party-stack/ontology-backend": patch
"@party-stack/foundry-ontology": patch
"@party-stack/sql-ontology-storage": patch
"@party-stack/better-auth": patch
"@party-stack/ontology-devtools": patch
---

Missing-value and empty-list checks push down exactly instead of forcing query-result demand. `isUndefined`/`isNull` work on every field type, including lists and structs. The query language gains a `length` expression (lists and strings; a missing value has length 0, as in TanStack DB), and TanStack's `length(list)` passes through to it. Storage accepts `length` only as an emptiness test (`length(list)` compared with 0 or 1), which it lowers to "missing or empty" with a new `isEmpty` predicate; other uses still need query-result demand.

Foundry filters were checked against the search API and corrected: `like`/`ilike` no longer sends term searches that dropped rows for substrings inside words, or leading wildcards that failed with a server error; a pattern that starts with a word is sent as a token-prefix wildcard. Ranges, `ne` and negations of exact filters are now sent exactly, and on arrays `isNull` answers "missing or empty".
