# Encrypted values

Rows contain portable `Encrypted<T>` handles. Loading, observing, journaling or
replicating a row never decrypts it. A top-level encrypted property loaded through
LiveOntology includes its object type, primary key and property as `source`.

```ts
const ssn = await ontology.decrypt(person.ssn);
const offlineSsn = await ontology.decrypt(person.ssn, { cache: true });
await ontology.evictDecrypted(person.ssn);
```

These Promise methods are the application boundary over scoped Effects. They
return the property's normal portable/core value, including Temporal values and
portable Result variants, rather than introducing Effect-specific domain types.
`decrypt` accepts an AbortSignal and closes with the containing ontology scope.
Handles for nested encrypted properties or standalone action parameters do not
yet have a sufficiently precise property target for this convenience API; use
the lower-level schema-driven EncryptedValues service for local values.

## Cache behavior

`cache` defaults to false. For remote values, false bypasses both reading and
writing the persistent decrypted-value cache. It does not erase a copy that an
earlier call deliberately cached; `evictDecrypted` does that. For locally owned
values, decryption reads their authoritative local ciphertext: that is primary
storage, not a downloaded plaintext cache.

With true, a successful authority response can be re-encrypted under the device
key and stored locally. Subsequent calls for the same value can work offline.
No plaintext copy is written into base rows, optimistic rows, the journal or
outbox. Only ordinary JavaScript memory holds the returned plaintext. Caching
requires an explicitly configured EncryptionKeyring; absent keys produce an
Unsupported error rather than persisting plaintext.

The existing authenticated Runtime partition supplies the user/installation/
ontology boundary. Cache entries additionally identify the authority, object,
property and immutable encrypted value. The binding is authenticated inside the
encrypted payload, so swapping mapping records cannot reveal a different secret.
There is at most one current cached copy per authority/property target. Replacing
it and deleting the old ciphertext happen in one storage transaction. Cached
copies remain until explicit eviction, replacement or partition destruction;
automatic TTL/row-eviction coupling is future work. Access revoked on the server
cannot retract a secret already downloaded for offline use.

`EncryptedValues.importCiphertext` is a different, low-level operation: it imports
an already encrypted envelope and still needs its original key, namespace and
handle. It does not implement the LiveOntology cache and was previously named
`cache`. LiveOntology always re-encrypts downloaded plaintext with the local key.

## Response identity

Backend decryption returns a portable JSON value and an optional `valueId`:

```ts
{ value: "123-45-6789", valueId: handle.id }
```

Only an authority that can prove which immutable ciphertext it decrypted may set
valueId. A mismatched ID produces Conflict. Omitting the ID permits explicit
current-property decryption, but the result is never cached, even with cache:true.
The plaintext representation is checked against the local ontology definition
without including sensitive decoder inputs in errors.

Owned storage checks that the object's property still points at the requested
handle, then decrypts that immutable local ciphertext. It can prove the ID.
Foundry's current property-decrypt endpoint returns only plaintext, without the
encrypted value/version it read or an expected-value precondition. Therefore its
adapter omits valueId. A local revision check, or reading the remote property
before and after, cannot rule out an intervening A→B→A change. Reliable Foundry
caching needs an API that binds decryption to the requested ciphertext or returns
the ciphertext identity read together with the plaintext.

## Ownership and transports

The application Runtime provides scoped platform capabilities to LiveOntology:
Tables, connectivity, bytes and optional device keys. It remains above storage
and complements Effect's platform libraries. Storage and backend implementations
do not depend on the application Runtime.

An owned storage backend receives `encryptionKeyring` explicitly. The encryption
implementation uses WebCrypto AES-GCM; deployment code chooses how keys are
stored/retrieved. Node's OS SecretStore for Connect credentials is distinct from
this authority key service. No key is silently generated for an authoritative
backend, since losing it across restart would make durable data unreadable.
Cloudflare uses Workers WebCrypto, DO SQL and R2 capabilities, not Node filesystem,
OS-keychain services or NodeRuntime.runMain. Alchemy ontology options accept the
same authority encryptionKeyring service; an application supplies it from its
chosen secret/key-management facility.

Effect RPC exposes explicitly authorized Decrypt and EvictDecrypted operations.
A memory tab forwards cache policy to its persistent owner; secret plaintext is
not included in ordinary replica state transfer. The policy HTTP transport
requires a separate canDecrypt grant plus readable row/property and matching
handle. Reading a ciphertext handle alone never grants plaintext access.

## Writes and future outbox encryption

Foundry TypeScript v2 writes accept `{ plaintext }` for encryption and
`{ ciphertext }` for copying existing ciphertext. The Party Stack staged-write
wrapper translates string writes and portable Foundry encrypted handles into
those representations. Property-change arrays and clearing optional properties
follow the same path. No decrypted value is read to copy a ciphertext.

The proposed general mutator write model is plaintext-or-encrypted-handle for an
encrypted property, while read values remain handles. Property context selects
the encryption policy automatically. Native mutator auto-encryption and generated
write types are not implemented by the decrypt API change. They must ensure
plaintext does not leak into optimistic projections, persisted replay state or
journal entries, and distinguish copying from re-encrypting for another authority.

Encrypted action parameters are a separate future boundary: protect their
persisted outbox representation with the device key, decrypt for local replay or
dispatch when the provider expects plaintext, and define forwarding/recovery when
the next authority uses different keys. Encrypting a property at final commit
alone would not protect an ordinary plaintext action argument already in the
outbox. This work remains deferred.

References: [Foundry v2 write types](https://github.com/palantir/osdk-ts/blob/6df3c1ebcd2e692ca80dc7bd648f63a007c9e72c/packages/api/src/mapping/PropertyValueMapping.ts),
[CipherText representations](https://github.com/palantir/osdk-ts/blob/6df3c1ebcd2e692ca80dc7bd648f63a007c9e72c/packages/api/src/object/CipherText.ts),
[staged-edit normalization](https://github.com/palantir/osdk-ts/blob/6df3c1ebcd2e692ca80dc7bd648f63a007c9e72c/packages/functions/src/edits/toFunctionEditValue.ts).
