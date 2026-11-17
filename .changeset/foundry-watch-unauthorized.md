---
"@party-stack/foundry-ontology": patch
---

A subscription Foundry rejects as `UNAUTHORIZED` (an expired access token) fails as `Unauthenticated` instead of a terminal `InvalidRequest`, so replicas renew the credential through the connection and reopen the watch rather than falling back to polling for the rest of the session.
