---
"@party-stack/ontology-replica": patch
---

A pending action whose local prediction fails when the outbox rebases (for example, newer data changed what it reads) no longer blocks the outbox. Only its prediction is dropped: it stays pending, is still sent, and the source decides its outcome; later actions keep replaying. Failures reported by the source still pause the outbox as before.
