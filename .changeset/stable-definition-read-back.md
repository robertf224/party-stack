---
"@party-stack/ontology-spec": patch
"@party-stack/ontology-storage": patch
"@party-stack/ontology-backend": patch
"@party-stack/ontology-replica": patch
"@party-stack/ontology-server": patch
"@party-stack/foundry-ontology": patch
"@party-stack/connect": patch
---

Keep definition hashes stable, report why a definition cannot load, and compare values through the value codec.

- Copying a definition no longer turns its literal values (such as a `Temporal.PlainDate` default) into empty objects. A route's `meta` resource served such a copy, so a client that read the definition back from it could never match the described hash and kept describing the route again. `cloneDefinition` copies a definition's structure and keeps its values.
- Definition and contract hashes ignore the order of named fields: struct fields wherever a definition declares types, object type properties, and action and query function parameters. A provider that lists them in a different order on each request (Foundry does, for struct parameters) no longer changes the definition between pulls, which made replicas report a changed definition and views go stale. The definition keeps the provider's order for display.
- A dynamic definition whose metadata never synced, and cannot sync because the connection needs sign-in, is not active, or the device is offline, now fails with `Unauthenticated` or `Unavailable` saying so, instead of reporting malformed metadata. A definition source that throws fails the open instead of leaving it waiting.
- Pulled definitions that are omitted are logged with the reason, and type mismatches name both types ("is a string, but the property is a geopoint").
- Connect retries an interrupted token refresh with the saved refresh token instead of asking for a sign-in, and a refresh that times out keeps the session for a later attempt. Only a provider's rejection asks for a sign-in.
- Foundry submission criteria compare a draft's values in Foundry's form (a date is `"2026-11-20"`); a value that is not plain data leaves its criterion unknown instead of comparing it field by field.
- A retained replica bootstrap matches its context whatever order the app wrote the context's fields in, so it reopens offline. Endpoint, record and delivery-selection identities go through the value codec, so dates, bigints, maps, sets and `undefined` are kept distinct.
