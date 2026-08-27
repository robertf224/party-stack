# @party-stack/remote-ontology

HTTP remoting for LiveOntology with policy-aware describe/load/apply and structured errors.

## Describe projection

Describe retains the full object and link schema when no object-visibility
policy is configured. When `allowedObjectTypeProperties` or
`baseObjectTypeQueries` is configured, it automatically projects authorized
object types and properties, prunes broken links, hides actions and queries
that reference hidden types, and drops unreachable named types.

## Errors

Error responses use versioned envelopes (`v: 1`) with stable codes. Legacy `{ error: string }` bodies remain parseable by clients.
