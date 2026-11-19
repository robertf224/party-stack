---
"@party-stack/connect": minor
---

Every credential renewal for a connection now goes through the connection manager's shared renewal.

- An access token that is about to expire is renewed there, like a token the service rejected. Parallel requests share one refresh instead of the later ones failing with `Conflict` ("Connection operation is in progress."). Queued requests don't refresh again when the new token is also short-lived, and they share a failed attempt.
- An expired external session is checked there too, so concurrent requests share one check and its failure.
- The public Connect policy (`connectPublicOntologyIR`, used by `connectDeviceRoute`) no longer lets clients run `refreshConnection`. Renewal belongs to the manager.
- A refresh interrupted mid-flight no longer blocks the connection. A restarted manager releases leases left by its previous process. An expired lease moves an authorization-code connection to `needs-auth`, because its refresh token may already be spent. A client-credentials connection claims it and fetches a new token, and reconnecting through `clientCredentials` clears it.
- `connectionAccessToken` is no longer exported. It returned a raw token outside that coordination. Acquire the connection through the connection manager and use its `egress` instead.
