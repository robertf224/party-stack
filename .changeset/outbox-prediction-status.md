---
"@party-stack/ontology-backend": patch
"@party-stack/ontology-replica": patch
"@party-stack/ontology-server": patch
"@party-stack/ontology": patch
---

Outbox entries report whether their prediction is reflected locally. `prediction` is
`"applied"`, `"dropped"` (the last replay failed; `predictionError` says why, and the
action is still pending and sent) or `"none"` (confirmed visibility, or predicted by a
parent). Servers project the prediction error like other action errors.
