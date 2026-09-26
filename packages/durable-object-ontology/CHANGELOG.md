# @party-stack/durable-object-ontology

## 0.2.13

### Patch Changes

- Updated dependencies [43dd60e]
    - @party-stack/ontology@0.18.0
    - @party-stack/sqlite-ontology@0.6.11

## 0.2.12

### Patch Changes

- Updated dependencies [0e5e6d3]
    - @party-stack/ontology@0.17.0
    - @party-stack/sqlite-ontology@0.6.10

## 0.2.11

### Patch Changes

- d1a1805: Upgrade the TanStack DB ecosystem, including DB 0.9.2, React DB 0.4.1, query DB collection 1.2.15, and SQLite persistence 0.2.23. Foundry and remote subset loads now propagate cancellation without sharing abortable transports.
- Updated dependencies [d1a1805]
    - @party-stack/ontology@0.16.8
    - @party-stack/sqlite-ontology@0.6.9

## 0.2.10

### Patch Changes

- Updated dependencies [c545376]
    - @party-stack/ontology@0.16.7
    - @party-stack/sqlite-ontology@0.6.8

## 0.2.9

### Patch Changes

- 316b641: Downgrade TanStack DB and its adapters to the versions used by the working Streamline development environment.
- Updated dependencies [316b641]
    - @party-stack/ontology@0.16.6
    - @party-stack/sqlite-ontology@0.6.7

## 0.2.8

### Patch Changes

- 6e2e337: downgrade db deps
- Updated dependencies [6e2e337]
    - @party-stack/sqlite-ontology@0.6.6
    - @party-stack/ontology@0.16.5

## 0.2.7

### Patch Changes

- cd0b360: improve salesforce integration, fix outbox settlement + handle missing pks
- Updated dependencies [cd0b360]
    - @party-stack/sqlite-ontology@0.6.5
    - @party-stack/ontology@0.16.4

## 0.2.6

### Patch Changes

- 81d897a: update db deps + start handling contains pushdown in foundry
- Updated dependencies [81d897a]
- Updated dependencies [d2e1dbd]
    - @party-stack/sqlite-ontology@0.6.4
    - @party-stack/ontology@0.16.3

## 0.2.5

### Patch Changes

- Updated dependencies [98faee7]
    - @party-stack/sqlite-ontology@0.6.3
    - @party-stack/ontology@0.16.2

## 0.2.4

### Patch Changes

- Updated dependencies [c366eb9]
    - @party-stack/ontology@0.16.1
    - @party-stack/sqlite-ontology@0.6.2

## 0.2.3

### Patch Changes

- Updated dependencies [2538365]
    - @party-stack/ontology@0.16.0
    - @party-stack/sqlite-ontology@0.6.1

## 0.2.2

### Patch Changes

- Updated dependencies [81d84bb]
    - @party-stack/sqlite-ontology@0.6.0
    - @party-stack/ontology@0.15.0

## 0.2.1

### Patch Changes

- Updated dependencies [05ff1a7]
    - @party-stack/ontology@0.14.0
    - @party-stack/sqlite-ontology@0.5.1

## 0.2.0

### Minor Changes

- 8791727: Add a portable authoritative SQLite ontology backend with injectable attachment
  bytes, plus a Durable Object wrapper that binds SQLite and R2 with shared
  better-sqlite3/workerd conformance coverage.

### Patch Changes

- Updated dependencies [8791727]
    - @party-stack/ontology@0.13.2
    - @party-stack/sqlite-ontology@0.5.0
