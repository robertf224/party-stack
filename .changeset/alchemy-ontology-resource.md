---
"@party-stack/durable-object-ontology-storage": minor
---

Add an OntologyDurableObject Alchemy resource factory that registers the DO class
and namespace, composes native SQL/R2 storage and authenticated Effect RPC, and
schedules bounded garbage collection through the DO alarm. Accept ordinary options
or an initialization Effect and retain the lower-level composition helper.
Simplify the Alchemy example so applications do not subclass DurableObject.
