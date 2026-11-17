---
"@party-stack/ontology-backend": patch
---

Deliver a record larger than the frame budget alone in its own frame instead of failing the whole delivery. A large row, such as action type metadata with many parameters, previously broke delivery for its route and left readers reloading forever.
