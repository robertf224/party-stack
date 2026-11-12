---
"@party-stack/connect": patch
"@party-stack/expo-runtime": patch
"@party-stack/ontology-storage": patch
"@party-stack/ontology-server": patch
---

Fix native Expo sign-in, startup responsiveness and replica action helpers.

- Connect accepts a native app's custom-scheme OAuth redirect when it exactly
  matches the trusted OAuth application registration. Provider endpoints keep
  the HTTPS/localhost policy; unsafe schemes and unregistered redirects are
  rejected. Callbacks now compare scheme, host and path explicitly, since
  `URL.origin` is `"null"` for custom schemes.
- The Expo polyfill runs React Native immediates in short time slices. React
  Native implements `setImmediate` with microtasks, so Effect fibers never
  yielded to the event loop and long ontology work starved rendering and timers.
- The Expo polyfill adds `AbortSignal.prototype.throwIfAborted` and tags React
  Native's global `Response` prototype, so Expo fetch responses interoperate with
  OAuth token handling.
- `configureNativeSha256` lets platform runtimes provide SHA-256 for bounded
  content digests; the Expo runtime uses Expo Crypto.
- Managed replica routes resolve action parameters with the replica when the
  provider backend has no resolver, matching the advertised capability.
