# @bobbyfidz/apollo

## 0.3.1

### Patch Changes

- bf65731: Migrate workspace builds and checks to Vite+ and TypeScript 7, with shared library and TanStack Start configuration packages. Preserve unbundled ESM library outputs and declarations, enable React Compiler for Start apps, and update React Table to v9.

    Clean up lint findings across packages, fix HTTP header normalization, enable automatic indexing for local collections, and migrate Devtools live queries to the current TanStack DB API. Ontology generation no longer depends on Prettier; generated files retain their existing header and can be formatted by the consuming project.

    Update the Vite React plugins and their React Compiler integration, and test React libraries and example apps against React 19.3.

## 0.3.0

### Minor Changes

- 26961bb: Add Apollo Helm chart product-release manifest helpers with typed auth, GraphQL release creation, product dependencies, rollout extensions, and catalog search support.

## 0.2.2

### Patch Changes

- 9b47cc3: port packages

## 0.2.1

### Patch Changes

- efda65a: fix download

## 0.2.0

### Minor Changes

- 3687adc: add strategies and fix helm + apollo installs

### Patch Changes

- Updated dependencies [3687adc]
    - @bobbyfidz/binaries@0.4.0

## 0.1.0

### Minor Changes

- 13b1a56: Add Apollo wrapper

### Patch Changes

- Updated dependencies [13b1a56]
    - @bobbyfidz/binaries@0.3.0
