---
"@party-stack/foundry-ontology": patch
---

Load Foundry metadata link types in batches. Loading every link type now lists object types once and fetches their outgoing link types 100 object types per request, instead of one request per object type; link types for named object types come with their batched full metadata. In an ontology with 88 object types, a full link type load went from 90 requests to 3.
