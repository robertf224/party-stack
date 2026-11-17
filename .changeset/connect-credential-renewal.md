---
"@party-stack/connect": minor
"@party-stack/salesforce-ontology": patch
"@party-stack/ontology-replica": patch
---

Connect renews rejected credentials for every connector. When a request fails as
`Unauthenticated`, Connect renews the OAuth token once (shared by concurrent
rejections), sends a request without a body again, and fails a request with a body as
retryable for its caller to retry. A credential that cannot be renewed moves the
connection to `needs-auth`. Access tokens are also renewed a minute before they
expire instead of five seconds.

Breaking: `ServiceConnector.acquire` no longer receives `refreshCredential`;
connectors report a rejection as `Unauthenticated` and Connect handles it.
Salesforce's connector no longer retries on its own.

`ConnectionAccess.authentication` is now a `ConnectionLifecycle`: the connection
monitor plus `credentialVersion` and `refresh(version)`. Pass it to the replica as
before. When a source rejects an open watch as `Unauthenticated`, the replica asks it
to renew the credential and reopens the watch once the renewed credential is active.
