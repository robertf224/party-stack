---
"@party-stack/connect": minor
---

Connection egress now renews an access token that is about to expire through the same per-connection renewal as a token the service rejected. Parallel requests that find an expiring token share one refresh instead of the later ones failing with `Conflict` ("Connection operation is in progress."). Requests queued behind it don't refresh again when the new token is also short-lived, and they share a failed attempt.

`connectionAccessToken` is no longer exported. It returned a raw token outside that coordination. Acquire the connection through the connection manager and use its `egress` instead.
