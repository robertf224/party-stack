# Build config

Shared Vite+, Vitest, and TypeScript settings for libraries and apps.

```ts
import { defineLibraryConfig } from "@party-stack/build-config";

export default defineLibraryConfig();
```

```json
{
    "extends": "@party-stack/build-config/tsconfig.json"
}
```

React and Expo libraries use `@party-stack/build-config/react/tsconfig.json` for
JSX and bundler module resolution. They use the same Vite helper.

The preset provides:

- `check`, `build`, and `test` tasks, ordered after their prerequisites.
- Unbundled ESM, declarations, and source maps in `lib` through `vp pack`.
- Vitest discovery under `src`, with package-specific test options.
- TypeScript path resolution through `resolve.tsconfigPaths` for libraries and apps.
- Strict TypeScript settings targeting ES2022, with Node and DOM types.

Apps use `defineAppConfig` from the same package. It provides check/build/test/dev
tasks, browser targets, and `.test.ts`/`.test.tsx` discovery. Supply framework
plugins and app-specific settings in the caller. Apps can extend
`@party-stack/build-config/app/tsconfig.json` for strict checks without emitting.
TanStack Start apps use `@party-stack/tanstack-start-build-config` for framework
plugins, React Compiler, Tailwind, and the app TSConfig together.

Package options override the defaults. Resolve and individual task options are merged;
arrays and task cache options replace their defaults. Lint and formatting remain
in the workspace root.

The package builds during installation. After editing it, run
`vp run @party-stack/build-config#build`. If its `lib` output is missing, bootstrap
with `pnpm exec vp -C packages/build-config pack`.
