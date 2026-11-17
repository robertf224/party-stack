---
"@party-stack/ontology-backend": patch
"@party-stack/ontology-replica": patch
"@party-stack/foundry-ontology": patch
---

Watches can report row changes instead of only invalidating. An adapter's watch may
emit `{ changes }` with `put` (the complete row), `exit` (left the subset; the replica
reads it back by primary key to tell a change from a deletion) and `delete`. The
replica applies them without reloading the subset, but holds them while one of its own
actions is in flight or awaiting read-back, and reloads instead.

Foundry watches report object updates as puts (Foundry sends every property with a
value) and removals as exits. Reference updates and anything that cannot be decoded
remain invalidation hints.
