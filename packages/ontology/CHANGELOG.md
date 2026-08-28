# @party-stack/ontology

## 0.12.1

### Patch Changes

- 45bcf88: upgrade tanstack db deps
- Updated dependencies [45bcf88]
    - @party-stack/node-runtime@0.2.1
    - @party-stack/connections@0.2.1
    - @party-stack/runtime@0.3.1
    - @party-stack/blobs@0.5.1

## 0.12.0

### Minor Changes

- b8fb08e: node runtime + add meta ontology to installations

### Patch Changes

- Updated dependencies [b8fb08e]
    - @party-stack/node-runtime@0.2.0

## 0.11.0

### Minor Changes

- 33f6858: auth + connections

### Patch Changes

- Updated dependencies [33f6858]
    - @party-stack/connections@0.2.0
    - @party-stack/runtime@0.3.0
    - @party-stack/errors@0.2.0
    - @party-stack/blobs@0.5.0

## 0.10.0

### Minor Changes

- 46268bc: Keep collection readiness helpers internal, scope action refresh metadata to remote ontology, and derive secured schema projection directly from policy configuration.

## 0.9.0

### Minor Changes

- 515f8dc: OSDK-free LiveOntology Gateway MVP: collection readiness and race-safe cleanup, non-blocking action refresh, structured remote errors, policy-aware describe projection, precise invalidation, attachments, and public Foundry action metadata. No generic link traversal, object-query helpers, or OMS/prefill metadata.

### Patch Changes

- Updated dependencies [515f8dc]
    - @party-stack/blobs@0.4.1

## 0.8.0

### Minor Changes

- a973080: add attachment constraints + metadata selection

### Patch Changes

- Updated dependencies [a973080]
    - @party-stack/blobs@0.4.0

## 0.7.0

### Minor Changes

- fe9443e: Add required action type identifiers to runtime metadata while keeping portable action definitions provider-neutral.

    Map Foundry action type RIDs into runtime metadata and support filtering the ActionType collection by ID.

## 0.6.0

### Minor Changes

- 1842e6c: Add required object and property identifiers plus title property metadata to runtime object metadata, while keeping portable ontology definitions provider-neutral.

    Map Foundry object and property RIDs into runtime metadata so downstream TanStack queries can filter the shared ontology metadata snapshot by ID.

## 0.5.0

### Minor Changes

- 5bdc4be: improve devtools

## 0.4.0

### Minor Changes

- 803610f: the big revamp

### Patch Changes

- Updated dependencies [803610f]
    - @party-stack/runtime@0.2.0
    - @party-stack/blobs@0.3.0

## 0.3.0

### Minor Changes

- 2ee9520: introduce attachments

### Patch Changes

- Updated dependencies [2ee9520]
    - @party-stack/schema@0.3.0
    - @party-stack/blobs@0.2.0

## 0.2.0

### Minor Changes

- 61724f7: actions

### Patch Changes

- Updated dependencies [61724f7]
    - @party-stack/schema@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [611c3c0]
    - @party-stack/schema@0.1.1

## 0.1.0

### Minor Changes

- 020b42a: initial release

### Patch Changes

- Updated dependencies [020b42a]
    - @party-stack/schema@0.1.0
