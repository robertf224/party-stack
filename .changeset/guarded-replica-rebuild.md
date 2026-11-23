---
"@party-stack/ontology-replica": patch
---

Allow direct replicas to opt into a transactional cache rebuild on an incompatible definition. Rebuilds preserve desired query pins, reject source changes and pending actions, and restore shared pin ownership on the next read.
