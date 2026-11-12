---
"@party-stack/ontology-replica": patch
---

Load snapshots for different object types concurrently within a sync pass.

A sync pass previously installed every uncovered demand one after another, so a
screen that reads several object types waited for one network round trip per
demand. Demands are now grouped by object type: groups load concurrently, while
loads within one type stay ordered so a completed superset still satisfies later
demands of that type without another fetch.
