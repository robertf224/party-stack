# Encrypted values

Rows carry opaque encrypted data, rather than IDs into a separate ciphertext table:

```ts
interface Encrypted<T> {
    readonly ciphertext: string;
    readonly source?: { objectType: string; primaryKey: string | number; property: string };
    readonly [encryptedValueType]?: T; // Type-only symbol, no runtime plaintext.
}
```

Native values contain a versioned AES-GCM envelope (key ID, nonce and authenticated
ciphertext) in that string. Foundry values carry the original `CIPHER::…::CIPHER`
string. The key lives separately in the platform key service. Encryption requires
only the key service; no Tables service, ciphertext mapping or import operation.
Copying the row copies its encrypted data. Nested encrypted wrappers are rejected,
including through named types and containers.

Loading, observing, journaling or replicating rows never decrypts them. A top-level
encrypted property loaded through LiveOntology receives its property `source`:

```ts
const ssn = await ontology.decrypt(person.ssn); // Remote; cache defaults to false.
const offlineSsn = await ontology.decrypt(person.ssn, { cache: true });
```

These Promise methods are the application boundary over scoped Effects. Results use
normal portable/core values, including Temporal and portable Result variants.
An AbortSignal can cancel decryption, and the ontology scope owns its lifetime.
The convenience method currently requires a known top-level property source.
Standalone native values can use `EncryptedValues.encrypt/decrypt(schema, value)`.

## Local copies and row GC

`cache: false` bypasses both reading and writing the downloaded-value cache. It
does not erase a copy previously cached deliberately. An authoritative local
ciphertext remains primary storage, even when decrypting without a downloaded cache.

With `cache: true`, remotely decrypted plaintext is encrypted again with the device
key. The local encrypted copy is embedded in the existing replica row's property,
alongside its original server ciphertext. Keeping the server value allows change
detection and valid upstream copies. No plaintext is persisted in this cache.

The device copy is private storage metadata, omitted from application rows,
portable schemas and replica transfers. It authenticates the original ciphertext,
authority, object/property and Runtime identity partition. Reopening can reuse it.
An unchanged ciphertext preserves it through refresh; a changed ciphertext drops it.
A transactional compare against the current base row prevents late decrypt responses
from caching against changed values or recreating evicted rows. An optimistic-only
value with no matching persisted base row is decrypted but not cached.

Row GC deletes the copy with the row. There is no additional cache table, retention
root or public eviction API. A lost key/corrupt copy falls back to an authorized
remote decrypt. `cache: true` requires a configured device EncryptionKeyring;
missing keys never cause plaintext persistence. Server revocation cannot retract a
value already downloaded for offline use.

## Response binding and Foundry assumption

A backend returns the portable JSON plaintext and, when available, the ciphertext
it decrypted:

```ts
{ value: "123-45-6789", ciphertext: encrypted.ciphertext }
```

A contradictory ciphertext produces Conflict. Without this binding the result
can be returned but is not cached. Plaintext is checked against the ontology
property schema, and failures exclude sensitive inputs/provider bodies.

Owned backends check the requested row property then decrypt its immutable envelope.
Foundry's current endpoint returns only the property's current plaintext. **Until
Foundry echoes ciphertext in its decrypt response, the adapter assumes the property
has not changed since it was loaded.** It reports the requested ciphertext under
that assumption, allowing caching. A concurrent remote change can therefore return
or cache a newer plaintext against an older ciphertext; the adapter carries an
explicit TODO for the feature request. A before/after read would not fully remove
that race.

## Keys and transports

Runtime supplies application capabilities (tables, connectivity, bytes and device
keys), above the storage/backend packages. Browser key persistence requires the
explicit `persistEncryptionKeys` opt-in. Same-origin code can use a persisted key;
non-extractability does not protect against compromised application code.

Owned backend construction accepts `encryptionKeyring`. Cloudflare uses Workers
WebCrypto, without Node filesystem/keychain APIs. `OntologyDurableObject` provisions
a stable random 256-bit key in Cloudflare Secrets Store via Alchemy unless a custom
keyring is supplied. Alchemy deployment state retains the generated secret; protect
that state and the secret resource. Deleting/replacing the key without a rotation
plan makes existing ciphertext unreadable. The DO helper imports it as a
non-extractable AES-GCM CryptoKey. The helper also accepts versioned, pre-provisioned
secrets via encryptionKeys; applications own their rollout and data migration.
There is no automatic key rotation or retirement.

Effect RPC exposes an authorized Decrypt operation. Memory tabs forward cache
policy to their persistent owner. Plaintext is returned only for that explicit
operation, never ordinary replica state. The policy HTTP transport additionally
requires a separate `canDecrypt` grant plus readable row/property and a matching
ciphertext. Reading encrypted data alone grants no decrypt permission.

Node's OS keychain and Expo SecureStore hold key material underneath the runtime keyring. Connect stores embedded token ciphertext in Tables, transactionally with connection records; there is no separate credential-store fallback.

## Writes and deferred work

Foundry v2 staged writes translate string input to `{ plaintext }` and existing
Foundry encrypted values to `{ ciphertext }`. Copying ciphertext does not decrypt
it. Optional clearing and property-change arrays follow the same path.

General native mutator auto-encryption and generated plaintext-or-encrypted write
types are still separate work. Outbox parameter encryption remains deferred; final
property encryption alone does not encrypt an ordinary action argument already
persisted in the outbox. Cache TTL, session unlock policies and separate keys for
interactive versus background use can be layered on later.

## Future user verification

No global Expo biometric runtime option is exposed. Background OAuth credentials
must remain usable without an interactive prompt. Property/operation access
policies, session unlock scopes and per-use verification are separate future work,
including enforcement before a cached read. See the
[sensitive-access design notes](../../specs/2026-10-19-effect-tables-replica/sensitive-access.md).
