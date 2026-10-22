---
"@party-stack/ontology-storage": minor
"@party-stack/ontology-replica": minor
"@party-stack/ontology-backend": minor
"@party-stack/ontology": minor
---

Consolidate native blob metadata in ontology-storage and remove the separate blobs
package and unused TanStack metadata collection. Maintain schema-derived attachment
references with object and replica transactions, distinguish identity retention
from byte pins, and collect unreferenced staged uploads/metadata after a configurable
orphan grace. Add scoped file-backed reads and atomic receipt binding with durable
recovery when local mapping conflicts.
