---
"@party-stack/ontology-replica": patch
---

Watch supervision backs off with jitter up to five minutes, resets after an
acquisition stays open for a minute (not only after a delivered change), records
the failure kind and message on `Replica.watchAttempt`, and reports whether each
attempt opened and delivered changes.
