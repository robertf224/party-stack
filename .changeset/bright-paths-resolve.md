---
"@party-stack/build-config": patch
"@party-stack/tanstack-start-build-config": patch
---

Enable TypeScript path resolution by default in the shared app and library Vite configs. Preserve the default when merging caller resolve options, allow explicit opt-outs, and have the TanStack Start preset inherit the shared setting.
