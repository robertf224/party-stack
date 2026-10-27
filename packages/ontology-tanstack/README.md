# Ontology / TanStack DB integration

Scoped collection options, local collections, replica demand translation, and
demand diagnostics. This package bridges `runtime`/`ontology-replica` into
TanStack DB; neither lower package depends on it. Connect and ontology views
can share its local collection helpers without a dependency cycle.

```ts
import { makeReplicatedCollection, makeLocalCollection } from "@party-stack/ontology-tanstack";
```

Most applications use `LiveOntology.objects` instead of constructing these
collections directly. Platform acquisition remains in `web-runtime`,
`node-runtime`, or `expo-runtime`. Collection integration tests for those
platforms live here so their production packages do not depend on the bridge.
