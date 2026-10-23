# Node runtime

`make`, `layer`, and `createNodeRuntime(owner, namespace)` acquire a scoped Effect
`Runtime` backed by SQLite, filesystem bytes, browser authentication, and the native
OS keyring. `createNodeRuntimeWithOptions({ dataDirectory })` returns the same
Effect-based provider with a configured data directory.

```ts
import * as NodeRuntime from "@party-stack/node-runtime";
import { Runtime } from "@party-stack/runtime";
import { Effect } from "effect";

const program = Effect.gen(function* () {
    const runtime = yield* Runtime;
    yield* runtime.bytes.write("example", new Blob(["hello"]));
    yield* Effect.never;
});

Effect.runFork(program.pipe(Effect.provide(NodeRuntime.layer({ owner: "user", namespace: "app" }))));
```

Defining a Layer opens nothing. Building it opens SQLite; completion, failure or
interruption closes the database. Platform runtimes have no Promise factory or
manual cleanup method. An application's outer Effect or ManagedRuntime owns them.
Installations accept these Effect-based providers directly.

Native credentials and device encryption keys use `@party-stack/effect-node-keyring`.
The native module is loaded lazily on first credential/key access. Keys stay outside
SQLite, and cached decrypted property values remain encrypted on device. The native
keyring must be available; there is no CLI, plaintext-file or volatile fallback.
No biometric/session-unlock policy is implied. See the keyring package for Linux
Secret Service requirements.
