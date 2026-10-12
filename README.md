# party-stack

Party Stack is an application framework that turns heterogenous backends into a typed, reactive, offline-first data layer.

## Core ideas

- Backend seams for how to sync subsets of data + apply actions + upload attachments are handled through an [`OntologyBackendAdapter`](https://github.com/robertf224/party-stack/blob/main/packages/ontology/src/live/OntologyBackendAdapter.ts). Initial adapters are Foundry, Salesforce, SQLite, Durable Object, and a standard remote adapter (you can put any other adapter on the server side of the remote transport).
- Client seams for how to handle local blob storage, coordinated work, network connectivity monitoring, secret storage, data persistence, and browser authentication are handled through a [`RuntimeAdapter`](https://github.com/robertf224/party-stack/blob/main/packages/ontology/src/live/OntologyBackendAdapter.ts). Initial adapters are browser, Expo, and node.
- You define an ontology you would like to build against (e.g. see one [here](https://github.com/robertf224/party-stack/blob/main/apps/issue-tracker/src/ontology/ontology.ts) for our sample issue-tracker app), and generate types (you can also use `Infer` instead of generating types it's just slower).
- You combine a backend adapter, a runtime adapter, and an ontology definition to create a [`LiveOntology`](https://github.com/robertf224/party-stack/blob/main/packages/ontology/src/live/LiveOntology.ts). You can write [live queries](https://tanstack.com/db/latest/docs/guides/live-queries) against it, you can apply actions to it which go into an outbox which is optimistically replayed over the latest authoritative state and paused when the user needs to re-authenticate or network connectivity is missing, you can create/load attachments which get cached locally and occasionally garbage-collected based on size and recency-of-use, and much more!

## Contributing

### Getting started

Install the [Vite+ CLI](https://viteplus.dev/guide/global-cli):

```bash
curl -fsSL https://vite.plus | bash
```

Then install dependencies and check that everything works:

```bash
vp install
vp run ci
```

### Development

Run `vp install` after pulling dependency changes.

```bash
vp run -r build                              # build the repo
vp run @party-stack/issue-tracker#dev         # develop an app
vp run @party-stack/ontology#test             # test a package
```

Replace the package name to work on another app or library. For library watch
builds, run `vp pack --watch` from the package directory.

Use `vp fmt` to format code, and run `vp run ci` before opening a pull request.
See each package's README for any additional setup.
