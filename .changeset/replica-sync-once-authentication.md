---
"@party-stack/ontology-replica": patch
---

`syncOnce` fails with a non-retryable `Unauthenticated` error while the replica's
connection needs to sign in again or is signed out. Background sync still waits
for authentication silently, but an explicit checkpoint (such as pull-to-refresh)
no longer reports success after skipping the backend.
