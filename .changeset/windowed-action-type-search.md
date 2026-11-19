---
"@party-stack/foundry-ontology": patch
---

Foundry metadata ActionType searches ordered by `displayName` with a limit now ask Foundry for that order and stop paging once the window is filled. They then load full metadata and OMS metadata only for those rows, so the cost is proportional to the limit rather than to the ontology. The backend reports the leading window as the fulfilled subset. If Foundry's order ever disagrees with the local engine's, it falls back to the full scan.

The `contains` prefilter no longer drops matches:

- Terms made only of stopwords (`at`, `in`, `to`, ...) are no longer sent to Foundry, which matched nothing for them.
- Case-insensitive `ilike` on `name` stays local, because Foundry only searches the kebab-case API name.
- Patterns containing `_` or `\` now send their literal parts instead of disabling the prefilter.
