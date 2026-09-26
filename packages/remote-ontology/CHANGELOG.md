# @party-stack/remote-ontology

## 0.9.1

### Patch Changes

- Updated dependencies [43dd60e]
    - @party-stack/ontology@0.18.0

## 0.9.0

### Minor Changes

- 0e5e6d3: add non-live backend adapter mode for request-scoped ontology operations

### Patch Changes

- Updated dependencies [0e5e6d3]
    - @party-stack/ontology@0.17.0

## 0.8.9

### Patch Changes

- d1a1805: Upgrade the TanStack DB ecosystem, including DB 0.9.2, React DB 0.4.1, query DB collection 1.2.15, and SQLite persistence 0.2.23. Foundry and remote subset loads now propagate cancellation without sharing abortable transports.
- Updated dependencies [d1a1805]
    - @party-stack/ontology@0.16.8
    - @party-stack/runtime@0.3.7

## 0.8.8

### Patch Changes

- 2a59375: fix safari multipart issue with opfs

## 0.8.7

### Patch Changes

- c545376: Allow live ontology attachment creation to use an existing opaque ID and use it to stage remote multipart uploads while preserving file metadata and canonical attachment ID mappings.
- Updated dependencies [c545376]
    - @party-stack/ontology@0.16.7

## 0.8.6

### Patch Changes

- 316b641: Downgrade TanStack DB and its adapters to the versions used by the working Streamline development environment.
- Updated dependencies [316b641]
    - @party-stack/ontology@0.16.6
    - @party-stack/runtime@0.3.6

## 0.8.5

### Patch Changes

- 6e2e337: downgrade db deps
- Updated dependencies [6e2e337]
    - @party-stack/ontology@0.16.5
    - @party-stack/runtime@0.3.5

## 0.8.4

### Patch Changes

- cd0b360: improve salesforce integration, fix outbox settlement + handle missing pks
- Updated dependencies [cd0b360]
    - @party-stack/ontology@0.16.4
    - @party-stack/runtime@0.3.4

## 0.8.3

### Patch Changes

- 81d897a: update db deps + start handling contains pushdown in foundry
- Updated dependencies [81d897a]
- Updated dependencies [d2e1dbd]
    - @party-stack/ontology@0.16.3
    - @party-stack/runtime@0.3.3

## 0.8.2

### Patch Changes

- 98faee7: fix authoritative action param resolution, foundry codec issues, and foundry sync resolution
- Updated dependencies [98faee7]
    - @party-stack/ontology@0.16.2

## 0.8.1

### Patch Changes

- Updated dependencies [c366eb9]
    - @party-stack/ontology@0.16.1

## 0.8.0

### Minor Changes

- 671e3f8: Add secure HTTP and in-process action-parameter resolution with server-owned fixed parameters.

## 0.7.1

### Patch Changes

- Updated dependencies [2538365]
    - @party-stack/ontology@0.16.0

## 0.7.0

### Minor Changes

- 81d84bb: Rename expression inputs to `inputReference`, promote UUID and current-time expressions to direct variants, convert Foundry list-of-struct action assignments with backend-neutral map and struct expressions, and safely apply structured property changes to sparse objects.

### Patch Changes

- Updated dependencies [81d84bb]
    - @party-stack/ontology@0.15.0

## 0.6.0

### Minor Changes

- 05ff1a7: add server-authoritative validation hooks

### Patch Changes

- Updated dependencies [05ff1a7]
    - @party-stack/ontology@0.14.0

## 0.5.5

### Patch Changes

- Updated dependencies [8791727]
    - @party-stack/ontology@0.13.2

## 0.5.4

### Patch Changes

- 52d8adc: fix remote workflows
- Updated dependencies [52d8adc]
    - @party-stack/ontology@0.13.1
    - @party-stack/runtime@0.3.2

## 0.5.3

### Patch Changes

- 07fbbce: Convert Foundry OMS parameter prefills into provider-neutral action defaults and preserve string constraints and suggestions.
- Updated dependencies [07fbbce]
    - @party-stack/ontology@0.13.0

## 0.5.2

### Patch Changes

- 45bcf88: upgrade tanstack db deps
- Updated dependencies [45bcf88]
    - @party-stack/ontology@0.12.1
    - @party-stack/runtime@0.3.1

## 0.5.1

### Patch Changes

- Updated dependencies [b8fb08e]
    - @party-stack/ontology@0.12.0

## 0.5.0

### Minor Changes

- 33f6858: auth + connections

### Patch Changes

- Updated dependencies [33f6858]
    - @party-stack/ontology@0.11.0
    - @party-stack/runtime@0.3.0

## 0.4.0

### Minor Changes

- 46268bc: Keep collection readiness helpers internal, scope action refresh metadata to remote ontology, and derive secured schema projection directly from policy configuration.

### Patch Changes

- Updated dependencies [46268bc]
    - @party-stack/ontology@0.10.0

## 0.3.0

### Minor Changes

- 515f8dc: OSDK-free LiveOntology Gateway MVP: collection readiness and race-safe cleanup, non-blocking action refresh, structured remote errors, policy-aware describe projection, precise invalidation, attachments, and public Foundry action metadata. No generic link traversal, object-query helpers, or OMS/prefill metadata.

### Patch Changes

- Updated dependencies [515f8dc]
    - @party-stack/ontology@0.9.0

## 0.2.0

### Minor Changes

- a973080: add attachment constraints + metadata selection

### Patch Changes

- Updated dependencies [a973080]
    - @party-stack/ontology@0.8.0

## 0.1.3

### Patch Changes

- Updated dependencies [fe9443e]
    - @party-stack/ontology@0.7.0

## 0.1.2

### Patch Changes

- Updated dependencies [1842e6c]
    - @party-stack/ontology@0.6.0

## 0.1.1

### Patch Changes

- Updated dependencies [5bdc4be]
    - @party-stack/ontology@0.5.0

## 0.1.0

### Minor Changes

- 803610f: the big revamp

### Patch Changes

- Updated dependencies [803610f]
    - @party-stack/ontology@0.4.0
    - @party-stack/runtime@0.2.0
