# Issue Tracker

A TanStack Start app for an Issue and Project Foundry ontology.

## Pull the ontology

Set the Foundry environment variables, then run:

```bash
pnpm ontology:pull
```

The pull uses `src/ontology/config.ts` and generates the ontology and TypeScript
bindings under `src/ontology`.

The example includes an explicit migration for the former reversed Issue/Project
link metadata. It accepts only the exact previous definition and updates the replica
definition marker transactionally; stored rows, cursors and pending writes are
preserved. Other definition or source changes still require an explicit migration.

## Development

```bash
vp run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Replica ownership

Application data uses one SharedWorker per origin, installation, user and ontology
partition. The worker owns IndexedDB, attachment bytes, backend watches and durable
outbox processing. Each tab has an isolated memory Replica and a scoped DbClient
view; its queries drive selected-state replication through Effect RPC.

The familiar LiveOntology API is a view over that replica. Outbox submission waits
for the persistent worker's acceptance; direct actions wait for the remote receipt.
Outbox inspection includes observed owner actions, and Tracing streams the
worker's bounded trace buffer. Attachment creation stages bytes at the owner before
an action can depend on them. The initial byte transport copies through RPC; direct
OPFS grants and range transport remain follow-up work.

Tabs dispose their scopes on pagehide. Returning from the browser's back/forward
cache reloads the application to acquire a fresh scope. Unsupported/unavailable
worker startup uses the Web Locks coordinated in-process owner. Authentication,
definition and data errors propagate instead of silently selecting a second engine.
Connection/installation metadata and credential refresh still use their existing
coordinated persistence; moving those private services wholly under the owner is
the next migration step. This example explicitly opts into browser-local key
persistence for its saved OAuth credentials.

## Browser acceptance

Start the development server, then use its printed worktree URL:

```sh
ISSUE_TRACKER_TEST_URL=https://<worktree>.issue-tracker.localhost pnpm --filter @party-stack/issue-tracker test:browser
```

The test uses the seeded SQLite demo account in an isolated Chromium context and
creates a clearly labeled test issue. It verifies two tabs, offline optimistic
edits, shared outbox inspection, initiating-tab closure, reconnect and persisted
reload, with no worker fallback. It retains the labeled issue for inspection.
This does not test an offline document/app-shell reload or every browser's private
mode. The separate web-runtime browser suite covers runtime storage and worker
primitives without an application server.
