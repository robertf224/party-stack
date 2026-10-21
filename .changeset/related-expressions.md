---
"@party-stack/ontology-spec": minor
"@party-stack/ontology": minor
"@party-stack/ontology-server": minor
---

Rename the linkHop expression and its helpers to related. Validate both to-one
object results and to-many object lists, preserving target object types through
map bindings and nested traversal. Correct reverse-name inference for self-links.
Keep action execution limited to to-one relationships with an explicit unsupported
error for to-many execution.
