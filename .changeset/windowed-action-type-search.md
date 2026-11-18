---
"@party-stack/foundry-ontology": patch
---

Foundry metadata ActionType searches ordered by `displayName` with a limit now ask Foundry for that order and stop paging once the window is filled, then load full metadata and OMS metadata only for those rows. The cost is now proportional to the limit rather than to the ontology. The backend reports the leading window as the fulfilled subset. If Foundry's order ever disagrees with the local engine's, it falls back to the full scan. LIKE patterns containing `_` or `\` now push their literal runs down instead of disabling the prefilter.
