---
"@party-stack/connect": minor
---

Connection egress now runs an early access-token refresh under the same per-connection lock as renewal after a rejected request. Parallel requests that find an expiring token share one refresh instead of the later ones failing with `Conflict` ("Connection operation is in progress.").

`connectionAccessToken` is no longer exported. It returned a raw token outside that coordination. Acquire the connection through the connection manager and use its `egress` instead.
