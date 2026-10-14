---
"@party-stack/build-config": patch
"@party-stack/tanstack-start-build-config": patch
---

Require Vite+ 1.2 and preserve its built-in plugins when composing caller configuration, enabling automatic pnpm metadata normalization and Vitest cache tracking. Retain only generated-directory input exclusions for CI cache reuse.
