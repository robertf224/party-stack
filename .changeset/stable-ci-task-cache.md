---
"@party-stack/build-config": patch
---

Keep task caches reusable across fresh installs by excluding pnpm installation metadata and Vitest result caches while explicitly tracking the workspace lockfile.
