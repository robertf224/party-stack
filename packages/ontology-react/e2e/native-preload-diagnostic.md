# Native preload snapshot diagnostic

This manual fixture records a limitation of `DbClient.preloadLiveQuery` with live
fragment child Collections after the preload graph is garbage-collected. It is
not an application recipe or a passing regression for the desired behavior.

From `packages/ontology-react`:

```sh
node e2e/native-preload-diagnostic.mjs root
node e2e/native-preload-diagnostic.mjs nested
node e2e/native-preload-diagnostic.mjs 'root&stagger'
```

All queries explicitly use `gcTime: 1` to exercise prompt cleanup. The staggered
case lets Preferences/Notebook preload leases release while Note remains pending,
waits beyond the native GC floor, and then mounts a borrowed provider. It does not
increase retention or store rows outside TanStack's normal Collections.

The original experiment showed additional startup demand on immediate mount and a
stuck child fragment on staggered mount. It also found a separate unnecessary
Promise in borrowed-provider attachment setup; that provider issue has since been
fixed. The runner prints state and errors rather than blessing either behavior
with `test.fails`. The original desired-behavior test and logs are archived at
`/tmp/party-preload-repro` for this development session.
