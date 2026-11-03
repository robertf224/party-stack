# Attachments and encrypted values review

## Checklist

- [x] Trace byte IO from platform stores through native replicas, protocol clients and the SDK.
- [x] Verify cold-cache first-byte delivery, cache publication and cancellation.
- [x] Give acquired native sources a caller Scope, including unconsumed downloads.
- [x] Review transactional aliases, retention roots, write/delete intents and GC queries.
- [x] Preserve metadata-only pushdown and provider-specific upload constraints.
- [x] Review remote decryption, local encrypted copies, binding checks and error redaction.
- [x] Inspect browser, Node, Expo and Cloudflare key persistence boundaries.
- [x] Record Effect 4.1 crypto candidates in code without upgrading dependencies.

## Scoped source reads

Native `BackendAttachments.read`, `ReplicaAttachments.source` and protocol source
reads now require `Scope.Scope`. The caller keeps that Scope open through stream
consumption. Closing it interrupts acquisition, consumption and any cold-cache
write, even if the caller obtained the metadata header but never consumed bytes.
The replica/connection owner also closes its reads on shutdown. A read cannot be
consumed after its caller Scope closes; reopening requires another source read.

This fixes a resource-lifetime gap in protocol header acquisition: previously,
an unconsumed read could survive until connection teardown. It also releases a
cold-cache read's per-attachment lock and settles incomplete write intents before
a subsequent read retries. Canceling one read does not close the connection.
Foundry keeps a scoped abort controller after fetch resolves at headers, rather
than relying only on the completed acquisition Effect's cancellation signal.

The Promise SDK bridges the native scope to stream EOF/cancellation, an optional
AbortSignal, and ontology shutdown. Code that acquires a source but decides not to
consume it must abort its signal. Reconsuming a durable SDK source reopens a new
read; cancellation during that acquisition propagates to the native source.
`blob()` consumes in an internal scope. Each action submission/upload attempt
owns a scope through fingerprinting, upload and submission.

No new public dispose method, full-file buffering or metadata preflight is needed.
Metadata-only calls still select missing provider metadata fields without reading
bytes when the provider supports those fields.

## Storage, retention and GC

Every replica, including memory tabs, owns normal local blob storage. Parent
reads are remote sources, not a delegated attachment manager. Cold downloads fan
out through bounded queues to the caller and local cache; EOF waits for cache
publication. An interrupted cache fill is not published as a complete file.

Metadata, aliases and reverse retention roots share Tables transactions with
objects/outbox state. Byte writes and deletes use recoverable durable intents,
since filesystem/object-store IO cannot join those transactions. Roots are keyed
owner references, not manually incremented reference counts. Reader roots last
only through scoped consumption; object, action and explicit pin roots retain
references for their own lifetimes.

GC selects bounded candidates through storage queries. Cache byte eviction uses
age multiplied by size plus a fixed overhead, while staged/original bytes and
active byte roots are protected. Metadata orphans have a separate grace period.
Row GC and blob GC have their respective owner-scoped maintenance work; cached
bytes can be evicted independently of identity metadata and other replicas.

Attachment preparation now preserves typed nonretryable errors, such as missing
staged bytes. It previously classified all preparation failures as retryable.
Preparation failures explicitly have a not-committed action outcome and omit raw
provider/storage exception details.

## Encryption and keys

Decryption occurs at the authority. `cache: true` re-encrypts a returned value with
the device key and embeds the private copy in the same replica row property.
The cache authenticates authority, property source, partition and ciphertext;
transactional publication checks that the row and ciphertext still match. It
does not recreate an evicted row. Ordinary row eviction removes the private copy.
Default decryption does not persist plaintext.

Decrypt sources currently address top-level encrypted properties. Nested encrypted
wrappers are invalid. Foundry's current-property decryption response does not echo
the ciphertext: its adapter retains the explicitly agreed assumption/TODO pending
the provider feature request. Other providers can return that evidence directly.

Decryption now strips secret-bearing unexpected defects as well as typed provider
failures. Safe error kind/retry timing survive; causes, decoder issues and provider
messages do not. Interruptions remain interruptions.

Browser key persistence requires explicit consent and does not isolate code on
the same origin. Node uses native OS keyring bindings without CLI/file fallbacks.
Expo uses SecureStore and its native crypto key representation without an automatic
biometric prompt. Cloudflare accepts a keyring or externally provisioned versioned
secrets; the Alchemy helper can provision its initial key. Old key IDs remain
readable while a new active key is used for new writes. Rotation/re-encryption is
an operator-controlled migration, not automatic deletion of old key material.

Effect 4.1 crypto may replace compatible AES/random/key import primitives. It does
not replace OS key persistence. Its whole-array Digest API does not replace our
incremental attachment hash. Targeted comments record these boundaries; this
review keeps Effect 4.0.5.

## Validation and remaining work

Targeted package suites cover scoped acquisition/consumption, cold-cache lock and
write cleanup, unconsumed RPC cancellation, SDK abort/EOF/reopen, Foundry download
abort, metadata-only reads, typed preparation failures, and safe decrypt failures.
Existing blob tests cover alias transactions, interrupted intents, retention and
GC; encrypted cache tests cover ciphertext races and private storage encoding.
Targeted suites passed 672 tests. Full workspace `vp run ci` passed 133/133
tasks, including PostgreSQL concurrency tests and the Cloudflare Worker bundle check.

Range caches, resumable uploads, streaming browser uploads to Foundry attachments,
biometric/step-up policies, and automatic key rotation remain recorded future
work in [blob future work](./blob-future-work.md) and the security/runtime notes.
Next subsystem: Connect and installations, including route-level capability
discovery and declared-context partition ownership.
