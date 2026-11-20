---
"@party-stack/ontology-backend": patch
"@party-stack/ontology-replica": patch
---

Remove the unused `touchedTypes` field from pending actions. Its only reader, history recovery, requested demanded subsets that it already requests for every demand. Entries from older peers that still carry the field decode normally; the field is dropped.
