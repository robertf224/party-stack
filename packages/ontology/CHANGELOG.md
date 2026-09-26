# @party-stack/ontology

## 0.18.0

### Minor Changes

- 43dd60e: Add provider-neutral icon descriptors, canonical provider mappings and renderers, and ontology icon metadata conversion for Foundry and Salesforce.

### Patch Changes

- Updated dependencies [43dd60e]
    - @party-stack/icons@0.2.0

## 0.17.0

### Minor Changes

- 0e5e6d3: add non-live backend adapter mode for request-scoped ontology operations

## 0.16.8

### Patch Changes

- d1a1805: Upgrade the TanStack DB ecosystem, including DB 0.9.2, React DB 0.4.1, query DB collection 1.2.15, and SQLite persistence 0.2.23. Foundry and remote subset loads now propagate cancellation without sharing abortable transports.
- Updated dependencies [d1a1805]
    - @party-stack/blobs@0.5.7
    - @party-stack/connections@0.2.7
    - @party-stack/node-runtime@0.2.7
    - @party-stack/runtime@0.3.7

## 0.16.7

### Patch Changes

- c545376: Allow live ontology attachment creation to use an existing opaque ID and use it to stage remote multipart uploads while preserving file metadata and canonical attachment ID mappings.

## 0.16.6

### Patch Changes

- 316b641: Downgrade TanStack DB and its adapters to the versions used by the working Streamline development environment.
- Updated dependencies [316b641]
    - @party-stack/blobs@0.5.6
    - @party-stack/connections@0.2.6
    - @party-stack/node-runtime@0.2.6
    - @party-stack/runtime@0.3.6

## 0.16.5

### Patch Changes

- 6e2e337: downgrade db deps
- Updated dependencies [6e2e337]
    - @party-stack/node-runtime@0.2.5
    - @party-stack/connections@0.2.5
    - @party-stack/runtime@0.3.5
    - @party-stack/blobs@0.5.5

## 0.16.4

### Patch Changes

- cd0b360: improve salesforce integration, fix outbox settlement + handle missing pks
- Updated dependencies [cd0b360]
    - @party-stack/blobs@0.5.4
    - @party-stack/connections@0.2.4
    - @party-stack/node-runtime@0.2.4
    - @party-stack/runtime@0.3.4

## 0.16.3

### Patch Changes

- 81d897a: update db deps + start handling contains pushdown in foundry
- d2e1dbd: clarify attachment id contract + fix foundry impl
- Updated dependencies [81d897a]
    - @party-stack/node-runtime@0.2.3
    - @party-stack/connections@0.2.3
    - @party-stack/runtime@0.3.3
    - @party-stack/blobs@0.5.3

## 0.16.2

### Patch Changes

- 98faee7: fix authoritative action param resolution, foundry codec issues, and foundry sync resolution

## 0.16.1

### Patch Changes

- c366eb9: fix foundry user loading, null handling, and object-set-watcher crashes

## 0.16.0

### Minor Changes

- 2538365: Expose action parameter default resolution on live ontology actions.

## 0.15.0

### Minor Changes

- 81d84bb: Rename expression inputs to `inputReference`, promote UUID and current-time expressions to direct variants, convert Foundry list-of-struct action assignments with backend-neutral map and struct expressions, and safely apply structured property changes to sparse objects.

## 0.14.0

### Minor Changes

- 05ff1a7: add server-authoritative validation hooks

## 0.13.2

### Patch Changes

- 8791727: Add a portable authoritative SQLite ontology backend with injectable attachment
  bytes, plus a Durable Object wrapper that binds SQLite and R2 with shared
  better-sqlite3/workerd conformance coverage.

## 0.13.1

### Patch Changes

- 52d8adc: fix remote workflows
- Updated dependencies [52d8adc]
    - @party-stack/runtime@0.3.2
    - @party-stack/blobs@0.5.2
    - @party-stack/connections@0.2.2
    - @party-stack/node-runtime@0.2.2

## 0.13.0

### Minor Changes

- 07fbbce: Convert Foundry OMS parameter prefills into provider-neutral action defaults and preserve string constraints and suggestions.

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
