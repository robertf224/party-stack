# Blob follow-up work

## Streaming checkpoint — October 27

Byte inputs carry an Effect stream internally with type, optional size and optional
name. Application attachment creation also accepts Blob/File or a ReadableStream
wrapper with those metadata fields. Unknown-size streams are counted during staging;
declared lengths are verified. Metadata is published only after successful EOF.
Reader roots live through stream consumption, and cancelled platform writes settle
before their immutable generation is abandoned for cleanup.

Every replica, including protocol children, now owns local BlobStorage. Cold remote
reads stream through while filling that cache; EOF waits for publication, and cancellation
settles partial writes. A real parent/child RPC test verifies first-byte delivery
before upstream EOF and independent byte GC. Explicit metadata requests still push
selected fields to provider metadata APIs; byte reads do not preflight metadata.

OPFS, Node and Expo write chunks to files. SQLite stores bounded 64 KiB BLOB rows
plus a completed-generation marker. R2 known-size sources use streaming put (empty
objects use an empty ArrayBuffer); unknown-size sources use 8 MiB multipart buffers.
Foundry regular attachment and temporary-media uploads use the authenticated HTTP
fetch directly because the generated SDK only accepts Blob. Incoming provider reads
stay streamed. Full-Blob conveniences and the memory fallback use an explicit
64 MiB default materialization limit rather than an unbounded array of chunks.

HTTP actions with uploads use one multipart request; standalone creation uses one
binary request. Both use the same configured Effect HttpClient as RPC and the same
server Fetch handler. A stateless proxy streams each part into native provider
execution; it has no uploadId registry and does not require local staging storage.
Owned storage writes to its final byte store. Worker/MessagePort RPC still uses a
bounded, connection/owner-bound chunk registry. It checks full upload authorization
at opening/completion, cheap ownership on each chunk, size/order, and idle/lifetime
limits. Neither transport is a durable resumable-upload protocol.

Local recording input can stream into OPFS while being produced. Eager upstream
materialization currently starts after local staging completes; overlapping local
recording and remote upload needs a separately supervised pipeline. The local API
returns an optional isMaterialized promise, while remote helpers await upload
completion before returning. Revisit those completion semantics together rather than
pretending streaming implies simultaneous forwarding through every durable replica.

Before deleting legacy HTTP, finish the Gateway parity checklist, including actual
form/revision principal binding, complete projected authorization, and consumer
integration. No production-data migration is supplied for the new development-only
SQLite byte layout. See gateway-v0-parity.md.

Reference: [Effect v4 Multipart](https://effect.website/docs/v4/api/effect/http/Multipart).

## Offline query attachment policies

When durable offline query demand exists, let applications choose whether matching
objects also download their attachments. Start with all/none, then consider size
thresholds and selective properties. Keep identity retention separate from byte
coverage, and derive pins from durable query/object demand rather than independent
application-maintained reference counts.

## Partial and range caching

Preserve immutable attachment identities. Add range reads at provider/byte-store
boundaries, including Foundry media-reference ranges, then represent local byte
coverage and demand so only missing ranges are fetched. Do not equate slicing a
fully downloaded Blob with a native range request.

## Durable resumable uploads

Deferred from this streaming pass. R2/S3 supply multipart upload sessions and parts,
but our engine would still need durable provider upload IDs, progress, integrity,
authorization, expiration, cancellation and restart recovery. R2 aborts incomplete
uploads after seven days by default; S3 needs an explicit abort/lifecycle policy.
Foundry's public temporary-media upload documents one binary request, not a resumable
session; its dataset S3 API is a separate capability. Ditto's attachment fetch APIs
were reviewed, but no public guarantee of partial-transfer resumption was verified.
Do not infer resumability merely from a binary content type or streaming interface.

An intermediate or owned server can accept resumable uploads into its own durable
storage even if the final provider needs a complete retry. Reopen the durable local
source per attempt; never persist a live stream. Files SDK provider integrations
may help without owning ontology metadata/retention.

References: [R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/),
[S3 multipart](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html),
[Foundry temporary media](https://www.palantir.com/docs/foundry/api/v2/media-sets-v2-resources/media-sets/upload-media),
[Foundry dataset S3](https://www.palantir.com/docs/foundry/data-integration/foundry-s3-api).

## Direct byte grants

Allow clients to bypass a message channel for authorized direct byte IO, such as
OPFS access or signed object-store URLs. Grants need bounded authority, completion
verification and the same metadata publication/intents as streamed uploads. Keep
this optional; the standard RPC path must remain usable for workers and iframes.

Signed reads are a possible implementation: authorize the current source row/property
before issuing a short-lived, operation/object-scoped grant. A signature prevents
tampering but does not itself prove that the caller can read the source. Bearer
grants can be shared and may remain usable after row access changes until expiry;
bind identity/revision where appropriate and keep the standard authenticated path.
Do not add signed handles merely to avoid the source-row guard.

RPC streaming does not supply staging, retention, sequencing or transfer budgets for
free. Keep transport admission separate from durable row/byte budgets; see
[cache budgets](./cache-management.md).

## Drafts and optional blob versions

Drafts remain ordinary object types with action identity/version and parameters.
Their attachment fields provide transactional retention. Draft sync/composition,
lensing old drafts/actions and configurable draft GC are separate design work.
Only add local mutable versions if a demonstrated use case (such as a signature
input) justifies them; immutable pointers are sufficient for the current migration.

## Optional provider integrations

Alchemy R2 is the initial Cloudflare byte implementation. A Files SDK BlobBytes
adapter may be useful later for additional providers. Provider IO must compose
with native metadata, retention and deletion intents rather than recreate them.
