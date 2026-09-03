# Salesforce Task Manager

Consumer example for the Salesforce ontology installation and pull lifecycle.

## Generate the ontology

Configure an OAuth-enabled Salesforce External Client App as documented in
`packages/salesforce-client/README.md`, then:

```sh
cp .env.example .env
pnpm ontology:pull
pnpm ontology:generate
```

The pull command:

1. Creates a Salesforce backend installation.
2. Restores or opens a Party Stack public-OAuth connection.
3. Opens the Salesforce metadata ontology.
4. Pulls `Task` and `User` metadata.
5. Emits `src/ontology/ontology.ts`.

## Verify the runtime

```sh
pnpm runtime:smoke
```

This opens the emitted ontology through the same installation, queries the
runtime `Task` collection, and prints the number of live Salesforce records
returned.

## Run the complete POC

```sh
pnpm demo
```

The local Task Manager reads `Task` and `User` through the generated
`LiveOntology`. Its create, update, and delete operations call the generated
`createTask`, `updateTask`, and `deleteTask` actions. Salesforce
`TaskChangeEvent` notifications invalidate the runtime collection and refresh
the browser over Server-Sent Events.
