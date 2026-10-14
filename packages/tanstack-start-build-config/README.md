# TanStack Start build config

Shared Vite+ tasks, TanStack Start, React Compiler, Tailwind CSS, and TanStack
Devtools plugin setup for React 19 apps.

Worktree dev is enabled by default: `vp dev` serves the app at a named local URL
derived from its unscoped package name, with a branch prefix in linked worktrees
and a stable directory hash prefix for detached HEAD. The preset installs Portless
transitively. An existing proxy is reused; otherwise an HTTP proxy starts on port
1355 (for example, `http://remote-notes.localhost:1355`).

Development also links missing `.env` and `.env.local` files from the matching app in the
primary checkout before env loading. Existing local files and symlinks are
preserved independently, and Vite keeps its normal `.env.local` precedence over
`.env`. Use `worktreeDev: { env: false }` to disable linking. Builds, previews,
tests, and task discovery do not link env files.

```ts
import { defineAppConfig } from "@party-stack/tanstack-start-build-config";

export default defineAppConfig();
```

```json
{ "extends": "@party-stack/tanstack-start-build-config/tsconfig.json" }
```

The TSConfig inherits strict app settings from `@party-stack/build-config`, which
is installed transitively. It includes `src` and `vite.config.ts`, Node/Vite types,
and the `@/*` alias to `src`. Apps still install React, React DOM, TanStack
Start/Router, Vite+, Tailwind CSS, and their React/Node type packages.

Pass normal app config overrides and additional `plugins` to the helper. Extra
plugins run before the preset plugins; `start` forwards TanStack Start options.
Import Tailwind in your app CSS with `@import "tailwindcss"`.

Override the stable app name when it should differ from the package name:

```ts
export default defineAppConfig({ worktreeDev: { name: "notes" } }); // notes.localhost, or <automatic-worktree-label>.notes.localhost
```

Use `worktreeDev: false` or `PORTLESS=0` to disable it. See the
[Worktree dev plugin](../vite-plugin-worktree-dev/README.md) for lifecycle and HTTPS details.

See the [React Compiler setup](https://react.dev/learn/react-compiler/installation)
and [Tailwind Start integration](https://tailwindcss.com/docs/installation/framework-guides/tanstack-start).
