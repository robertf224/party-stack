# @party-stack/foundry-object-set-watcher

## 0.5.2

### Patch Changes

- bf65731: Migrate workspace builds and checks to Vite+ and TypeScript 7, with shared library and TanStack Start configuration packages. Preserve unbundled ESM library outputs and declarations, enable React Compiler for Start apps, and update React Table to v9.

    Clean up lint findings across packages, fix HTTP header normalization, enable automatic indexing for local collections, and migrate Devtools live queries to the current TanStack DB API. Ontology generation no longer depends on Prettier; generated files retain their existing header and can be formatted by the consuming project.

    Update the Vite React plugins and their React Compiler integration, and test React libraries and example apps against React 19.3.

- Updated dependencies [bf65731]
    - @party-stack/foundry-client@0.3.1

## 0.5.1

### Patch Changes

- c366eb9: fix foundry user loading, null handling, and object-set-watcher crashes

## 0.5.0

### Minor Changes

- 81d84bb: Rename expression inputs to `inputReference`, promote UUID and current-time expressions to direct variants, convert Foundry list-of-struct action assignments with backend-neutral map and struct expressions, and safely apply structured property changes to sparse objects.

## 0.4.0

### Minor Changes

- 33f6858: auth + connections

### Patch Changes

- Updated dependencies [33f6858]
    - @party-stack/foundry-client@0.3.0

## 0.3.1

### Patch Changes

- dd8e2ee: fix function union types + function-backed action pulls

## 0.3.0

### Minor Changes

- 2ee9520: introduce attachments
