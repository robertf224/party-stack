---
"@party-stack/ontology-spec": minor
"@party-stack/ontology-backend": minor
"@party-stack/ontology-server": minor
"@party-stack/foundry-ontology": patch
"@party-stack/ontology": patch
---

Update and delete action logic can target a list of object references and applies the step to each referenced object, as Foundry's modify and delete rules do with object-list parameters.

`validate` now checks the type of every value action logic writes to a property (issue code `IncompatibleAssignment`), using the same compatibility rule as parameter defaults. An object reference and its object type's primary-key type are interchangeable in both directions.

New `omitInvalid(ontology)` in `@party-stack/ontology-spec` drops whatever `validate` rejects and returns `{ ontology, omitted, issues }`. A default whose type doesn't fit its parameter loses only the default; any other issue drops the definition it sits under, and validation reruns so definitions depending on a dropped one go too. `issues` lists what omission cannot fix (for example an invalid policy).

**Breaking:** `pull` from `@party-stack/ontology-backend/meta` (and the `@party-stack/ontology` Promise facade) now resolves to `{ ontology, omitted }` instead of the IR. It runs `transformPulledOntology`, then `omitInvalid`, and fails only when issues remain. `loadDefinition` still resolves to the IR. The `ontology pull` CLI prints a warning for each omitted definition.

`makeOntologyServer` takes `startupErrors` to choose how a request that fails before its route is ready (for example a definition load failure) is reported. The default stays `"projected"`; an in-process server with trusted callers can pass `"forward"` to keep the original message.
