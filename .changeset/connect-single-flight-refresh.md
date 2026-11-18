---
"@party-stack/connect": patch
---

Connection egress now runs an early access-token refresh under the same per-connection lock as renewal after a rejected request. Parallel requests that find an expiring token share one refresh instead of the later ones failing with `Conflict` ("Connection operation is in progress.").
