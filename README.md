# party-stack

Party Stack is an application framework that turns heterogenous backends into a typed, reactive, offline-first data layer.

See the [V0 changelog](CHANGELOG.md) for features, breaking changes and migration notes.

## Core ideas

- Define an ontology and generate typed models, actions, collection descriptors and links. Start with the [getting started guide](apps/website/content/docs/getting-started.mdx).
- [Backends](apps/website/content/docs/backend-adapters.mdx) provide queries, actions and attachment access. Use an owned store, a service integration such as Foundry or Salesforce, or a routed ontology server.
- Runtimes supply storage, networking, secrets and authentication presentation for browsers, Node and Expo. [Replicas](apps/website/content/docs/architecture.mdx) combine retained base state with a durable outbox and speculative overlay.
- Build a `LiveOntology` over a backend or client, then compose live queries and component fragments. Actions update local state optimistically and reconcile upstream; [downloads](apps/website/content/docs/offline.mdx) retain selected data and attachments for offline use.

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
