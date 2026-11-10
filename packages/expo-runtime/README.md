# Expo runtime

This runtime targets Expo SDK 57. Install `@party-stack/expo-runtime` and its Expo peer dependencies using SDK 57-compatible versions. Use Expo's installed native fetch; no separate `expo-fetch` package or fetch installer is needed. The runtime includes `expo-blob`.

Import the required polyfill first in your application entry point, before importing application code or creating clients:

```ts
import "@party-stack/expo-runtime/polyfill";
import "expo-router/entry";
```

Use the lazy `expoRuntime()` layer from `@party-stack/expo-runtime` for native persistence:

```ts
import { expoRuntime } from "@party-stack/expo-runtime";

const runtime = expoRuntime(); // persistent SQLite, filesystem bytes, SecureStore keys
const uiRuntime = expoRuntime({ storage: "memory" });
```

`storage: "memory"` uses memory tables, attachment bytes, and ephemeral native encryption
keys. It retains Expo browser authentication and network connectivity without opening
SQLite, creating filesystem directories, or accessing SecureStore. This is useful for
`AuthenticationProvider` and a memory UI replica that needs Expo's platform capabilities.
Both modes acquire partitions lazily and release their NetInfo listeners with the scope.

For a durable parent plus a memory UI replica, build this layer in the application's Effect scope, provide its context while constructing the ontology server, then connect with `localClient(server)` from `@party-stack/ontology/local`. Use `expoRuntime({ storage: "memory" })` for React views that need Expo's native browser authentication without persistent UI storage. The [Expo guide](../../apps/website/content/docs/expo.mdx) shows Connect sign-in, saved Foundry accounts, ontology selection, object browsing, and background checkpoints through one shared device owner. Passing the default persistent runtime directly to `OntologyProvider` or `createLiveOntology` instead creates one persistent UI replica.

The polyfill replaces global `Blob` with Expo Blob and global `File` with a compatible class extending Expo Blob. It also supplies secure native randomness when the host lacks it and leaves Expo’s installed fetch unchanged. Import it once at startup; it is a separate entry point so importing the runtime alone does not replace Blob or File. Attachment uploads use Expo’s default fetch; do not opt back into React Native fetch with `EXPO_PUBLIC_USE_RN_FETCH`.

Attachment storage requires blobs with `arrayBuffer()`, as provided by Expo Blob and Expo File. Blobs returned by other native libraries may still use React Native's older Blob implementation; convert those to compatible blobs before passing them to the runtime. Cache reads return `expo-file-system` File objects, which Expo fetch accepts as upload bodies.

## Effect lifetime

`expoRuntime()` provides `Runtimes`, which lazily acquires each requested partition.
The lower-level `make()` requires `RuntimePartition` and `Scope`; `layer()` provides
one `Runtime` from that partition. Both accept the same optional `storage` setting; neither accepts owner/namespace arguments.
The view or managed server selects the partition and owns its scope. Completion, failure
or interruption closes persistent SQLite connections and removes NetInfo listeners. There is no runtime
Promise factory or manual runtime cleanup API; a Promise-based ontology view has
its own `cleanup()`.

## Platform secrets

The runtime uses SecureStore without an additional biometric authentication
requirement, so OAuth refresh can run without prompting. There is no global
`requireAuthentication` option. Interactive session unlock, per-use verification,
and separate policies for sensitive properties remain future work. Expo runtimes
supply an EncryptionKeyring backed by SecureStore and native expo-crypto AES-GCM for the downloaded-value row cache.

## Native configuration

Add the config plugin when using Expo prebuild/CNG:

```json
{
    "expo": {
        "plugins": ["@party-stack/expo-runtime/plugin"]
    }
}
```

The separate CommonJS entry runs in Expo's build process and does not load React
Native or the runtime. It composes the SDK's SecureStore and SQLite plugins.
SecureStore supplies Android backup exclusions for entries whose device keys
cannot be restored. SQLite's native configuration stays at SDK defaults.
No Face ID permission description is added, and an existing application-provided
description is preserved. WebBrowser's default plugin adds no configuration, so
it is not included; the experimental Android launcher activity stays disabled.
Your application still supplies its OAuth redirect scheme/URL.

If you maintain custom Android backup rules, include equivalent SecureStore
exclusions yourself, then configure:

```json
["@party-stack/expo-runtime/plugin", { "configureAndroidBackup": false }]
```

The SDK preserves existing custom backup-rule references and warns when they need
manual integration. Avoid declaring the same SDK plugins separately with competing
options; Expo runs each plugin once. Changing plugins requires a native rebuild.
