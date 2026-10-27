# Blob follow-up work

## Remaining v0 byte streaming and transfer hardening — October 27

Byte streaming is now explicitly part of v0, to revisit after native adapter cleanup
and before the final Gateway phase. Change byte-store read/write, backend staging and
action upload sources to stream-capable interfaces. Keep application File/Blob
conveniences. Persist attachment identity in the outbox and reopen a fresh source
per attempt; never persist a live stream. Feed RPC's bounded incoming chunk queue
directly into the writer, verify completion before publishing metadata, and test
truncation, cancellation, retries and write-intent crash recovery. Provider SDKs
requiring Blob need an explicit bounded staging fallback. Durable cross-restart
offset/part resumption remains a separate future capability.

Before the final Gateway port, add explicit total/per-upload/per-principal/concurrent
byte limits, caller/target/form/revision binding, and reauthorization of chunk/final
use. Keep action requests to parameters/handles and reuse scoped RPC clients. A
small-file bounded path is a viable v0 boundary; do not describe framing as a total
memory bound while uploads accumulate a Blob.

Effect RPC provides response-stream framing, cancellation and acknowledgments. The
official HTTP/HttpApi multipart path provides streamed request file parts with parser
limits. There is no documented general client-streaming upload RPC that removes the
need for our upload protocol. HTTP multipart can be an additional transport into the
same staging service, rather than another retention/execution implementation. Keep
MessagePort/iframe operation support through the normal RPC path.

Limits/authorization are a focused hardening task. Byte streaming is a larger
cross-layer v0 change: byte-store writes and provider upload APIs currently accept
Blob. Streamed sinks, atomic publication/cancellation and transport throughput tests
must be designed together. Measure the current acknowledged 64 KiB frames
before tuning frame sizes or adding a bounded in-flight window. Durable resumability
and arbitrary large-file/range support are not implied by these v0 requirements.

Reference: [Effect v4 Multipart](https://effect.website/docs/v4/api/effect/http/Multipart).

The native SQLite/DO blob checkpoint covers shared metadata/retention, streamed
attachment RPCs and local workerd crash recovery. These follow-ups are intentionally
outside it.

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

An intermediate or owned server may stage an upload before its final action and
provide resumability even when the upstream provider cannot. Define durable upload
identity, offset/checksum validation, expiration, cancellation and crash recovery.
A scoped chunked RPC transfer is not a durable resumable upload session. Learn from
Files SDK provider integrations without delegating ontology retention/metadata to it.

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
free. The current handlers implement chunk order/size checks and scoped cancellation,
but still assemble Blob values. Track total/concurrent byte limits and streaming
sinks alongside [cache budgets](./cache-management.md).

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
