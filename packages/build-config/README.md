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

## Effect libraries

Effect packages opt in to separate presets; the ordinary library preset is unchanged:

```ts
import { defineEffectLibraryConfig } from "@party-stack/build-config/effect";

export default defineEffectLibraryConfig();
```

```json
{
    "extends": "@party-stack/build-config/effect/tsconfig.json"
}
```

This adds Effect's recommended type-aware lint rules and language-service plugin.
The root prepare hook patches workspace TypeScript 7 and Vite+'s bundled Oxlint via
`effect-tsgo patch --oxlint`. The lockfile pins the integration version. Ordinary
libraries do not opt in to the Effect rules or TypeScript plugin.

VS Code uses the workspace TypeScript SDK, and the recommended Effect extension
provides debugger utilities. Its extension does not itself install the language
service; that comes from the repository's `@effect/tsgo` dependency and patch step.
Diagnostics are disabled in the editor plugin to avoid duplicate reports from
Vite+/Oxc; editor hovers/refactors remain available. Reload the editor's TypeScript
server after the first installation. See [Effect's development guide](https://effect.website/docs/v4/getting-started/devtools).

### Effect tests and repository guidance

Official skills are installed under `.agents/skills`. Read the installed root
`node_modules/effect/AGENTS.md` completely before writing Effect code, following
its version-matched links for errors, services, schemas, resources, and tests.
Reusable Effect functions use `Effect.fnUntraced` unless a named tracing boundary
is useful. Infrastructure errors use `Schema.TaggedError`; application records
are not required to use Schema.

The Effect preset maps `vitest` to `vite-plus/test` and inlines `@effect/vitest`,
so Effect's test helpers use Vite+'s runner instead of registering with a second
Vitest instance. Install `@effect/vitest` in packages that use it. `it.effect`
provides Effect test services; use `it.live` for integration tests that need real
time or native I/O. The ordinary library preset does not add these defaults.
Caller test aliases and inlined dependencies are merged with the Effect defaults.
