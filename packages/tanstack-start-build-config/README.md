# TanStack Start build config

Shared Vite+ tasks, TanStack Start, React Compiler, Tailwind CSS, and TanStack
Devtools plugin setup for React 19 apps.

```ts
import { defineAppConfig } from "@party-stack/tanstack-start-build-config";

export default defineAppConfig();
```

```json
{
    "extends": "@party-stack/tanstack-start-build-config/tsconfig.json"
}
```

The TSConfig inherits strict app settings from `@party-stack/build-config`, which
is installed transitively. It includes `src` and `vite.config.ts`, Node/Vite types,
and the `@/*` alias to `src`. Apps still install React, React DOM, TanStack
Start/Router, Vite+, Tailwind CSS, and their React/Node type packages.

Pass normal app config overrides and additional `plugins` to the helper. Extra
plugins run before the preset plugins; `start` forwards TanStack Start options.
Import Tailwind in your app CSS with `@import "tailwindcss"`.

See the [React Compiler setup](https://react.dev/learn/react-compiler/installation)
and [Tailwind Start integration](https://tailwindcss.com/docs/installation/framework-guides/tanstack-start).
