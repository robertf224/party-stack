---
"@party-stack/foundry-ontology": patch
---

Rejected object-set subscriptions are classified by Foundry's error code:
`PERMISSION_DENIED` (for example `ApiUsageDenied`) fails as `Forbidden` and
`NOT_FOUND` as `NotFound`, both still non-retryable. The error message includes
the code, so apps can tell a permission problem apart from an unsupported object set.
