# CloudKit ontology architecture gaps

This package intentionally starts with a correctness-first vertical slice. The items below should be addressed in focused follow-up spikes rather than by adding more adapter-local abstractions.

## Action execution and persistence

Current CloudKit action execution creates an isolated, in-memory action workspace. It fetches object-reference parameters directly from CloudKit, runs declarative action logic against temporary collections, and records `PlannedMutation` values for conversion to an atomic CloudKit batch. UI collections are only used for optimistic projection and post-commit catch-up.

That delegation plus recording is deliberate temporary duplication. It should not become the common backend API.

The UI and authoritative workspace evaluate declarative logic independently, as expected for speculative execution, but custom runtime mutators currently exist only in the UI write configuration and are not available to the CloudKit workspace. A shared action-runtime design still needs to define how deterministic custom mutators participate in authoritative direct-client backends.

A follow-up action-runtime spike should decide on one supported persistence boundary:

1. Have the action interpreter return a stable, typed set of evaluated object edits.
2. Expose a stable transaction-mutation projection instead of adapters inspecting TanStack `PendingMutation` internals.
3. Define a backend-neutral staged `OntologyMutatorTx` with explicit point reads and read-your-writes overlay semantics.

The chosen design must preserve:

- sequential read-your-writes inside an action;
- object-reference loading;
- custom async ontology mutators;
- one evaluation of action logic per backend execution;
- optimistic UI projection and rollback;
- atomic SQLite and CloudKit persistence;
- outbox idempotency.

`runOptimisticAction` is also named for one caller rather than what it does. Do not rename it independently of this spike; first separate action interpretation, transaction projection, and backend persistence responsibilities.

SQLite currently persists by reading TanStack `PendingMutation` shapes. That coupling belongs in the same spike so CloudKit and SQLite do not settle on different edit models.

## Query pushdown and sync mode

The default object collection now uses `syncMode: "on-demand"`. Primary-key equality and `in` subsets map directly to deterministic `fetchRecords` lookups. Unsupported predicates currently fall back to complete custom-zone history catch-up so results remain correct rather than silently incomplete.

CloudKit can push predicates to `records/query`, but a correct on-demand implementation requires more than translating a filter:

1. Add paginated `queryRecords` to the shared client contract, HTTP client, and native client.
2. Convert the supported subset of TanStack `LoadSubsetOptions` to CloudKit filters and ordering.
3. Generate `QUERYABLE` and `SORTABLE` indexes only for properties supported by that converter.
4. Define how a query-first collection establishes its zone-change cursor without replaying the entire zone.
5. Track query result membership so remote updates and deletions remove stale rows without deleting rows loaded by another active subset.
6. Deduplicate equivalent subset loads and replace full-history fallback for supported indexed predicates.

## Type mapping

Primitive properties, references, attachments, scalar lists, and geopoints have native CloudKit mappings. Geopoints map to `CLLocation` / `LOCATION`, and lists use composable scalar values rather than a separate TypeScript variant for every list type.

Maps, structs, unions, results, nested lists, and unknown values currently fall back to encoded JSON strings. A future codec spike should decide whether selected structs should flatten into CloudKit fields for querying.

## Shared databases

Locations already retain database scope, zone name, and owner record name. Full sharing still needs:

- private-zone share creation;
- invitation acceptance;
- participant permissions;
- discovery and aggregation of shared owner zones;
- mutation routing to each record’s owning database and zone.

## Browser authentication

The HTTP client accepts an injected web-auth token provider and the example captures callback tokens. A production browser flow still needs a polished Apple sign-in redirect, token renewal, logout, and expired-session recovery.

## React Native secure randomness

React Native does not provide Web Crypto’s `getRandomValues` or `randomUUID` by default, while TanStack DB and several Party Stack action/outbox/attachment paths require secure IDs.

The CloudKit Journal entry point currently imports `react-native-get-random-values` and defines an RFC 4122 v4 `randomUUID` backed by those secure bytes before loading the app. This is intentionally an application bootstrap polyfill, not CloudKit adapter behavior.

A runtime spike should decide whether `@party-stack/expo-runtime` owns an explicit secure-random service or documented bootstrap helper. Do not silently fall back to `Math.random` for action idempotency keys or attachment IDs.
