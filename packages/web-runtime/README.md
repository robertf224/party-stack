# @party-stack/web-runtime

The main export constructs the platform runtime as an Effect Layer:

```ts
import { Runtime } from "@party-stack/runtime";
import * as WebRuntime from "@party-stack/web-runtime";
import { Effect } from "effect";

const program = Effect.gen(function* () {
    const runtime = yield* Runtime;
    yield* runtime.bytes.write("example", new Blob(["hello"]));
    // Run the application's scoped services here.
});

await Effect.runPromise(program.pipe(Effect.provide(WebRuntime.layer({ owner: "user", namespace: "app" }))));
```

Defining the Layer opens nothing. Building it acquires storage, connectivity and
coordination resources in its Scope. Completion, failure or interruption closes
the database, removes listeners, closes channels and releases coordination.
No separate platform `cleanup()` call is needed. The implementation also works in
workers, where `window` and `document` are unavailable.

Persistent storage uses IndexedDB and OPFS; shared ownership uses Web Locks and
BroadcastChannel by default. `coordination: "single-process"` is available when
the caller already guarantees exclusive ownership. Missing shared APIs fail
explicitly rather than silently allowing multiple independent dispatchers against
one persistent namespace.

`storage: "memory"` selects isolated in-process storage and coordination. This is
an explicit fallback choice, with memory lifetime; it does not recover pending
work from an inaccessible persistent store. Worker support and storage access
must be tested separately. Private browsing may provide temporary storage with
different quotas. Browser-local encryption key persistence requires an explicit
`persistEncryptionKeys: true` choice.

```ts
WebRuntime.layer({ owner: "user", namespace: "app", persistEncryptionKeys: true });
```

This explicitly permits a non-extractable AES-GCM CryptoKey to survive reloads in
IndexedDB, in a separate key database. Same-origin code can still use the key to
decrypt; it is not a vault lock or isolation from XSS. Clearing site data loses
these keys. The flag enables persistent local credentials but does not opt ordinary
encrypted properties into caching. `ontology.decrypt(value, { cache: true })` is a
separate per-call choice; the default bypasses persistent cached plaintext copies.
Cached copies are themselves encrypted with the device key. This runtime must be
partitioned by authenticated owner/installation/ontology as usual; never reuse a
private runtime for unrelated users. See [encrypted values](../ontology/encrypted-values.md).

`createWebRuntime(owner, namespace, options?)` is an asynchronous framework boundary
that builds this same Layer. It shares its acquired Runtime with installation and
connection facades; `cleanup()` disposes that scope and `destroy()` then deletes
local storage. It does not construct a second platform implementation. Browser key
persistence is an explicit factory option too. Node/Expo platform construction and
the remaining adapter/WeakMap consumers still need migration. Browser tests cover both the existing
lock/broadcast path and a real SharedWorker owner with per-tab memory Replicas and
TanStack collections, including tab closure and reload in an isolated Chromium context.
