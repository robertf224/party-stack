# Party Stack website

TanStack Start landing page and embedded Fumadocs at `/docs`. Built with the
workspace's shared Vite+ configuration and Cloudflare's Vite plugin.

```sh
pnpm install --filter @party-stack/website
pnpm exec vp run @party-stack/website#build
pnpm exec vp run @party-stack/website#dev
```

## Deploy to Cloudflare

Sign in to the account that owns `partystack.dev`, then build and deploy:

```sh
pnpm --dir apps/website exec wrangler login
pnpm exec vp run @party-stack/website#deploy
```

The deploy task builds prerequisites and the website, then publishes the generated
Worker and static assets. `wrangler.jsonc` binds the Worker to `partystack.dev`.
Cloudflare manages the custom domain's DNS and certificate. The live client demo
runs in the visitor's browser and SharedWorker; it needs no server database.

MDX pages live in `content/docs`. The documentation separates implemented APIs
from design proposals. `src/lib/source.ts` defines the content collection;
`/api/search` serves its search index.

The site uses Fumadocs' exported precompiled stylesheet so it does not need to
upgrade the workspace Tailwind compiler to match Fumadocs' own build toolchain.
