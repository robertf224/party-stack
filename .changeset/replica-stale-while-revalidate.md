---
"@party-stack/ontology-replica": minor
---

Answer covered reads without waiting for running loads, and add stale-while-revalidate.

A read whose demand is already proven by existing coverage (for example a filtered query inside a pinned whole collection) now resolves from one read transaction instead of queueing behind the replica's sync gate. A long refresh of a large collection no longer stalls every other read on the replica. This applies to backends without a change journal; journal-backed backends still pull before serving.

The new `demand.refresh.maxStaleAgeMs` option serves coverage that is no longer fresh, but younger than the bound, right away. Its `coverageProof` reports `stale: true` and `confirmedAt` while a background pass reloads it. Under this option, poll ticks and `revalidate()` mark coverage due instead of invalidating it, so a refresh that takes longer than the poll interval still installs. Coverage past the bound, invalidated coverage, and demands with a terminal load failure are never served stale. The default of 0 keeps the current behavior.
