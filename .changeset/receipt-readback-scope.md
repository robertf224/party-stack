---
"@party-stack/ontology-replica": patch
"@party-stack/foundry-ontology": patch
---

Fix an action freezing a client by downloading whole object types it never read. When a receipt named a type without specific objects, confirmation read back that entire type, for every such type. Foundry receipts without edits named every type in the ontology, so one action on a broad ontology could download types of hundreds of thousands of objects.

A receipt now never loads data no reader asked for. For a type named without keys, the replica marks that type's stored coverage stale, so a later demand reloads it, and reads back only the subsets readers demand right now, so the action's effects still show without a gap. History recovery no longer reads whole types either.

The Foundry adapter always requests an action's edits, so a response without edits now means the action changed nothing (for example, an action with no logic), and nothing is read back.
