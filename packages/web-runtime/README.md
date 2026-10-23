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
platform resources in its Scope. Completion, failure or interruption closes
the database, removes listeners, closes channels and releases native locks.
No separate platform `cleanup()` call is needed. The implementation also works in
workers, where `window` and `document` are unavailable.

Persistent storage uses IndexedDB and OPFS. A persistent replica acquires one native
Web Lock for its entire host Scope; another owner waits until that Scope closes or
the browser context dies. SharedWorker clients use the standard ontology protocol
and memory replicas. BroadcastChannel carries storage invalidations for local
private-state projections; it is not an RPC transport or leader-election service.
Missing Web Locks fail explicitly for persistent storage.

`storage: "memory"` selects isolated in-process storage. This is
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

`createWebRuntime(owner, namespace, options?)` returns the same scoped Effect as
`make({ owner, namespace, ...options })`. It has no Promise constructor or manual
cleanup method. Installations accept this provider directly; application entry
points can supply `layer` to an Effect program or an outer ManagedRuntime.

Browser tests cover native IndexedDB transactions/notifications, host-lock release
on tab termination, and a SharedWorker owner with per-tab memory replicas and
TanStack collections. Private browsing/storage access still requires platform testing.
