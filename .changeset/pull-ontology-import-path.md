---
"@party-stack/ontology": patch
---

`ontology pull` now writes `import { defineOntology, o } from "@party-stack/ontology"` into `src/ontology/ontology.ts` instead of importing from `@party-stack/ontology-spec`. Packages that depend only on `@party-stack/ontology` could not resolve the old import, so the pulled ontology silently typed as `any`. `writePulledOntology` now defaults its import path to `@party-stack/ontology` as well.
