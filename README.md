# party-stack

Party Stack is an application framework that turns heterogenous backends into a typed, reactive, offline-first data layer.

## Core ideas

- Backend seams for how to sync subsets of data + apply actions + upload attachments are handled through an [`OntologyBackendAdapter`](https://github.com/robertf224/party-stack/blob/main/packages/ontology/src/live/OntologyBackendAdapter.ts).  Initial adapters are Foundry, Salesforce, SQLite, Durable Object, and a standard remote adapter (you can put any other adapter on the server side of the remote transport).
- Client seams for how to handle local blob storage, coordinated work, network connectivity monitoring, secret storage, data persistence, and browser authentication are handled through a [`RuntimeAdapter`](https://github.com/robertf224/party-stack/blob/main/packages/ontology/src/live/OntologyBackendAdapter.ts).  Initial adapters are browser, Expo, and node.
- You define an ontology you would like to build against (e.g. see one [here](https://github.com/robertf224/party-stack/blob/main/apps/issue-tracker/src/ontology/ontology.ts) for our sample issue-tracker app), and generate types (you can also use `Infer` instead of generating types it's just slower).
- You combine a backend adapter, a runtime adapter, and an ontology definition to create a [`LiveOntology`](https://github.com/robertf224/party-stack/blob/main/packages/ontology/src/live/LiveOntology.ts). You can write [live queries](https://tanstack.com/db/latest/docs/guides/live-queries) against it, you can apply actions to it which go into an outbox which is optimistically replayed over the latest authoritative state and paused when the user needs to re-authenticate or network connectivity is missing, you can create/load attachments which get cached locally and occasionally garbage-collected based on size and recency-of-use, and much more!

## Contributing

### Getting started

Make sure you have Homebrew installed:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Next make sure node is installed:

```bash
brew install nvm
nvm install 24.11.1
nvm use 24.11.1
```

Next install pnpm and turbo:

```bash
npm install -g pnpm
npm install -g turbo
```

And finally test that everything works:

```bash
pnpm install
turbo build
```

### Development

Always run `pnpm install` to install packages when starting development.

Run `turbo build` to build the repo, and `turbo watch build dev` to develop against the repo. See the [Turborepo](https://turbo.build/repo/docs/crafting-your-repository/running-tasks#using-filters) docs for syntax for filtering what projects are targeted.
