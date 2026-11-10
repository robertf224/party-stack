# Salesforce Task Manager

Consumer example for the Salesforce ontology server and pull lifecycle.

## Generate the ontology

Configure an OAuth-enabled Salesforce External Client App as documented in
`packages/salesforce-client/README.md`, then:

```sh
cp .env.example .env
pnpm ontology:pull
pnpm ontology:generate
```

The pull command:

1. Opens a native Connect manager using the Node runtime.
2. Reuses a saved connection or starts the configured OAuth flow.
3. Opens the Salesforce metadata ontology.
4. Pulls `Task` and `User` metadata.
5. Emits `src/ontology/ontology.ts`.

## Verify the runtime

```sh
pnpm runtime:smoke
```

This opens the emitted ontology through the same Connect acquisition path, queries the
runtime `Task` collection, and prints the number of live Salesforce records
returned.

## Run the complete POC

```sh
pnpm demo
```

The TanStack Start app lives entirely in this package and opens Salesforce
through a SharedWorker running Connect and the data/metadata ontology routes.
Tabs use a memory runtime; the worker persists data in IndexedDB and attachment
bytes in OPFS. Sign-in uses OAuth PKCE in the tab. It reads
`Task` and `User` through the generated `LiveOntology`; create, update, and
delete use the generated `createTask`, `updateTask`, and `deleteTask` actions.
The metadata panel searches the live meta ontology and batch-loads complete
action definitions through the Composite API.
