# Streamline workaround removal matrix (OSDK-free Gateway MVP)

After consuming this Party Stack release, Streamline can remove or retain the following LiveOntology workarounds:

| Streamline code | Status | Notes |
| --- | --- | --- |
| `startBackendCollectionSync` | Removable | Remote/Foundry servers now start on-demand sync via `waitForLiveOntologyReady` / `startSyncImmediate` without issuing subset loads. |
| `createGatewayRemoteOntologyBackend` (readiness/cast hacks) | Removable | Use stock remote client/server readiness + structured errors. |
| Downstream `projectClientIr` object/property/link projection | Removable | Use remote `projectRemoteOntologyIR` with `schemaProjectionMode: "authorized"` and policy `allowedObjectTypeProperties` / visibility hooks. |
| Session-stable cleanup races | Mostly removable | Party Stack cleanup is single-flight and initialization-aware. Retain Streamline session/token lifecycle if product-specific. |
| FK-only `liveLinkAccess` helpers | Keep | Party Stack does not provide generic link traversal. Streamline continues FK-backed TanStack joins and fails closed for non-FK links. |
| OMS edit-prefill OSDK / private OMS metadata path | Keep | Public `ActionTypesFullMetadata` does not expose OMS UI prefills. Party Stack does not call private OMS Conjure endpoints or guess prefills. |
| Object-query helper / `resolveActionPrefills` fallbacks | Keep | Not provided by Party Stack. Query `LiveOntology.objects` with TanStack DB for direct object references. |
| Security policy / revision / token integration | Keep | Product-specific; not replaced by Party Stack. |

## Explicitly unsupported in this MVP

- Non-FK / object-backed / many-to-many link traversal
- OMS-specific static UI defaults and object-property / object-query / object-set prefills
- Private Foundry OMS APIs (`/ontology-metadata/api`, `bulkLoadOntologyEntities`, wire metadata)
- Generic query functions without a backend-registered implementation
- Remote `resolve-link`

## Supported MVP surface

- Primitive, struct/list, and direct object-reference action parameters
- Existing FK-backed link metadata
- Fixed action parameter values (remote policy)
- Basic object/property security policies
- Attachments and action submission
- SQLite-backed demo environments
- Public Foundry APIs when Foundry is the backend
- Generic IR `defaultValue` expressions (including generated UUID / current-time)
