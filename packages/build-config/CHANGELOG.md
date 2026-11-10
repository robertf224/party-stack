# @party-stack/build-config

## 0.2.0

### Minor Changes

- 92480df: Add Effect-based transactional Tables with portable JavaScript/bigint/Temporal values,
  native SQL / user-space IndexedDB indexes, subset queries, and separate sparse-overlay composition.
  Provide IndexedDB, in-memory, and SQLite/PostgreSQL implementations with a shared conformance contract.
  Add an opt-in Effect library build/TypeScript preset and workspace development tooling.

    Port these experimental packages to ontology-storage, sql-ontology-storage, and
    indexeddb-ontology-storage. Add an ontology-derived object API with generated codecs,
    primary-key derivation, validated scalar paths, definition-drift guards, and native
    transactions. Keep the raw engine under explicit infrastructure exports. Document
    independent attachment-byte and replica-row retention without adding automatic GC.

    Allow storage models to derive codecs directly from ontology IR while retaining
    generated schemas for statically typed models.

### Patch Changes

- ca220d2: Replace the SQLite ontology attachment coordinator with shared transactional blob
  storage and a common owned backend composition. Remove the sqlite-ontology package.
  Rename durable-object-ontology to durable-object-ontology-storage and consolidate
  its R2 implementation on Alchemy's client, with separate storage bridges and an
  Alchemy constructor/resource example. Verify interrupted write/reader recovery with
  real local Durable Object resets.

    Stream attachment helper transfers over Effect RPC with scoped upload ownership,
    bounded acknowledged chunks, size/sequence validation and cancellation. Support
    source-only backend attachment/query helpers without constructing LiveOntology.
    Keep Effect test aliases from redirecting Vitest worker entry points.

## 0.1.3

### Patch Changes

- b11bae5: Require Vite+ 1.2 and preserve its built-in plugins when composing caller configuration, enabling automatic pnpm metadata normalization and Vitest cache tracking. Retain only generated-directory input exclusions for CI cache reuse.

## 0.1.2

### Patch Changes

- 4b553ad: Enable TypeScript path resolution by default in the shared app and library Vite configs. Preserve the default when merging caller resolve options, allow explicit opt-outs, and have the TanStack Start preset inherit the shared setting.

## 0.1.1

### Patch Changes

- bf65731: Migrate workspace builds and checks to Vite+ and TypeScript 7, with shared library and TanStack Start configuration packages. Preserve unbundled ESM library outputs and declarations, enable React Compiler for Start apps, and update React Table to v9.

    Clean up lint findings across packages, fix HTTP header normalization, enable automatic indexing for local collections, and migrate Devtools live queries to the current TanStack DB API. Ontology generation no longer depends on Prettier; generated files retain their existing header and can be formatted by the consuming project.

    Update the Vite React plugins and their React Compiler integration, and test React libraries and example apps against React 19.3.
