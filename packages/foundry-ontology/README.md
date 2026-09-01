# foundry-ontology

Foundry adapter and metadata conversion for Party Stack LiveOntology.

## Link metadata

- Only FK-backed Foundry links are converted into Party Stack IR.
- Non-FK / object-backed links are omitted (unsupported; no synthetic FK).

## Action metadata

Uses public Foundry APIs (`ActionTypesV2` / `ActionTypesFullMetadata`) for:

- Action parameter and type conversion
- Full logic-rule conversion
- Synthetic UUID / current-time default parameters from public logic metadata

Foundry UI prefills are loaded from the private OMS bulk metadata endpoint when
available. Static values and object-parameter property references are converted
to portable action-parameter prefills. OMS object-query prefills are preserved
as an explicitly Foundry-specific metadata variant for compatible consumers.
Failures from the private endpoint do not prevent public action metadata from
loading.
