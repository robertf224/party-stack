# Effect Node keyring

`@party-stack/effect-node-keyring` wraps `@napi-rs/keyring`'s asynchronous Node
bindings with an Effect service. Passwords and binary secrets use `Redacted`.
There are no shell, file, or volatile-storage fallbacks.

```ts
import { NodeKeyring } from "@party-stack/effect-node-keyring";
import { Effect, Redacted } from "effect";

const program = Effect.gen(function* () {
    const keyring = yield* NodeKeyring;
    yield* keyring.setPassword("my-app", "account", Redacted.make("secret"));
    const password = yield* keyring.getPassword("my-app", "account");
    // Undefined means absent. Unwrap only at the consumer that needs the secret.
    if (password !== undefined) return Redacted.value(password);
}).pipe(Effect.provide(NodeKeyring.layer));
```

`make` acquires the same service without a Layer. Acquisition loads the native
binding but does not access a credential. The Promise facade in node-runtime
acquires it lazily, preserving the existing hashed service/account identifiers.
The package has no ontology or application-runtime dependencies.

The service exposes `getPassword`, `setPassword`, `getSecret`, `setSecret`, and
`deleteCredential`. Binary reads return redacted Uint8Arrays. Delete returns true
for a deleted entry and false for an absent entry; access failures remain errors.
Closing an Effect scope does not delete durable credentials.

Linux explicitly uses Secret Service (for example, GNOME Keyring or KWallet).
A reachable, unlocked provider is required; the binding's in-memory keyutils
fallback is disabled. macOS uses Keychain and Windows uses Credential Manager.
No biometric or session-unlock policy is imposed by this wrapper.

The native dependency is required. Package its platform `.node` binary with the
application, including extraction when the host cannot load native code from an
archive. Missing binaries produce KeyringError/Unavailable. Native operation
failures produce KeyringError/OperationFailed, without retaining native error
bodies or credential arguments. Redacted avoids accidental inspection/logging;
code with access to the value can still explicitly unwrap it.

Effect interruption forwards an AbortSignal to native operations. Cancellation
is best effort: it does not roll back an OS write that already completed.

Tests replace the native binding; they never read or modify the developer's OS
credential store. See the [underlying binding](https://github.com/Brooooooklyn/keyring-node).
