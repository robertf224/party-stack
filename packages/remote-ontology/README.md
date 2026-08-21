# @party-stack/remote-ontology

HTTP remoting for LiveOntology with policy-aware describe/load/apply and structured errors.

## Describe projection

`projectRemoteOntologyIR` supports:

- `projectionMode: "legacy"` — historical behavior (full object/link schema; action fixed-parameter projection)
- `projectionMode: "authorized"` — project object types/properties, prune broken links, hide actions/queries that reference hidden types, and drop unreachable named types

When `allowedObjectTypeProperties` or `baseObjectTypeQueries` is configured, describe defaults to `authorized`.

## Errors

Error responses use versioned envelopes (`v: 1`) with stable codes. Legacy `{ error: string }` bodies remain parseable by clients.
