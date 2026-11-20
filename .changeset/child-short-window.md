---
"@party-stack/ontology-replica": patch
---

Child replicas (a browser tab under its SharedWorker, or any replica fed by a parent's delivery) now apply the short-window rule to delivered windows: a complete window whose local matches are fewer than its limit proves its whole filter, so follow-up reads of that filter, such as an ordered live query's boundary and continuation reads, are answered without a round trip to the parent.
