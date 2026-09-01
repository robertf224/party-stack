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
available. Static values and object-parameter property references become action
parameter defaults. Closed string one-of constraints and text regex constraints
are used when public metadata does not provide them. Open string one-of values
are preserved as suggestions. Object-query and struct-field prefills are omitted
until the expression model supports them, and failures from the private endpoint
do not prevent public action metadata from loading.
