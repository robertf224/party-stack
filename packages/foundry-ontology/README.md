# foundry-ontology

Foundry adapter and metadata conversion for Party Stack LiveOntology.

## Metadata polling

Set `metaRefetchInterval` on a metadata-only route included in your Foundry installation:

```ts
createFoundryOntologyRoute({
    ontologyId: "ri.ontology.main.ontology.example",
    metaRefetchInterval: 30_000,
});
```

Calling `installation.openMetaOntology({ userId, ontologyId })` uses that route's
interval for native object/value/link metadata snapshots, action types, and
query function types. The interval is in milliseconds; `false` disables polling,
and omitting it preserves the default of no polling. Repeated opens return the
cached meta ontology with the same route configuration. Routes with supplied `ir`
project local metadata and do not poll Foundry.

You can also set `refetchInterval` directly on
`createFoundryMetaOntologyBackendAdapter` when creating a meta ontology without an
installation.

## Link metadata

- Only FK-backed Foundry links are converted into Party Stack IR.
- Non-FK / object-backed links are omitted (unsupported; no synthetic FK).

## Action metadata

Uses public Foundry APIs (`ActionTypesV2` / `ActionTypesFullMetadata`) for:

- Action parameter and type conversion
- Full logic-rule conversion
- Synthetic UUID / current-time default parameters from public logic metadata

Foundry UI prefills are loaded from the private OMS bulk metadata endpoint when
available. Static values and object-parameter property references become action
parameter defaults. Closed string one-of constraints and text regex constraints
are used when public metadata does not provide them. Open string one-of values
are preserved as suggestions. Object-query and struct-field prefills are omitted
until the expression model supports them, and failures from the private endpoint
do not prevent public action metadata from loading.

## Native backend integration

Object, metadata, and Admin Users reads use the native backend's Effect-valued
`loadSubset` interface. Replica owns demand, persistent rows, action receipts,
confirmation reads, and optimistic state; TanStack collections materialize that
state for applications. Provider collection-option helpers are no longer exported.

The Foundry backend uses the scoped Effect object-set watcher. Watch messages are
invalidation hints; Replica refreshes the affected demand. They do not establish a
durable edits-history cursor. Actions save receipts before confirmation reads, so
a failed read does not cause the action to be submitted again.
