# Incremental delivery — October 28, 2026

## State and responsibility

The simple model remains base + local outbox + local optimistic overlay.
Speculative sources preserve sparse inherited overrides and selected parent action
progress inside base. Owned/cached-proxy servers expose the committed facet;
only replica servers expose the additional speculative facet. Direct proxies can
forward upstream capabilities.

- `ontology-backend/delivery`: shared record/frame schemas, paged selected diff
  producer, transactionally staged receiver and delivery acknowledgments.
- `ontology-replica/incoming`: common incoming row installation and private
  decrypted-copy preservation. Controllers retain their own receipt, coverage,
  replay and GC semantics.
- `ontology-replica/parent`: scoped delivery acquisition/recovery and ordered action
  forwarding. `Accept` returns acceptance without a replacement snapshot; the
  selected stream publishes the resulting state. Finite `Read`/`Submit` remain
  available for one-shot snapshots, recovery and the independent test oracle.
- `ontology-server`: the same typed domain RPCs over HTTP or message ports.
  `SubscribeSelection` serves committed records; `SubscribeState` serves the
  speculative extension. Both use `AckDelivery`. Each RPC is independently
  authorized. Projected stateless backends do not expose raw state streams.

## Atomic installation

A new subscription begins with a snapshot. Later batches contain keyed puts and
removals. Frames carry a stream ID, sequence, previous sequence and part number.
The final frame supplies source/schema identity, selection generation, coverage,
revision/cursor and (for speculative sources) the child session watermark.

The child stages frames in storage, checks ordering and bounds, then installs the
whole batch and position in one transaction. Rebase and parent-action handoff
share that transaction. Receipt evidence is first persisted in a separate safe
transaction, so a later local alias failure cannot cause another remote submit.
Only committed batches are acknowledged. Duplicate frames/batches are checked;
gaps require a new snapshot. A conflicting reused sequence is rejected.

Selections union active demand, explicit pins, action dependencies and selected
action IDs. Membership removals are for that selected union; overlapping subsets
cannot independently remove each other's rows. Changing selection cancels the
old delivery Scope and acquires a new snapshot. A generation fence prevents late
batches from installing against a newer selection.

A replacement snapshot repairs its selected region. Unselected cached rows keep
ordinary retention/GC rules. Local-only readers retain cached state without
acquiring upstream demand; a speculative parent retains the selection locally,
while explicit remote demand is forwarded separately. Rows and inherited
components are still collected together with their coverage claims.

Committed write confirmation still uses the existing receipt-directed read-back.
Incoming committed delivery and action confirmation share the replica's sync
permit; a changed selection/generation fences an older in-flight batch. Provider
confirmation behavior and persisted-only replay are preserved.

## Bounded server state and backpressure

Comparison records and candidate changes live in tables, in the same transaction
as selection capture. Capture cannot observe later drifted row values. Scans use
storage cursors in pages of 128. Acknowledgment advances the baseline and clears
the previous generation/staged patches. There is one outstanding batch per stream
and one coalescing dirty notification, rather than an unbounded update queue.

Defaults per server namespace are 32 subscriptions, 10,000 selected records,
16 MiB selected values, 256 KiB frames, 128 records/frame, a 30-second acknowledgment
wait and a 15-second idle heartbeat. RPC server options expose a `delivery` policy.
Single records and metadata must fit the frame budget; exceeding capacity fails
explicitly. Scope cleanup releases records, patches and session metadata.
Indexed expiry cleanup on acquisition removes crashed/expired subscriptions.

Acknowledgments are stored in the same namespace, so request-scoped HTTP
handlers do not need process-local callback affinity. An in-process wake signal
reduces latency; the producer also checks the stored acknowledgment watermark.
This is reconstructible subscription state, not a durable resumable change log.
Reconnect starts a fresh snapshot. Source result/session/journal retention remains
independent of ephemeral delivery staging.

## Local collection delivery

Write transactions capture changed composed keys, including replay/rollback.
Visible revisions and bounded notifications publish after commit. A large change
or lost/coalesced notification repairs with a local snapshot. Simple unwindowed
predicates evaluate changed rows; sorted/limited windows rerun their local indexed
query. TanStack collects demand membership and writes only changed values/deletes
in a collection batch, letting its IVM update the UI.

Blob aliases/roots remain transactional, each child owns its own local bytes, and
byte streams remain independent of row-delivery framing. No second blob path or
parent-only attachment service was introduced.

## Testing and extension

Fast-check compares delivery with an independent full-snapshot model through
random edits, deletions, overlapping selections, ordering and windows. A second
property test compares speculative incremental children with the snapshot path
through generated optimistic edits, deletes, rollbacks and authoritative commits.
Failing seeds and shrunk operation sequences are reproducible.

Deterministic tests cover staged atomicity, malformed data, gaps, duplicate
frames/batches, receipt evidence surviving failed apply, slow consumer coalescing,
acknowledgments through separate handlers, cleanup, native owned delivery,
acceptance/confirmation without double replay, local-only readers and typed
error recovery. Delayed parent-session acquisition is shared by delivery and
action forwarding, with a regression for concurrent startup over an asynchronous
transport. See [error-taxonomy.md](./error-taxonomy.md).

Future Query IR/IVM replaces selection reevaluation/diff production. Atomic record
batches, position acknowledgment, backpressure and child installation remain.
Durable resumable delivery history, storage-budget-aware eviction and incremental
operator state are future work. Current window recomputation is not server IVM.

Snapshot/invalidation remains a working production fallback and test oracle.
Native HTTP/worker server options now expose deliveryStrategy: auto (default),
snapshot, or incremental. Snapshot advertises finite reads plus invalidation hints
and rejects selected streams/journal delivery. Incremental requires the selected
delivery capability; an unsupported explicit request fails the handshake. Auto
preserves the existing capability-based choice. This controls outgoing delivery,
not how a cached/intermediate server synchronizes with its own upstream. Query
maintenance/IVM configuration remains future work. See the
[strategy discussion](./query-ir-proposal.md#delivery-strategy-and-query-execution-are-separate-choices).

## Future work: resume after a transport interruption

This is a bounded protocol extension of moderate complexity, not just a client
session GC setting. The action client session/token and submission acknowledgments
already use storage. Delivery witnesses, candidate patches and acknowledgments
also use tables, but the current Scope finalizer deletes them; the producer's
installed sequence, signature and loop state still live in memory.

A resume implementation should:

- Store a reconstructible delivery head and bind its resume token to source,
  definition, authorized principal/policy revision and selection identity.
- Retain the last acknowledged baseline and at most one outstanding candidate
  batch for a configurable idle window, instead of deleting them on disconnection.
- Recover an applied-but-unacknowledged batch by resending the identical batch;
  finish acknowledgment/promotion idempotently after either process restarts.
- Once that batch is settled, reevaluate the current selection and diff it
  against the retained baseline. State replication does not require recording
  every intermediate disconnected update or keeping a continuously running query.
- Expire delivery state independently of action recovery/session state, with
  per-principal/namespace byte and subscription budgets. Expired, incompatible or
  unauthorized resumes explicitly fall back to a fresh authorized snapshot.
- Test disconnects around every staging/apply/ack boundary, server restart,
  selection changes, authorization changes and retention cleanup against snapshots.

Thus a short broken delivery connection could resume with only changed records
while retained state remains valid. A network blip that does not break the stream
requires no new acquisition today. Internet loss also need not break a tab's
local SharedWorker MessagePort. Memory tabs still start with empty rows after a
reload; their old delivery position alone cannot resume a new empty replica.

No implementation is added in this checkpoint. This remains separate from full
event/audit-history replay and from the current v0 Query IR/authorization work.
