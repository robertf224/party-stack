---
"@party-stack/ontology": minor
"@party-stack/ontology-react": minor
"@party-stack/ontology-server": minor
"@party-stack/ontology-replica": minor
"@party-stack/ontology-backend": minor
"@party-stack/ontology-spec": minor
"@party-stack/ontology-storage": minor
"@party-stack/indexeddb-ontology-storage": minor
"@party-stack/sql-ontology-storage": minor
"@party-stack/durable-object-ontology-storage": minor
"@party-stack/runtime": minor
"@party-stack/web-runtime": minor
"@party-stack/node-runtime": minor
"@party-stack/expo-runtime": minor
"@party-stack/connect": minor
"@party-stack/better-auth": minor
"@party-stack/foundry-ontology": minor
"@party-stack/salesforce-ontology": minor
"@party-stack/db-fragments": minor
"@party-stack/ontology-devtools": minor
"@party-stack/tanstack-db-patches": minor
---

Complete the Party Stack V0 offline-first ontology stack.

- Use scoped native backends and replicas with optimistic actions, durable outboxes,
  retained query data and attachment bytes. Open cached definitions offline and
  report incompatible updates without silently discarding queued actions.
- Serve multiple ontologies through HTTP, SharedWorker or local clients. Stateful
  realtime capabilities require explicit `enableRealtime`.
- Acquire authenticated backends from saved Connect connections. Expose local
  `AuthenticationProvider`/`useAuthentication` APIs, sign-out and forget operations,
  and Better Auth external-session integration.
- Define authorization with `objects`, action/query-function checks and scoped
  `additionalObjects`. Project errors and receipt identities at policy boundaries.
- Compose generated collection links and component-local singular/list fragments.
  `useFragment` returns `{ data }`; attachment hooks return values directly with
  Suspense. Action attachment parameters accept File/Blob inputs.
- Follow declared links in native query sources with `related(row("project"), "issues")`,
  including policies and pin graphs. Pins retain full objects and their attachment
  bytes regardless of scalar projections.
- Manage named download families through ordinary queryable pin collections and
  optimistic commands. Inspect one query per family with per-input status in devtools.
- Reduce repeated storage/query/delivery work and use copy-on-write memory indexes.

This is a breaking migration: upgrade related clients, servers and runtimes together.
TanStack DB/react-db 1.0.0-rc.1.4 require the tracked patches installed by
`@party-stack/tanstack-db-patches` in each consuming repository. See the repository
V0 implementation summary, patch inventory and current guides for migration details.
