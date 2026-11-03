# Server and protocol review — November 3, 2026

This follows the backend contract/adapter review. Installation composition remains
part of the later SDK/installation review.

## Checklist

- [x] Inventory owned, direct proxy, cached proxy and intermediate replica construction
- [x] Inspect HTTP and MessagePort transport acquisition, cancellation and startup
- [x] Inspect Describe and optional backend capability propagation
- [x] Finish snapshot-mode demand failure supervision
- [x] Inspect authorization/projection and diagnostic/admin RPC boundaries
- [x] Inspect upload limits, ownership, error projection and cancellation
- [x] Inspect retained delivery, acknowledgment, session and bounded-state ownership
- [x] Move maintenance scheduling to the backend owner; verify DO alarm composition
- [x] Verify this checkpoint's regressions and workspace CI

## Boundaries

Backend implements data/action capabilities. Replica adds local state and sync.
Server exposes those capabilities over transports. Ontology provides the typed
SDK/TanStack facade.

Owned servers expose authoritative committed state. Direct proxies forward backend
capabilities. Cached proxies read through a replica and forward writes directly;
ordinary requests do not allocate speculative child sessions. Intermediate replica
servers additionally expose parent acceptance, pending actions and speculative state.
Policy projection wraps the final read path, including cached reads. Private state,
journals, retained delivery and administration are excluded from a projected endpoint.

## Findings and verification in progress

- Worker startup caught typed failures but left readiness unresolved after a defect.
  A native MessagePort regression reproduced the hang. Startup now releases partially
  acquired resources and returns a sanitized nonretryable Internal failure.
- The protocol adapter retried watches internally. That hid retryable failures from
  Replica supervision, which needs them to invalidate coverage and respect backoff.
  RPC regressions reproduced hidden rate-limit failures for both watch hooks. Each
  protocol watch now exposes one attempt, matching ordinary adapters.
- Describe omitted attachment/decryption capabilities and the client unconditionally
  manufactured them. Describe now reports implemented attachment access/staging and
  decryption; HTTP preserves absent and read-only attachment capabilities.
- A projected backend manufactured an empty watch for unsupported subsets, preventing
  normal polling fallback. It now preserves undefined for those subsets.
- An unknown multipart action threw in attachment-reference discovery. Its producer
  failed without resolving the response Deferred. A regression reproduced a hang;
  malformed references now fail as InvalidRequest, and all producer failure causes
  wake the request.
- Multipart failures also lost action identity before error projection, suppressing
  safe validation issues for visible parameters. Error projection now uses per-request
  action identity and a regression verifies field issues reach the client.
- Incremental speculative delivery had a parallel Demand RPC with its own reconnect
  loop. SubscribeState now acquires demand for selected subsets in its own scope,
  just like committed SubscribeSelection. Child demand changes wake selection delivery;
  they no longer open standalone Demand RPCs when incremental delivery is active.
  An RPC regression rejects every Demand call and still verifies initial loading,
  subsequent updates and demand release. Snapshot mode retains its finite-read lease.
  Client-session validation precedes upstream demand acquisition; a stale-session
  regression verifies rejection without a provider load.
  Opening the stream does not wait for refresh: that would block parent acceptance
  behind an in-flight write's confirmation gate. The existing held-write/cross-client
  regression reproduced this wait cycle during implementation. Publication now remains
  independent; the child's initial subset load waits for complete installed coverage.
  Stream.mergeEffect runs the initial refresh beside frame delivery and propagates its
  failures through the same stream; this also drives a one-shot parent without starting
  a separate permanent sync loop. Stream closure interrupts that refresh, not outbox work.

## Agreed maintenance ownership

The backend owner schedules cleanup, not the HTTP or MessagePort binding. Owned
backend acquisition starts one scoped sweep by default, with periodic scheduling
disabled when an external owner such as a DO alarm drives maintenance. Cleanup of
receipts, journal history and retained delivery remains in ontology-backend; blob
cleanup remains part of storage composition. DO alarms already call the composed
collectGarbage operation. Request handler construction adds no sweep fibers. The
constructor now requires Scope; dependent SDK/Better Auth/PostgreSQL test fixtures
bind it to their existing owner or close it at the end of the test. Fake-clock
tests verify default periodic expiry, manual scheduling and cancellation on close.
The Alchemy resource also uses ordinary owned-server composition, enabling its
automatic finite query handler instead of bypassing that composition.
Storage-backed owners schedule the composed pass (including orphan/byte cleanup),
with the lower-level journal owner's timer disabled. Both use the same private
scheduler. Fake-clock regressions verify orphan deletion after the normal grace,
retention of referenced bytes and manual scheduling; an alarm's custom GC limits
still apply to one blob pass rather than a hidden default pass plus another sweep.

## Retention and access checks

- Projected endpoints allow finite domain operations and invalidation hints; they
  deny private replica state, raw journals/delivery, diagnostics, outbox controls,
  local deletion and owner release. Attachment reads re-find the handle in an
  authorized source row/property. Shared caches are projected on their final read path.
- Delivery comparison records/patches and acknowledgment watermarks are stored in
  Tables. Source/schema/selection binding is checked on resume, and superseded
  producers cannot continue writing. Expiry requests a snapshot; it does not remove
  pending actions. Defaults cap subscriptions at 32, comparison records at 10,000,
  comparison bytes at 16 MiB and disconnected retention at 60 seconds. Limits are
  configurable. The process-local acknowledgment Map is removed on stream release;
  it accelerates an acknowledgment already persisted in Tables.
- Speculative client sessions/submission fingerprints belong to the serving replica,
  with its configurable expiry/admission bounds. Stateless requests do not create
  them. Ordinary owned backends retain keyed action receipts instead.
- MessagePort uploads have connection/principal checks, a queue of one frame,
  admission/size/deadline limits and scoped cleanup. HTTP is one streamed request
  with per-request limits; it does not have that cross-request upload registry or
  promise host-wide admission from those request limits. Platform admission is separate.
- Trace streams have bounded best-effort queues; clients retain at most 500 spans.
  They are private operations, subscribed lazily and canceled on release. Clearing
  traces clears the client's display buffer rather than another client's history.

## Snapshot supervision completion

Snapshot-mode OntologySource.demand now exposes a scoped readiness/lifetime stream.
The transport's hidden retry loop and unused retryIntervalMs constructor setting are
removed. Replica uses its existing watch supervisor for both this lease and the
shared parent change-hint stream: retry-after/backoff, terminal failures and credential
reactivation follow the same rules as adapter watches. Both error channels appear in
public status. Initial acquisition failures release partial resources; defects become
sanitized terminal Internal failures instead of leaving readiness unresolved. The first
parent change subscription has its own scope, acquired before the snapshot and released
before a retry. Watch failure alone does not prohibit independent finite reads.

Device connectivity must not gate a protocol lease: its parent can be a local worker.
An offline regression verifies cached parent data remains accessible. Fake-clock
regressions cover post-readiness rate limits, nonretryable permission failures,
cleanup before retry, cancellation, initial failure/defect cleanup and public status.
RPC tests prove post-readiness errors are exposed without transport retries.

Effect RPC currently reports HTTP EOF using RpcClientDefect, the same reason as
malformed frames. Backend normalization recognizes only upstream's two exact HTTP
empty/incomplete-response cases as retryable Unavailable, with an unknown write
outcome. Decode failures remain nonretryable InvalidResponse. Unit cases and an actual
truncated NDJSON response verify the distinction; no dependency patch was introduced.

## Nonblocking follow-ups

- Describe's watch flag remains endpoint-wide, while an adapter can decline individual
  subsets. Revisit discovery during the installations review: users, metadata and
  domain ontologies may be separate routes with separate backend capabilities.
  Route-level advertisement may resolve the current Foundry users/objects distinction;
  assess remaining subset-dependent differences before adding negotiation machinery.
  Existing provider polling recommendations cover current Foundry user loads.
- RPC byte-source acquisition peels the stream header before returning its ByteSource.
  Consumption closes that read scope, and connection teardown closes abandoned reads.
  Review a caller that repeatedly acquires sources without consuming them during the
  attachment subsystem pass: connection ownership alone is not per-read release.
  This is also recorded in blob-future-work.md, rather than left as an untracked
  server review item.
- General untrusted speculative replication, provider cursor paging, full query IVM,
  finite-query work budgets and installation partition ownership remain the previously
  recorded future work. This checkpoint introduces none of those capabilities.

## Verification

Backend: 75 tests, including generated transaction/journal oracles and fake-clock
owner/blob cleanup checks. Replica: 186 tests, including the selected-snapshot oracle
and held-write/cross-client rejection flow. Server: 82 tests, including all server
roles with snapshot/incremental HTTP delivery, MessagePort startup/cleanup, capability
round trips and multipart validation. Final workspace CI: 133/133 successful,
including real PostgreSQL, sample applications and Worker-safe DO bundles.
Those counts describe the first saved checkpoint. Completion regressions now pass
78 backend, 193 Replica and 84 server tests. Final workspace CI for the completion
checkpoint: 133/133 successful, including real PostgreSQL and Worker-safe DO bundles.
The subsystem checklist is complete;
the explicit capability/resource and broader feature follow-ups above remain.
