# @party-stack/ontology

Live Party Stack ontology runtime: object collections, actions, attachments,
optimistic writes/outbox handling, backend integration, and installations.

The shared ontology definitions now live in `@party-stack/ontology-spec`.
This package re-exports the existing definitions and helpers, so existing imports
from `@party-stack/ontology`, `/utils`, `/values`, and `/json` remain supported.
Storage backends and tools that only need ontology descriptions can depend on
`ontology-spec` directly without importing the live runtime.

The `ontology` CLI still supports generation and pulling metadata from live
installations. Build-time generators live under `@party-stack/ontology-spec/generate`;
IR bootstrap and meta-model generation delegate to that package. Its standalone
`ontology-spec generate --no-live` command emits model definitions without a live
factory. See [ontology-spec](../ontology-spec/README.md) for the package boundary
and generation commands.

Backend bindings acquire a scoped native service through `open(context)`;
LiveOntology composes it with Replica and storage. TanStack collections express
demand and materialize views. Action replay and persisted object inspection use
local transactional data. The old collection-based backend/outbox executor has
been removed.

See [native actions and backend construction](../../specs/2026-10-19-effect-tables-replica/native-actions.md)
for action acceptance/confirmation, retries, ambiguous-outcome recovery and
attachment receipt ordering, and [migration status](../../specs/2026-10-19-effect-tables-replica/migration-status.md)
for the remaining integration work.
