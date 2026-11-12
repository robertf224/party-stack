---
"@party-stack/foundry-ontology": patch
---

Watch failures now keep Foundry's reported reason in the error message and cause.
A rejected object-set subscription fails with a non-retryable `InvalidRequest`,
and QoS fails as retryable `RateLimited` with a two-minute `retryAfterMs`, so
replicas stop reconnecting to watches that cannot succeed.
