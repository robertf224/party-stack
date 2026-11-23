---
"@party-stack/ontology-spec": minor
"@party-stack/ontology-backend": minor
"@party-stack/ontology-server": patch
"@party-stack/foundry-ontology": patch
---

Update and delete action logic can target a list of object references and applies the step to each referenced object, as Foundry's modify and delete rules do with object-list parameters. Foundry actions such as a bulk delete no longer make the whole pulled Ontology invalid.

`pull` now omits an action parameter default whose type doesn't fit its parameter (for example a Foundry string parameter prefilled from a geopoint property) and logs a warning, instead of rejecting the Ontology. The parameter keeps its type; the user enters the value. `omitIncompatibleActionDefaults` and the `IncompatibleDefault` issue code are exported from `@party-stack/ontology-spec`.
