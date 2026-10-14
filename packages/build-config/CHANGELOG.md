# @party-stack/build-config

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
