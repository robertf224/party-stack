# Changelog

## V0 — Unreleased

Party Stack now provides a shared ontology model for typed queries, optimistic
actions, offline data, attachments, authentication and authorization across
browser tabs, SharedWorkers, servers and mobile runtimes.

### Added

- Effect-native transactional storage, backend and replica packages, with memory,
  IndexedDB, SQLite/PostgreSQL and Durable Object storage implementations.
- Durable outboxes and sparse speculative overlays: local actions update visible
  state optimistically, survive restarts, and reconcile with upstream results.
- Named download families with typed inputs, retained object graphs and attachment
  bytes, queryable download status, and optimistic set/remove commands.
- Cached ontology definitions for offline startup, plus incompatible-definition
  status and configurable rebuild handling.
- Routed ontology servers with HTTP, SharedWorker and local clients. Stateful
  realtime capabilities are explicitly enabled with `enableRealtime`.
- Connect service connectors and saved OAuth/external-session connections, with
  `AuthenticationProvider`, `useAuthentication`, sign-out and forget APIs.
- Declarative object policies, action/query-function checks, scoped
  `additionalObjects`, context binding, and policy-aware errors and receipts.
- Generated collection descriptors and links, singular and paginated component
  fragments, Suspense attachment reads, and File/Blob action parameters.
- Query, outbox, storage and trace inspection, including downloads grouped by
  family with one query visualization and per-input status.
- The Notes example with rich-text editing, embedded attachments, secure notes and
  logins, keyboard/mobile navigation, and folder downloads. It replaces
  remote-notes; the unused ontology-explorer app is removed.
- Framework/backend guides, an architecture reference, and an editable client demo.

### Changed

- Replace legacy adapter factories and coordination lifecycles with scoped native
  backends, runtimes and replicas. Consolidate authenticated backend acquisition
  through Connect and update Foundry, Salesforce and Better Auth integrations.
- Expose authentication terminology in the local React/client APIs. Policies use
  `objects` for normal reads and `additionalObjects` for implementation-only grants.
- Return `{ data }` from `useFragment`; attachment URL and metadata hooks return
  their values directly and suspend during initial acquisition.
- Reduce query-readiness waits, repeated scans, cache bookkeeping and delivery
  writes. Memory tables and ordered indexes use copy-on-write data structures.
- Upgrade TanStack DB to 1.0.0-rc.1.4 and migrate the sync adapter. Two tracked
  dependency patches cover synchronous Suspense readiness/error retention and
  exact ordered windows; the setup CLI lives in `@party-stack/tanstack-db-patches`.

### Migration notes

This is a breaking migration. Upgrade related clients, servers and runtime
packages together; old and new replication protocols are not interchangeable.
Use the current [installation guide](apps/website/content/docs/installation.mdx)
and [framework/backend guides](apps/website/content/docs/index.mdx) for replacement
APIs. Install the required TanStack patches in each consuming repository; workspace
patch configuration is not inherited by published packages. See the
[patch inventory](patches/README.md) for their scope and upstream reports.

V0 does not provide general schema or queued-action migrations. Review
incompatible-definition/rebuild behavior before changing stored schemas with
pending writes. IVM, durable workflow-backed Connect actions, and finer
policy-projected watches/change feeds remain follow-up work.

Package versions and package-level changelogs are managed by Changesets. This
entry describes the V0 milestone; it does not indicate that packages are published.
