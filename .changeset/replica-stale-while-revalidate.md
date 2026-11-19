---
"@party-stack/ontology-replica": minor
---

Keep answering reads while large collections load or refresh, and add stale-while-revalidate.

- A read whose demand existing coverage already proves (for example a filtered query inside a pinned whole collection) resolves from one read transaction instead of queueing behind running loads.
- For backends without a change journal, subset fetches now run outside the replica's sync gate. A cold read is no longer blocked by a slow refresh of another subset, and actions dispatch and confirm while a refresh is fetching. Only the short install transactions take the gate. Each fetch is numbered when it starts, and an install skips rows a later-started fetch or watch change already wrote, so overlapping loads can finish in any order. An install that would land while an action is sending, or committed but unconfirmed, is dropped and reloaded after confirmation, so a prediction is never shown twice. A load whose demand is invalidated mid-fetch still installs its rows, without proving coverage, and fetches again, at most twice, so a refresh slower than the poll interval always lands. The new `demand.maxConcurrentLoads` (default 6, matching browsers' HTTP/1.1 per-host connection limit) caps fetches in flight.
- The new `demand.refresh.maxStaleAgeMs` serves coverage that is no longer fresh, but younger than the bound, right away. Its `coverageProof` reports `stale: true` and `confirmedAt` while a background refresh replaces it. Under this option, poll ticks and `revalidate()` mark coverage due instead of invalidating it, so a refresh that takes longer than the poll interval still installs. Coverage past the bound, invalidated coverage, and demands with a terminal load failure are never served stale. The default of 0 keeps the current behavior.
- Journal-backed, delivery and protocol-source replicas keep their existing gated scheduling.
