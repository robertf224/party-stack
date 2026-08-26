# foundry-ontology

Foundry adapter and metadata conversion for Party Stack LiveOntology.

## Link metadata

- Only FK-backed Foundry links are converted into Party Stack IR.
- Non-FK / object-backed links are omitted (unsupported; no synthetic FK).

## Action metadata

Uses public Foundry APIs (`ActionTypesV2` / `ActionTypesFullMetadata`):

- Action parameter and type conversion
- Full logic-rule conversion
- Synthetic UUID / current-time default parameters from public logic metadata

OMS UI edit-prefill metadata is not available from public APIs and is not converted.
