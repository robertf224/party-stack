# @party-stack/tanstack-start-build-config

## 0.2.1

### Patch Changes

- 4b553ad: Enable TypeScript path resolution by default in the shared app and library Vite configs. Preserve the default when merging caller resolve options, allow explicit opt-outs, and have the TanStack Start preset inherit the shared setting.
- Updated dependencies [4b553ad]
    - @party-stack/build-config@0.1.2
    - @party-stack/vite-plugin-worktree-dev@0.2.0

## 0.2.0

### Minor Changes

- cbdc5f7: Add a worktree dev Vite plugin with transitive Portless installation, package-derived
  hostnames, automatic branch or stable directory-hash prefixes for linked worktrees, an optional app name override, proxy startup, HMR, and route cleanup.
  Enable named local URLs by default in the TanStack Start build config.
  Preserve the configured Vite port for direct localhost access, falling back to an
  available port when occupied while registering the actual port with Portless.
  Print the named URL as `Worktree` and the direct localhost URL as `Local`.

    Link missing, gitignored `.env` and `.env.local` files independently from the matching app in the primary
    checkout before development env loading. Preserve existing files and symlinks,
    support disabling env linking, and leave builds, previews,
    tests, and task metadata discovery untouched.

    Expose the resolved development origin for app authentication and callback URLs.
    Use it as Issue Tracker's development auth base URL so worktree logins pass origin validation.

### Patch Changes

- Updated dependencies [cbdc5f7]
    - @party-stack/vite-plugin-worktree-dev@0.2.0

## 0.1.1

### Patch Changes

- bf65731: Migrate workspace builds and checks to Vite+ and TypeScript 7, with shared library and TanStack Start configuration packages. Preserve unbundled ESM library outputs and declarations, enable React Compiler for Start apps, and update React Table to v9.

    Clean up lint findings across packages, fix HTTP header normalization, enable automatic indexing for local collections, and migrate Devtools live queries to the current TanStack DB API. Ontology generation no longer depends on Prettier; generated files retain their existing header and can be formatted by the consuming project.

    Update the Vite React plugins and their React Compiler integration, and test React libraries and example apps against React 19.3.

- Updated dependencies [bf65731]
    - @party-stack/build-config@0.1.1
