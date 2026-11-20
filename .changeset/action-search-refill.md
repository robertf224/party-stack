---
"@party-stack/foundry-ontology": patch
---

A windowed action type search now reads full 100-row pages once a fetched row fails the local recheck of a filter Foundry can't apply (such as `not`), instead of pages sized to the rows still needed. Excluding a run of action types, like a product's own, no longer pages through them a few rows at a time.
