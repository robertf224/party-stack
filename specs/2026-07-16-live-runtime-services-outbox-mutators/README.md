# Live ontology runtime, blobs, outbox, and mutators

## Status

Active design and incremental implementation.

This directory is split by subsystem. Read the focused document before making
changes in that area:

- [Runtime](./runtime.md)
- [Blob resource layer](./blobs.md)
- [Durable outbox and replayable mutators](./outbox-mutators.md)

Related work:

- [Action drafts](../2026-06-16-action-drafts/README.md)
- [Standalone coordination](../2026-07-26-coordination/README.md)

## Target layers

```text
platform-neutral runtime core
    capability types, memory blob bytes, coordinator, local collections

web and Expo runtime packages
    platform persistence, locks/channels, connectivity, bytes

resource facilities
    immutable blob storage and cache

ontology command infrastructure
    durable outbox, receipts, retry, attachment prerequisites

ontology prediction
    async declarative/custom mutators and reconciliation
```

The runtime core remains platform-neutral. `@party-stack/web-runtime` composes
the IndexedDB-only `createWebRuntime` `RuntimeAdapterProvider`, while
`@party-stack/expo-runtime` composes `createExpoRuntime` over Expo SQLite.
These providers construct platform resources plus one scoped `Coordination`.
`RuntimeAdapter.coordination` is required and owned by the runtime.
Blob storage remains a resource layer. Durable execution and prediction live under
`packages/ontology/src/live/outbox` and
`packages/ontology/src/live/mutators`.

## Implementation order

Completed vertical slices:

- Runtime Coordinator contract and implementations, channel/lock primitives,
  persistence shim, connectivity, and Effection wrappers.
- Blob resource-layer refactor with upload workflow removed.
- Structured durable ontology outbox with manual retry/edit/remove.
- Async declarative/custom mutator planning.
- Direct/outbox and confirmed/optimistic write configuration.
- Outbox TanStack Devtools panel and app demos.

Next:

1. Add server idempotency and authoritative mutation receipts.
2. Complete the cross-collection deferred-sync barrier.
3. Add durable receipt/base persistence ordering.
4. Spike invisible branch/rebase semantics and choose the long-term
   reconciliation strategy.
5. Move blob transfers into outbox prerequisite jobs.

Each pass must:

- Persist semantic commands rather than captured TanStack mutations.
- Add restart, retry, cleanup, and multi-context tests.
- Pass affected package build, lint, and test tasks.
- Update the focused subsystem document when implementation constraints change.

## Core invariants

- Durable intent is persisted before remote dispatch.
- Retried remote effects reuse one server-enforced idempotency key.
- Authoritative sync receipts determine which predictions are acknowledged.
- Prediction is derived from replayable mutator name and arguments.
- Async mutator reads use only locally available client data.
- Removing or editing an outbox entry recomputes later predictions.
- Persistence and its coordinator are authoritative for cross-context state.
- One Coordination leader serializes persistence writes and outbox commands.
- Stale outbox execution claims cannot complete newer work.
- Per-collection persistence is not presented as cross-collection atomicity.
- Blob GC cannot remove bytes referenced by drafts or outbox work.
- Cleanup is deterministic and idempotent.

## References

- TanStack mutation-log RFC:
  <https://github.com/TanStack/db/issues/1625>
- TanStack offline transactions:
  <https://github.com/TanStack/db/tree/main/packages/offline-transactions>
- Replicache mutation/rebase model:
  <https://doc.replicache.dev/concepts/how-it-works#mutations>
- Zero mutators:
  <https://zero.rocicorp.dev/docs/mutators>
