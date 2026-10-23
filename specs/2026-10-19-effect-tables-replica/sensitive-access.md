# Future sensitive-access policies

Design notes only. No biometric runtime flag or sensitive-access API is implemented.
Expo's platform SecretStore currently imposes no additional user authentication,
so background OAuth refresh does not need to show UI. Persisted downloaded-value
caching on Expo still needs a general EncryptionKeyring implementation.

An application should be able to distinguish three policies:

| Policy     | Local behavior                                                                               | Example                              |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| Background | Platform-protected storage, no additional interactive prompt                                 | OAuth refresh credentials            |
| Session    | Verify once, unlock a scoped key/grant until explicit lock, background transition or timeout | Browsing a vault                     |
| Each use   | Fresh verification for each sensitive operation, with no reuse of the session-unlocked key   | Revealing/exporting selected secrets |

Policy selection should happen at the encrypted property or operation boundary.
For example, an application-owned resolver could map an object type/property to a
named policy; it need not add biometric concepts to portable ontology value types.
Encrypted values already carry their property source at the live boundary, and
native envelopes carry the key ID. Calls can remain `ontology.decrypt(value)`;
the service resolves and enforces the configured policy. A caller may request
stronger verification, but cannot weaken the property's minimum requirement.
Exact API shape, schema metadata and integration with future permission queries
remain undecided.

Verification must run before either a cached read or a remote request. `cache:true`
controls persistence and does not exempt a value from its access policy. Local
cache encryption should select the corresponding key domain. A background or
session-unlocked key must not also unlock values intended to require each-use
verification. A routing keyring service can compose these key providers; they do
not require three whole runtimes. Policy changes may require invalidating or
re-encrypting previously cached copies.

Session access fits an Effect resource: acquisition performs verification and
unlocks access; closing the scope drops retained keys/grants. It does not erase
plaintext already returned to application code. Per-use native enforcement needs
a suitable platform capability; a JavaScript prompt alone is not an OS-enforced
cryptographic restriction. The Node binding wrapper supplies storage, not biometric
policy. Avoid configuring one global `requireAuthentication` switch across private
credentials and foreground sensitive data.

Remote verification belongs to an authority-exposed operation/challenge mechanism.
A local prompt can enforce application UX, but cannot establish a server-verifiable
claim by itself. Server authorization may require a fresh WebAuthn assertion or
other supported step-up proof, then bind it to the principal, requested operation,
resource and expiry/reuse rules.

Foundry Checkpoints is related inspiration: it records purpose justification for
sensitive operations and includes a Cipher decrypt checkpoint type. Justification
and identity verification are distinct possible requirements. The public docs do
not establish a public programmatic checkpoint flow for our adapter, so no such
integration is claimed or implemented.

References: [Foundry Checkpoints](https://www.palantir.com/docs/foundry/checkpoints/overview/),
[checkpoint types](https://www.palantir.com/docs/foundry/checkpoints/checkpoint-types),
[Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).
