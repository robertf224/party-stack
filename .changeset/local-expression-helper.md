---
"@party-stack/ontology-spec": minor
"@party-stack/ontology": minor
---

Rename the expression helper from `row(name)` to `local(name)`, matching the
underlying `localReference` expression. The helper can reference any locally
bound value, including query rows and scalar map items.

Update related query sources to `related(local("project"), "issues")`.
`related` still accepts an expression; query sources currently require an ancestor
local binding. The generated IR is unchanged, including persisted pin definitions.
