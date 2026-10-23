# Expo runtime

This runtime targets Expo SDK 57. Install `@party-stack/expo-runtime` and its Expo peer dependencies using SDK 57-compatible versions. Expo installs `expo/fetch` as the default native fetch starting in SDK 56; no separate `expo-fetch` package or fetch installer is needed. The runtime includes `expo-blob`.

Import the required polyfill first in your application entry point, before importing application code or creating clients:

```ts
import "@party-stack/expo-runtime/polyfill";
import "expo-router/entry";
```

Then use `createExpoRuntime` from `@party-stack/expo-runtime` as your installation's runtime provider.

The polyfill replaces global `Blob` with Expo Blob and global `File` with a compatible class extending Expo Blob. It leaves Expo’s installed fetch unchanged. Import it once at startup; it is a separate entry point so importing the runtime alone does not replace Blob or File. Attachment uploads use Expo’s default fetch; do not opt back into React Native fetch with `EXPO_PUBLIC_USE_RN_FETCH`.

Attachment storage requires blobs with `arrayBuffer()`, as provided by Expo Blob and Expo File. Blobs returned by other native libraries may still use React Native's older Blob implementation; convert those to compatible blobs before passing them to the runtime. Cache reads return `expo-file-system` File objects, which Expo fetch accepts as upload bodies.

## Authentication for platform secrets

```ts
import { createExpoRuntimeWithOptions } from "@party-stack/expo-runtime";

const createRuntime = createExpoRuntimeWithOptions({
    requireAuthentication: true,
    authenticationPrompt: "Unlock private data",
});
```

The default remains false. Options apply to SecureStore reads, writes and deletes;
authentication errors are propagated. iOS prompts for reading/updating protected
items, while Android requires authentication for all operations. A biometric
enrollment change can invalidate protected entries. This is a native access policy,
not a session unlock cache; keeping keys in memory for an unlocked session would be
an additional application policy. Background OAuth refresh may be unable to prompt.
Use a separate credential/key service when background credentials and interactive
vault data need different access policies. No per-property key selector is added.

This configures the existing platform SecretStore. Expo does not yet supply the
general EncryptionKeyring needed by LiveOntology's downloaded-value cache by default.
See [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).
