---
"@party-stack/ontology-spec": minor
"@party-stack/ontology-backend": minor
"@party-stack/ontology-server": minor
"@party-stack/ontology-replica": minor
"@party-stack/foundry-ontology": patch
"@party-stack/ontology": patch
---

Update and delete action logic can target a list of object references and applies the step to each referenced object, as Foundry's modify and delete rules do with object-list parameters.

`validate` now checks the type of every value action logic writes to a property (issue code `IncompatibleAssignment`), using the same compatibility rule as parameter defaults. An object reference and its object type's primary-key type are interchangeable in both directions.

New `omitInvalid(ontology)` in `@party-stack/ontology-spec` drops whatever `validate` rejects and returns `{ ontology, omitted, issues }`. A default whose type doesn't fit its parameter loses only the default; any other issue drops the definition it sits under, and validation reruns so definitions depending on a dropped one go too. `issues` lists what omission cannot fix (for example an invalid policy).

`pull` from `@party-stack/ontology-backend/meta` (and the `@party-stack/ontology` Promise facade) runs `transformPulledOntology`, then `omitInvalid`, and fails only when issues remain. It still resolves to the IR and logs what it omitted; pass `includeOmitted: true` to resolve to `{ ontology, omitted }` instead. The `ontology pull` CLI prints a warning for each omitted definition.

**Breaking:** a route that acquires its backend is now declared as `{ authenticate?, dangerouslyAllowInternalAccess?, open }` instead of a bare function or Effect. `open` returns the backend and binding, and can no longer return `authenticate` or `dangerouslyAllowInternalAccess` (a type error). Static bindings are unchanged. Each request is authenticated before the route opens, so unauthenticated requests no longer open routes. When opening fails (for example a definition load failure), a caller allowed internal access (`true`, or a predicate over the context from `authenticate`) gets the original error; others get the generic message. Replica routes require `true`.

Replicas take `onDefinitionChange: "reset" | "error"` (default `"error"`). With `"reset"`, a replica opened with a definition whose contract differs from its stored cache clears the cached rows, coverage and delivery state instead of failing with `SchemaMismatch`; the outbox, receipts and every pin's desired query are kept, so pinned data is fetched again. It fails with `Conflict` while actions are pending. A reset (including a server-managed rebuild) now also clears each named pin's membership and bytes, not only the default pin's.

**Breaking:** managed replica routes drop `definition: { ir?, onIncompatible? }`. Use the replica's `onDefinitionChange: "reset"` in place of `onIncompatible: "rebuild"`, and, on an upstream route, a top-level `ir` for the application contract. `ReplicaDefinitionOptions` is no longer exported.
