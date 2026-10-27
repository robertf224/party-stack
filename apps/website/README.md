# Party Stack website

TanStack Start landing page and embedded Fumadocs at `/docs`. Built with the
workspace's shared Vite+ configuration. This is a local scaffold; hosting is not
provisioned.

```sh
pnpm install --filter @party-stack/website
pnpm exec vp run @party-stack/website#build
pnpm exec vp run @party-stack/website#dev
```

MDX pages live in `content/docs`. The documentation separates implemented APIs
from design proposals. `src/lib/source.ts` defines the content collection;
`/api/search` serves its search index.

The site uses Fumadocs' exported precompiled stylesheet so it does not need to
upgrade the workspace Tailwind compiler to match Fumadocs' own build toolchain.
