# @party-stack/foundry-client

## 0.3.1

### Patch Changes

- bf65731: Migrate workspace builds and checks to Vite+ and TypeScript 7, with shared library and TanStack Start configuration packages. Preserve unbundled ESM library outputs and declarations, enable React Compiler for Start apps, and update React Table to v9.

    Clean up lint findings across packages, fix HTTP header normalization, enable automatic indexing for local collections, and migrate Devtools live queries to the current TanStack DB API. Ontology generation no longer depends on Prettier; generated files retain their existing header and can be formatted by the consuming project.

    Update the Vite React plugins and their React Compiler integration, and test React libraries and example apps against React 19.3.

## 0.3.0

### Minor Changes

- 33f6858: auth + connections
